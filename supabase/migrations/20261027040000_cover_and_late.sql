-- Emergency cover (clock in on someone else's shift) and late clock-in with a claimed start time.

-- When a worker clocks in late but says they started on time, the claimed start waits here for the owner.
-- Pay uses clock_in until the owner approves the claim.
alter table public.time_entries add column if not exists claimed_in timestamptz;

drop function if exists public.clock_in(uuid, date);

-- p_from_scheduled: the worker says they started at the scheduled time (needs owner approval).
create or replace function public.clock_in(p_slot uuid, p_date date, p_from_scheduled boolean default false) returns public.time_entries
language plpgsql security definer set search_path = public as $$
declare a record; st timestamptz; en timestamptz; r time_entries; v_claim timestamptz;
begin
  select asg.*, s.hours, e.name as emp_name into a from assignments asg
  join shift_slots s on s.id = asg.slot_id join employees e on e.id = asg.employee_id
  where asg.slot_id = p_slot and asg.work_date = p_date and asg.employee_id in (select my_employee_ids());
  if a.id is null then raise exception 'This shift isn''t on your schedule. To cover someone, use "Clock in for another shift".'; end if;
  if exists (select 1 from time_entries where employee_id = a.employee_id and clock_out is null) then
    raise exception 'You are already clocked in. Clock out first.';
  end if;
  if exists (select 1 from time_entries where employee_id = a.employee_id and slot_id = p_slot and work_date = p_date) then
    raise exception 'You already clocked in for this shift. If the times are wrong, use "Fix my hours".';
  end if;
  st := shift_start(p_slot, p_date);
  en := st + make_interval(hours => a.hours);
  if now() < st - interval '30 minutes' then
    raise exception 'Too early. You can clock in from %.', local_time(a.org_id, st - interval '30 minutes');
  end if;
  if now() > en then
    raise exception 'This shift is already over. Use "Fix my hours" to send your times to your manager.';
  end if;
  if p_from_scheduled and now() > st + interval '5 minutes' then v_claim := st; end if;
  insert into time_entries (org_id, employee_id, slot_id, work_date, clock_in, claimed_in, source)
  values (a.org_id, a.employee_id, p_slot, p_date, now(), v_claim, 'clock') returning * into r;
  if v_claim is not null then
    perform notify_user(a.org_id, (select owner_id from organizations where id = a.org_id),
      a.emp_name || ' clocked in at ' || local_time(a.org_id, now()) || ' but says they started at ' || local_time(a.org_id, v_claim) ||
      ' (' || slot_label(p_slot, p_date) || '). Approve or keep the real time in Time clock.');
  end if;
  return r;
end $$;
grant execute on function public.clock_in(uuid, date, boolean) to authenticated;

-- Emergency cover: clock in on a shift that is happening now, even if it's someone else's or open.
-- The shift moves to the worker; if it belonged to someone, that person now owes them a shift (ledger).
create or replace function public.clock_in_cover(p_slot uuid, p_date date, p_from_scheduled boolean default false) returns public.time_entries
language plpgsql security definer set search_path = public as $$
declare v_org uuid; v_loc uuid; v_hours int; v_me uuid; v_me_name text; v_other uuid; v_other_name text; v_other_user uuid;
  st timestamptz; en timestamptz; v_label text; v_claim timestamptz; r time_entries;
begin
  select org_id, location_id, hours into v_org, v_loc, v_hours from shift_slots where id = p_slot and active;
  if v_org is null then raise exception 'That shift no longer exists.'; end if;
  select id, name into v_me, v_me_name from employees where user_id = auth.uid() and org_id = v_org;
  if v_me is null then raise exception 'You don''t work for this business.'; end if;
  if exists (select 1 from organizations where id = v_org and status = 'suspended') then raise exception 'This account is suspended.'; end if;

  select employee_id into v_other from assignments where slot_id = p_slot and work_date = p_date for update;
  if v_other = v_me then return clock_in(p_slot, p_date, p_from_scheduled); end if;

  st := shift_start(p_slot, p_date);
  en := st + make_interval(hours => v_hours);
  if now() < st - interval '30 minutes' or now() > en then
    raise exception 'You can only cover a shift while it''s happening (from 30 minutes before it starts until it ends).';
  end if;
  if exists (select 1 from time_entries where employee_id = v_me and clock_out is null) then
    raise exception 'You are already clocked in. Clock out first.';
  end if;
  if v_other is not null and exists (select 1 from time_entries where employee_id = v_other and slot_id = p_slot and work_date = p_date) then
    raise exception '% already clocked in for this shift.', (select name from employees where id = v_other);
  end if;

  v_label := slot_label(p_slot, p_date);
  if v_other is null then
    insert into assignments (org_id, location_id, slot_id, work_date, employee_id) values (v_org, v_loc, p_slot, p_date, v_me);
  else
    select name, user_id into v_other_name, v_other_user from employees where id = v_other;
    update assignments set employee_id = v_me where slot_id = p_slot and work_date = p_date;
    insert into ledger (org_id, debtor_id, creditor_id, slot_id, work_date, label)
    values (v_org, v_other, v_me, p_slot, p_date, v_label);
  end if;

  if p_from_scheduled and now() > st + interval '5 minutes' then v_claim := st; end if;
  insert into time_entries (org_id, employee_id, slot_id, work_date, clock_in, claimed_in, source, note)
  values (v_org, v_me, p_slot, p_date, now(), v_claim, 'clock',
    case when v_other is null then 'Covered an open shift' else 'Covered for ' || v_other_name end)
  returning * into r;

  perform notify_user(v_org, (select owner_id from organizations where id = v_org),
    v_me_name || ' clocked in to cover ' || coalesce(v_other_name || '''s', 'an open') || ' shift: ' || v_label || '.' ||
    case when v_other is null then '' else ' ' || v_other_name || ' now owes ' || v_me_name || ' 1 shift (see Shifts owed to trade back).' end ||
    case when v_claim is null then '' else ' They say they started at ' || local_time(v_org, v_claim) || '; approve it in Time clock.' end);
  if v_other_user is not null then
    perform notify_user(v_org, v_other_user, v_me_name || ' covered your shift ' || v_label || '. You owe them 1 shift; your manager will set up the trade.');
  end if;
  return r;
end $$;
grant execute on function public.clock_in_cover(uuid, date, boolean) to authenticated;

-- Owner decides on a claimed start time: approve (pay from the claimed time) or keep the real clock-in.
create or replace function public.decide_claimed_start(p_entry uuid, p_approve boolean) returns void
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  select * into r from time_entries where id = p_entry for update;
  if r.id is null or not owns_org(r.org_id) then raise exception 'Not found.'; end if;
  if r.claimed_in is null then raise exception 'This was already decided.'; end if;
  update time_entries set clock_in = case when p_approve then claimed_in else clock_in end, claimed_in = null, source = 'owner' where id = p_entry;
  perform notify_user(r.org_id, (select user_id from employees where id = r.employee_id),
    case when p_approve then 'Your start time for ' || to_char(r.work_date, 'Dy MM/DD') || ' was approved: ' || local_time(r.org_id, r.claimed_in) || '.'
      else 'Your manager kept your real clock-in time for ' || to_char(r.work_date, 'Dy MM/DD') || ': ' || local_time(r.org_id, r.clock_in) || '.' end);
end $$;
grant execute on function public.decide_claimed_start to authenticated;
