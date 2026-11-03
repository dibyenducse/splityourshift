-- 1. Worker-to-worker swaps: when accepting, the coworker chooses "just cover" or "swap" (the requester works one of
--    their shifts back: a date picked now, or decided later through Shifts owed).
-- 2. Time off goes straight to the owner, for any date and shift slot, even before that week is scheduled.
--    Approving frees the shift (it shows "Needs cover"); no swap or shift credit is created.
-- 3. The owner offers the free shift to one or more workers; the first to accept is assigned, the other offers close.
--    If the day isn't scheduled yet, the cover is kept and placed when the owner schedules it.

alter table public.time_off_requests
  add column if not exists covered_by uuid references public.employees on delete set null,
  add column if not exists covered_at timestamptz;

create table public.cover_offers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations on delete cascade,
  request_id uuid not null references public.time_off_requests on delete cascade,
  employee_id uuid not null references public.employees on delete cascade,
  -- what the worker sees (they can't read other workers' time-off requests)
  label text not null,
  slot_id uuid references public.shift_slots on delete set null,
  work_date date not null,
  off_name text,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'closed')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  unique (request_id, employee_id)
);
alter table public.cover_offers enable row level security;
create policy "read" on public.cover_offers for select using (owns_org(org_id) or is_admin() or employee_id in (select my_employee_ids()));
alter publication supabase_realtime add table public.cover_offers;

-- Ask for time off for a date and shift (no schedule needed).
create or replace function public.request_time_off_slot(p_slot uuid, p_date date, p_reason text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare s shift_slots; me employees; v_id uuid; v_label text;
begin
  select * into s from shift_slots where id = p_slot and active;
  if s.id is null then raise exception 'Pick a shift.'; end if;
  if p_date is null or p_date < org_today(s.org_id) then raise exception 'Pick today or a later date.'; end if;
  select * into me from employees where org_id = s.org_id and user_id = auth.uid() limit 1;
  if me.id is null then raise exception 'You aren''t on this business''s staff list.'; end if;
  if exists (select 1 from time_off_requests where employee_id = me.id and slot_id = p_slot and work_date = p_date and status in ('pending', 'approved')) then
    raise exception 'You already asked for that shift off.';
  end if;
  v_label := slot_label(p_slot, p_date);
  insert into time_off_requests (org_id, employee_id, slot_id, work_date, label, reason)
  values (s.org_id, me.id, p_slot, p_date, v_label, nullif(trim(p_reason), '')) returning id into v_id;
  perform notify_user(s.org_id, (select owner_id from organizations where id = s.org_id),
    me.name || ' asked for ' || v_label || ' off' || coalesce(': "' || nullif(trim(p_reason), '') || '"', '') || '.', v_id);
  return v_id;
end $$;
revoke execute on function public.request_time_off_slot(uuid, date, text) from public, anon;
grant execute on function public.request_time_off_slot(uuid, date, text) to authenticated;

-- Approving takes the worker off that shift (it needs cover); denying keeps it.
create or replace function public.decide_time_off(p_id uuid, p_approve boolean) returns void
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  select * into r from time_off_requests where id = p_id for update;
  if r.id is null or not owns_org(r.org_id) then raise exception 'Request not found.'; end if;
  if r.status <> 'pending' then raise exception 'This request was already answered or cancelled.'; end if;
  update time_off_requests set status = case when p_approve then 'approved' else 'denied' end, decided_at = now() where id = p_id;
  if p_approve and r.slot_id is not null then
    delete from assignments where slot_id = r.slot_id and work_date = r.work_date and employee_id = r.employee_id;
  end if;
  update notifications set read_at = now() where request_id = p_id and read_at is null;
  perform notify_user(r.org_id, (select user_id from employees where id = r.employee_id),
    case when p_approve then 'Your time off for ' || r.label || ' was approved.'
      else 'Your time-off request for ' || r.label || ' was denied. Talk to your manager if you need to.' end);
end $$;
grant execute on function public.decide_time_off to authenticated;

-- Owner offers an approved time-off shift to workers.
create or replace function public.offer_cover(p_request uuid, p_emps uuid[]) returns int
language plpgsql security definer set search_path = public as $$
declare r time_off_requests; e employees; n int := 0;
begin
  select * into r from time_off_requests where id = p_request;
  if r.id is null or not owns_org(r.org_id) then raise exception 'Request not found.'; end if;
  if r.status <> 'approved' then raise exception 'Approve the time off first.'; end if;
  if r.covered_by is not null then raise exception '% is already covering this shift.', (select name from employees where id = r.covered_by); end if;
  for e in select * from employees where id = any(p_emps) and org_id = r.org_id and id <> r.employee_id loop
    insert into cover_offers (org_id, request_id, employee_id, label, slot_id, work_date, off_name)
    values (r.org_id, r.id, e.id, r.label, r.slot_id, r.work_date, (select name from employees where id = r.employee_id))
    on conflict (request_id, employee_id) do update set status = 'pending', created_at = now(), decided_at = null where cover_offers.status <> 'accepted';
    perform notify_user(r.org_id, e.user_id, 'Can you cover ' || r.label || '? ' || (select name from employees where id = r.employee_id) ||
      ' is off. Accept or decline in SplitYourShift; the first to accept gets the shift.');
    n := n + 1;
  end loop;
  if n = 0 then raise exception 'Pick at least one worker.'; end if;
  return n;
end $$;
revoke execute on function public.offer_cover(uuid, uuid[]) from public, anon;
grant execute on function public.offer_cover(uuid, uuid[]) to authenticated;

-- A worker answers a cover offer. The first acceptance wins; it is assigned (or kept for when the day is scheduled).
create or replace function public.answer_cover(p_offer uuid, p_accept boolean) returns void
language plpgsql security definer set search_path = public as $$
declare o cover_offers; r time_off_requests; me employees; v_owner uuid; x record;
begin
  select * into o from cover_offers where id = p_offer and employee_id in (select my_employee_ids()) for update;
  if o.id is null then raise exception 'This offer isn''t for you.'; end if;
  if o.status <> 'pending' then raise exception 'This offer is closed.'; end if;
  select * into r from time_off_requests where id = o.request_id for update;
  select * into me from employees where id = o.employee_id;
  select owner_id into v_owner from organizations where id = o.org_id;
  if not p_accept then
    update cover_offers set status = 'declined', decided_at = now() where id = o.id;
    perform notify_user(o.org_id, v_owner, me.name || ' can''t cover ' || r.label || '.');
    return;
  end if;
  if r.status <> 'approved' or r.covered_by is not null then
    update cover_offers set status = 'closed', decided_at = now() where id = o.id;
    raise exception 'Someone else is already covering this shift.';
  end if;
  update time_off_requests set covered_by = me.id, covered_at = now() where id = r.id;
  update cover_offers set status = 'accepted', decided_at = now() where id = o.id;
  if r.slot_id is not null then
    if exists (select 1 from assignments where slot_id = r.slot_id and work_date = r.work_date) then
      update assignments set employee_id = me.id where slot_id = r.slot_id and work_date = r.work_date;
    else
      insert into assignments (org_id, location_id, slot_id, work_date, employee_id)
      select r.org_id, s.location_id, r.slot_id, r.work_date, me.id from shift_slots s where s.id = r.slot_id;
    end if;
  end if;
  for x in select c.id, e.user_id from cover_offers c join employees e on e.id = c.employee_id where c.request_id = r.id and c.status = 'pending' loop
    update cover_offers set status = 'closed', decided_at = now() where id = x.id;
    perform notify_user(o.org_id, x.user_id, r.label || ' is covered now. Thanks anyway!');
  end loop;
  perform notify_user(o.org_id, v_owner, me.name || ' will cover ' || r.label || ' (' || (select name from employees where id = r.employee_id) || '''s time off).');
  perform notify_user(o.org_id, (select user_id from employees where id = r.employee_id), me.name || ' is covering your ' || r.label || '.');
end $$;
revoke execute on function public.answer_cover(uuid, boolean) from public, anon;
grant execute on function public.answer_cover(uuid, boolean) to authenticated;

-- Accepting a worker-to-worker swap: 'cover' (nothing back) or 'swap' (the requester works one of mine: a date and
-- shift picked now, or later through Shifts owed).
create or replace function public.accept_future_swap(p_id uuid, p_mode text, p_ret_slot uuid default null, p_ret_date date default null) returns void
language plpgsql security definer set search_path = public as $$
declare a shift_adjustments; rs shift_slots; v_ret uuid; v_label text; me employees; req employees;
begin
  if p_mode not in ('cover', 'swap') then raise exception 'Pick cover or swap.'; end if;
  select * into a from shift_adjustments where id = p_id and kind = 'future_swap' and to_emp in (select my_employee_ids());
  if a.id is null then raise exception 'This request isn''t for you.'; end if;
  if p_mode = 'swap' and p_ret_slot is not null then
    select * into rs from shift_slots where id = p_ret_slot and org_id = a.org_id and active;
    if rs.id is null then raise exception 'Pick the shift they work for you.'; end if;
    if p_ret_date is null or p_ret_date < org_today(a.org_id) then raise exception 'Pick today or a later date for the return shift.'; end if;
    if p_ret_slot = a.slot_id and p_ret_date = a.work_date then raise exception 'Pick a different shift for the return.'; end if;
  end if;
  perform respond_adjustment(p_id, true);   -- the coworker takes the requested shift (final)
  select * into me from employees where id = a.to_emp; select * into req from employees where id = a.from_emp;
  if p_mode = 'cover' then
    update shift_adjustments set note = concat_ws(' · ', note, 'Covered, nothing owed') where id = p_id;
  elsif p_ret_slot is not null then
    v_label := slot_label(p_ret_slot, p_ret_date);
    insert into shift_adjustments (org_id, location_id, kind, from_emp, to_emp, slot_id, work_date, label, note, status, created_by)
    values (a.org_id, rs.location_id, 'future_swap', me.id, req.id, p_ret_slot, p_ret_date, v_label, 'Return for ' || a.label, 'pending', auth.uid())
    returning id into v_ret;
    perform adjustment_finalize(v_ret);
    update shift_adjustments set note = concat_ws(' · ', note, 'Swap: ' || req.name || ' works ' || v_label) where id = p_id;
    perform notify_user(a.org_id, req.user_id, 'In return, you work ' || me.name || '''s shift ' || v_label || '. It''s on your schedule.');
  else
    insert into ledger (org_id, debtor_id, creditor_id, slot_id, work_date, label)
    values (a.org_id, req.id, me.id, a.slot_id, a.work_date, a.label);
    update shift_adjustments set note = concat_ws(' · ', note, 'Swap: return shift to be picked') where id = p_id;
    perform notify_user(a.org_id, req.user_id, 'In return you owe ' || me.name || ' one shift; it is on Shifts owed until you pick it.');
  end if;
end $$;
revoke execute on function public.accept_future_swap(uuid, text, uuid, date) from public, anon;
grant execute on function public.accept_future_swap(uuid, text, uuid, date) to authenticated;

-- Schedule placement: an accepted swap puts the coworker in, and an approved, covered time off puts the cover in,
-- whenever the original worker is scheduled on that shift (now or later).
create or replace function public.apply_accepted_swap() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_to uuid;
begin
  select to_emp into v_to from shift_adjustments
  where kind = 'future_swap' and status = 'accepted' and slot_id = new.slot_id and work_date = new.work_date and from_emp = new.employee_id
  order by decided_at desc limit 1;
  if v_to is not null then new.employee_id := v_to; return new; end if;
  select covered_by into v_to from time_off_requests
  where status = 'approved' and covered_by is not null and slot_id = new.slot_id and work_date = new.work_date and employee_id = new.employee_id
  order by covered_at desc limit 1;
  if v_to is not null then new.employee_id := v_to; end if;
  return new;
end $$;
