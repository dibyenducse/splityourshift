-- Swaps for a future date and shift slot, even before that day's schedule exists.
-- A worker (or the owner for them) asks a coworker to work a given slot on a given date. When the coworker
-- accepts it is final (no owner approval): their name goes on that shift now, and if the owner later schedules
-- the original worker there (copy last week, drag and drop...), the swapped-in worker is placed instead.

alter table public.shift_adjustments drop constraint if exists shift_adjustments_kind_check;
alter table public.shift_adjustments add constraint shift_adjustments_kind_check
  check (kind in ('takeover', 'swap', 'extra', 'late_ignore', 'late_swap', 'late_payroll', 'proposal', 'future_swap'));
create index if not exists shift_adjustments_cell on public.shift_adjustments (slot_id, work_date) where kind = 'future_swap' and status = 'accepted';

-- Ask a coworker to work a future shift. p_from: the owner names the worker who can't come; workers ask for themselves.
create or replace function public.request_future_swap(p_to uuid, p_slot uuid, p_date date, p_note text default null, p_from uuid default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare s shift_slots; f employees; t employees; v_id uuid; v_label text; v_owner uuid;
begin
  select * into s from shift_slots where id = p_slot and active;
  if s.id is null then raise exception 'Pick a shift.'; end if;
  if p_date is null or p_date < org_today(s.org_id) then raise exception 'Pick today or a later date.'; end if;
  if p_from is not null then
    if not owns_org(s.org_id) then raise exception 'Only the owner can ask on someone else''s behalf.'; end if;
    select * into f from employees where id = p_from and org_id = s.org_id;
  else
    select * into f from employees where org_id = s.org_id and user_id = auth.uid() limit 1;
  end if;
  if f.id is null then raise exception 'You aren''t on this business''s staff list.'; end if;
  select * into t from employees where id = p_to and org_id = s.org_id;
  if t.id is null then raise exception 'Pick a coworker.'; end if;
  if t.id = f.id then raise exception 'Pick someone else to work the shift.'; end if;
  if exists (select 1 from shift_adjustments where kind = 'future_swap' and slot_id = p_slot and work_date = p_date and status in ('pending', 'accepted')) then
    raise exception 'There is already a swap request for that shift.';
  end if;
  if exists (select 1 from organizations where id = s.org_id and status = 'suspended') then raise exception 'This account is suspended.'; end if;
  v_label := slot_label(p_slot, p_date);
  insert into shift_adjustments (org_id, location_id, kind, from_emp, to_emp, slot_id, work_date, label, note, status, created_by)
  values (s.org_id, s.location_id, 'future_swap', f.id, t.id, p_slot, p_date, v_label, nullif(trim(p_note), ''), 'pending', auth.uid())
  returning id into v_id;
  select owner_id into v_owner from organizations where id = s.org_id;
  perform notify_user(s.org_id, t.user_id, case when p_from is not null then 'Your manager asks you' else f.name || ' asks you' end ||
    ' to work ' || f.name || '''s shift ' || v_label || coalesce(' (' || nullif(trim(p_note), '') || ')', '') || '. Accept or decline in SplitYourShift.');
  if v_owner is distinct from auth.uid() then
    perform notify_user(s.org_id, v_owner, f.name || ' asked ' || t.name || ' to work ' || v_label || ' (swap request).');
  end if;
  return v_id;
end $$;
revoke execute on function public.request_future_swap(uuid, uuid, date, text, uuid) from public, anon;
grant execute on function public.request_future_swap(uuid, uuid, date, text, uuid) to authenticated;

-- Accepted swaps take effect on the schedule (whether or not that day was scheduled yet).
create or replace function public.adjustment_finalize(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare a shift_adjustments; v_ledger uuid;
begin
  select * into a from shift_adjustments where id = p_id;
  if a.kind = 'swap' then
    insert into ledger (org_id, debtor_id, creditor_id, slot_id, work_date, label)
    values (a.org_id, a.to_emp, a.from_emp, a.slot_id, coalesce(a.work_date, current_date), coalesce(a.label, 'Swap')) returning id into v_ledger;
  end if;
  update shift_adjustments set status = case when kind = 'late_ignore' then 'completed' else 'accepted' end,
    decided_at = now(), completed_at = case when kind = 'late_ignore' then now() end, ledger_id = v_ledger where id = p_id;
  if a.kind = 'future_swap' then
    if exists (select 1 from assignments where slot_id = a.slot_id and work_date = a.work_date) then
      update assignments set employee_id = a.to_emp where slot_id = a.slot_id and work_date = a.work_date;
    else
      insert into assignments (org_id, location_id, slot_id, work_date, employee_id)
      select a.org_id, s.location_id, a.slot_id, a.work_date, a.to_emp from shift_slots s where s.id = a.slot_id;
    end if;
  end if;
end $$;
revoke execute on function public.adjustment_finalize(uuid) from public, anon, authenticated;

-- Swaps the coworker agreed to are final for future-shift swaps (mutual approval setting aside).
create or replace function public.respond_adjustment(p_id uuid, p_accept boolean) returns void
language plpgsql security definer set search_path = public as $$
declare a shift_adjustments; me employees; v_mutual boolean; v_owner uuid;
begin
  select * into a from shift_adjustments where id = p_id and to_emp in (select my_employee_ids()) for update;
  if a.id is null then raise exception 'This request isn''t for you.'; end if;
  if a.status <> 'pending' then raise exception 'This request was already answered.'; end if;
  select * into me from employees where id = a.to_emp;
  select a.kind = 'future_swap' or coalesce((select mutual_approval from locations where id = a.location_id), true) into v_mutual;
  select owner_id into v_owner from organizations where id = a.org_id;
  if not p_accept then
    update shift_adjustments set status = 'declined', decided_at = now() where id = p_id;
  elsif v_mutual then
    perform adjustment_finalize(p_id);
  else
    update shift_adjustments set status = 'awaiting_owner' where id = p_id;
  end if;
  perform notify_user(a.org_id, (select user_id from employees where id = a.from_emp),
    me.name || case when p_accept then ' accepted' else ' declined' end || ' your request for ' || coalesce(a.label, 'the shift') || '.' ||
    case when p_accept and a.kind = 'future_swap' then ' ' || me.name || ' is on that shift now.'
         when p_accept and not v_mutual then ' Your manager confirms it next.' else '' end);
  perform notify_user(a.org_id, v_owner, me.name || case when p_accept then ' accepted ' else ' declined ' end ||
    (select name from employees where id = a.from_emp) || '''s ' || case when a.kind = 'future_swap' then 'swap' else replace(a.kind, '_', ' ') end ||
    ' request (' || coalesce(a.label, '') || ').' ||
    case when p_accept and a.kind = 'future_swap' then ' The schedule shows ' || me.name || ' on that shift.'
         when p_accept and not v_mutual then ' It needs your approval in Time clock.' else '' end);
end $$;
revoke execute on function public.respond_adjustment(uuid, boolean) from public, anon;
grant execute on function public.respond_adjustment(uuid, boolean) to authenticated;

-- When the original worker is put on a shift they swapped away, place the coworker who accepted instead.
create or replace function public.apply_accepted_swap() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_to uuid;
begin
  select to_emp into v_to from shift_adjustments
  where kind = 'future_swap' and status = 'accepted' and slot_id = new.slot_id and work_date = new.work_date and from_emp = new.employee_id
  order by decided_at desc limit 1;
  if v_to is not null then new.employee_id := v_to; end if;
  return new;
end $$;
drop trigger if exists apply_accepted_swap on public.assignments;
create trigger apply_accepted_swap before insert or update of employee_id on public.assignments
  for each row execute function public.apply_accepted_swap();

-- The owner can also cancel an accepted future swap (the schedule then stays as the owner sets it).
create or replace function public.update_adjustment(p_id uuid, p_action text) returns void
language plpgsql security definer set search_path = public as $$
declare a shift_adjustments; v_owner boolean;
begin
  select * into a from shift_adjustments where id = p_id for update;
  if a.id is null then raise exception 'Not found.'; end if;
  v_owner := owns_org(a.org_id);
  if p_action = 'approve' and v_owner and a.status in ('awaiting_owner', 'pending') then
    perform adjustment_finalize(p_id);
  elsif p_action = 'decline' and v_owner and a.status in ('awaiting_owner', 'pending') then
    update shift_adjustments set status = 'declined', decided_at = now() where id = p_id;
  elsif p_action = 'complete' and a.status = 'accepted'
        and (v_owner or a.from_emp in (select my_employee_ids()) or a.to_emp in (select my_employee_ids())) then
    update shift_adjustments set status = 'completed', completed_at = now() where id = p_id;
  elsif p_action = 'cancel' and ((a.status in ('pending', 'awaiting_owner') and (v_owner or a.from_emp in (select my_employee_ids())))
                                 or (a.status = 'accepted' and a.kind = 'future_swap' and v_owner)) then
    update shift_adjustments set status = 'cancelled', decided_at = now() where id = p_id;
  else
    raise exception 'You can''t do that with this request.';
  end if;
  if p_action in ('approve', 'decline') then
    perform notify_user(a.org_id, (select user_id from employees where id = a.from_emp), 'Your manager ' || p_action || 'd the ' || replace(a.kind, '_', ' ') || ' for ' || coalesce(a.label, 'your shift') || '.');
    perform notify_user(a.org_id, (select user_id from employees where id = a.to_emp), 'Your manager ' || p_action || 'd the ' || replace(a.kind, '_', ' ') || ' for ' || coalesce(a.label, 'the shift') || '.');
  end if;
end $$;
revoke execute on function public.update_adjustment(uuid, text) from public, anon;
grant execute on function public.update_adjustment(uuid, text) to authenticated;
