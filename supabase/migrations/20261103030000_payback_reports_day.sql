-- 1. Pay back on any future date and shift slot (scheduled or not). A 'payback' agreement: the worker who owes
--    (from_emp) works the other worker's (to_emp) shift. The owner sets it directly; a worker asks and the other
--    accepts. Once agreed, the owed shift is settled and the payback worker is placed on that shift (now, or when
--    the day is scheduled). It is marked on the schedule like a swap.
-- 2. Shift reports are visible only at the locations a worker is assigned to.
-- 3. Reporting days run 7:00 AM to 6:59 AM next day, in the business's local time.

alter table public.shift_adjustments drop constraint if exists shift_adjustments_kind_check;
alter table public.shift_adjustments add constraint shift_adjustments_kind_check
  check (kind in ('takeover', 'swap', 'extra', 'late_ignore', 'late_swap', 'late_payroll', 'proposal', 'future_swap', 'payback'));

create or replace function public.payback_request(p_ledger uuid, p_slot uuid, p_date date) returns uuid
language plpgsql security definer set search_path = public as $$
declare l ledger; s shift_slots; d employees; c employees; v_id uuid; v_owner boolean; v_label text;
begin
  select * into l from ledger where id = p_ledger;
  if l.id is null or l.status <> 'open' then raise exception 'That shift owed is already settled.'; end if;
  v_owner := owns_org(l.org_id);
  if not v_owner and l.debtor_id not in (select my_employee_ids()) then raise exception 'Only the worker who owes the shift (or the owner) can set the pay back.'; end if;
  select * into s from shift_slots where id = p_slot and org_id = l.org_id and active;
  if s.id is null then raise exception 'Pick a shift.'; end if;
  if p_date is null or p_date < org_today(l.org_id) then raise exception 'Pick today or a later date.'; end if;
  if exists (select 1 from shift_adjustments where kind = 'payback' and ledger_id = l.id and status in ('pending', 'accepted')) then
    raise exception 'A pay back is already set up for this.';
  end if;
  select * into d from employees where id = l.debtor_id; select * into c from employees where id = l.creditor_id;
  v_label := slot_label(p_slot, p_date);
  insert into shift_adjustments (org_id, location_id, kind, from_emp, to_emp, slot_id, work_date, label, ledger_id, note, status, created_by)
  values (l.org_id, s.location_id, 'payback', d.id, c.id, p_slot, p_date, v_label, l.id, 'Pay back for ' || l.label, 'pending', auth.uid())
  returning id into v_id;
  if v_owner then
    perform adjustment_finalize(v_id);
    perform notify_user(l.org_id, d.user_id, 'Pay back set: you work ' || c.name || '''s shift ' || v_label || ' (for ' || l.label || ').');
    perform notify_user(l.org_id, c.user_id, d.name || ' works your shift ' || v_label || ' to pay back ' || l.label || '. You have that shift off.');
  else
    perform notify_user(l.org_id, c.user_id, d.name || ' offers to pay back the shift they owe you by working ' || v_label || '. Accept or decline in SplitYourShift.');
    perform notify_user(l.org_id, (select owner_id from organizations where id = l.org_id), d.name || ' offered ' || c.name || ' a pay back on ' || v_label || '.');
  end if;
  return v_id;
end $$;
revoke execute on function public.payback_request(uuid, uuid, date) from public, anon;
grant execute on function public.payback_request(uuid, uuid, date) to authenticated;

create or replace function public.adjustment_finalize(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare a shift_adjustments; v_ledger uuid; v_worker uuid;
begin
  select * into a from shift_adjustments where id = p_id;
  if a.kind = 'swap' then
    insert into ledger (org_id, debtor_id, creditor_id, slot_id, work_date, label)
    values (a.org_id, a.to_emp, a.from_emp, a.slot_id, coalesce(a.work_date, current_date), coalesce(a.label, 'Swap')) returning id into v_ledger;
  end if;
  update shift_adjustments set status = case when kind = 'late_ignore' then 'completed' else 'accepted' end,
    decided_at = now(), completed_at = case when kind = 'late_ignore' then now() end, ledger_id = coalesce(v_ledger, ledger_id) where id = p_id;
  if a.kind in ('future_swap', 'payback') then
    v_worker := case when a.kind = 'future_swap' then a.to_emp else a.from_emp end;
    if exists (select 1 from assignments where slot_id = a.slot_id and work_date = a.work_date) then
      update assignments set employee_id = v_worker where slot_id = a.slot_id and work_date = a.work_date;
    else
      insert into assignments (org_id, location_id, slot_id, work_date, employee_id)
      select a.org_id, s.location_id, a.slot_id, a.work_date, v_worker from shift_slots s where s.id = a.slot_id;
    end if;
  end if;
  if a.kind = 'payback' and a.ledger_id is not null then
    update ledger set status = 'settled', settled_at = now() where id = a.ledger_id and status = 'open';
  end if;
end $$;
revoke execute on function public.adjustment_finalize(uuid) from public, anon, authenticated;

create or replace function public.respond_adjustment(p_id uuid, p_accept boolean) returns void
language plpgsql security definer set search_path = public as $$
declare a shift_adjustments; me employees; v_mutual boolean; v_owner uuid;
begin
  select * into a from shift_adjustments where id = p_id and to_emp in (select my_employee_ids()) for update;
  if a.id is null then raise exception 'This request isn''t for you.'; end if;
  if a.status <> 'pending' then raise exception 'This request was already answered.'; end if;
  select * into me from employees where id = a.to_emp;
  select a.kind in ('future_swap', 'payback') or coalesce((select mutual_approval from locations where id = a.location_id), true) into v_mutual;
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
         when p_accept and a.kind = 'payback' then ' You are on that shift now; the shift you owed is settled.'
         when p_accept and not v_mutual then ' Your manager confirms it next.' else '' end);
  perform notify_user(a.org_id, v_owner, me.name || case when p_accept then ' accepted ' else ' declined ' end ||
    (select name from employees where id = a.from_emp) || '''s ' || case when a.kind = 'future_swap' then 'swap' when a.kind = 'payback' then 'pay back' else replace(a.kind, '_', ' ') end ||
    ' request (' || coalesce(a.label, '') || ').' ||
    case when p_accept and a.kind in ('future_swap', 'payback') then ' The schedule is updated.'
         when p_accept and not v_mutual then ' It needs your approval in Time clock.' else '' end);
end $$;
revoke execute on function public.respond_adjustment(uuid, boolean) from public, anon;
grant execute on function public.respond_adjustment(uuid, boolean) to authenticated;

-- Placement when a day is scheduled later: accepted swap → coworker, accepted pay back → the worker paying back,
-- covered time off → the cover.
create or replace function public.apply_accepted_swap() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_to uuid;
begin
  select case when kind = 'future_swap' then to_emp else from_emp end into v_to from shift_adjustments
  where status = 'accepted' and slot_id = new.slot_id and work_date = new.work_date
    and ((kind = 'future_swap' and from_emp = new.employee_id) or (kind = 'payback' and to_emp = new.employee_id))
  order by decided_at desc limit 1;
  if v_to is not null then new.employee_id := v_to; return new; end if;
  select covered_by into v_to from time_off_requests
  where status = 'approved' and covered_by is not null and slot_id = new.slot_id and work_date = new.work_date and employee_id = new.employee_id
  order by covered_at desc limit 1;
  if v_to is not null then new.employee_id := v_to; end if;
  return new;
end $$;

-- ---------------------------------------------------------------- shift reports: by location, 7 AM reporting day

alter table public.shift_reports add column if not exists report_day date;

create or replace function public.shift_report_day() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' or new.report_day is null then
    new.report_day := ((new.created_at at time zone coalesce((select time_zone from organizations where id = new.org_id), 'America/Chicago')) - interval '7 hours')::date;
  end if;
  return new;
end $$;
drop trigger if exists shift_report_day on public.shift_reports;
create trigger shift_report_day before insert or update on public.shift_reports for each row execute function public.shift_report_day();

update public.shift_reports r set report_day = ((r.created_at at time zone o.time_zone) - interval '7 hours')::date
from public.organizations o where o.id = r.org_id and r.report_day is null;
create index if not exists shift_reports_report_day on public.shift_reports (org_id, report_day desc);

-- The reporting day "now" for a business (7:00 AM starts a new day).
create or replace function public.report_today(p_org uuid) returns date
language sql stable security definer set search_path = public as $$
  select ((now() at time zone coalesce((select time_zone from organizations where id = p_org), 'America/Chicago')) - interval '7 hours')::date
$$;
grant execute on function public.report_today(uuid) to authenticated;

-- Workers see and post reports only for locations they are assigned to; the owner sees all.
create or replace function public.my_location(p_loc uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from employee_locations el where el.location_id = p_loc and el.employee_id in (select my_employee_ids()))
$$;
grant execute on function public.my_location(uuid) to authenticated;

drop policy if exists "read" on public.shift_reports;
drop policy if exists "write own" on public.shift_reports;
create policy "read" on public.shift_reports for select using (owns_org(org_id) or is_admin() or my_location(location_id));
create policy "write own" on public.shift_reports for insert with check (
  location_id is not null and my_location(location_id) and
  exists (select 1 from employees e where e.id = employee_id and e.org_id = shift_reports.org_id and e.user_id = auth.uid()));
