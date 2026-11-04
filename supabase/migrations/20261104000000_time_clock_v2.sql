-- Time clock on/off per location, one grace period, clock-out follow-ups, and time swaps with a date and shift.
--   time_clock = false: no clock in/out or late questions at that location; payroll pays the scheduled shift hours.
--   pay_method 'grace' ("scheduled hours with paid grace"): within the grace minutes of a shift's start/end the
--     scheduled time is paid; real clock times are kept and time worked past the shift is always paid.
--   Time swaps (late_swap): minutes one worker gives back to another on a chosen future date and shift. The worker
--     whose turn it is accepts, declines, or proposes another time; when both agree it is final and the owner is told.
--   Late beyond grace: normal payroll, ask the owner to pay the scheduled start (existing late clock-in approval),
--     or a time swap with whoever stayed on. Staying past the shift: normal payroll or a time swap.
--   Forgot to clock out: close at the scheduled end (the owner is told and can correct it) or now.

alter table public.locations add column if not exists time_clock boolean not null default true;
alter table public.locations drop constraint if exists locations_pay_grace_minutes_check;
alter table public.locations add constraint locations_pay_grace_minutes_check check (pay_grace_minutes between 0 and 120);

alter table public.shift_adjustments
  add column if not exists ret_slot uuid references public.shift_slots on delete set null,
  add column if not exists ret_date date,
  add column if not exists turn uuid references public.employees on delete set null;

-- Ask for a time swap. p_i_owe: I owe the other worker the minutes (I was late); otherwise they owe me (I stayed late).
-- p_slot/p_date: when the minutes are given back (any future date and shift slot, scheduled or not).
create or replace function public.request_time_swap(p_other uuid, p_minutes int, p_slot uuid, p_date date, p_i_owe boolean,
  p_entry uuid default null, p_note text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare o employees; me employees; s shift_slots; v_id uuid; v_label text; v_from uuid; v_to uuid;
begin
  select * into o from employees where id = p_other;
  if o.id is null then raise exception 'Pick a coworker.'; end if;
  select * into me from employees where org_id = o.org_id and user_id = auth.uid() limit 1;
  if me.id is null or me.id = o.id then raise exception 'Pick a coworker.'; end if;
  if coalesce(p_minutes, 0) < 1 or p_minutes > 600 then raise exception 'Enter the minutes (1 to 600).'; end if;
  select * into s from shift_slots where id = p_slot and org_id = o.org_id and active;
  if s.id is null then raise exception 'Pick the shift when the time is given back.'; end if;
  if p_date is null or p_date < org_today(o.org_id) then raise exception 'Pick today or a later date.'; end if;
  if p_entry is not null and exists (select 1 from shift_adjustments where entry_id = p_entry and kind like 'late_%' and status not in ('cancelled', 'declined')) then
    raise exception 'You already chose for this clock-in.';
  end if;
  v_from := case when p_i_owe then me.id else o.id end; v_to := case when p_i_owe then o.id else me.id end;
  v_label := slot_label(p_slot, p_date);
  insert into shift_adjustments (org_id, location_id, kind, from_emp, to_emp, minutes, ret_slot, ret_date, label, entry_id, note, status, turn, created_by)
  values (o.org_id, s.location_id, 'late_swap', v_from, v_to, p_minutes, p_slot, p_date, v_label, p_entry, nullif(trim(p_note), ''), 'pending', o.id, auth.uid())
  returning id into v_id;
  perform notify_user(o.org_id, o.user_id, me.name || ' asks for a ' || p_minutes || '-minute time swap: ' ||
    case when p_i_owe then me.name || ' covers ' || p_minutes || ' minutes of your shift ' else 'you cover ' || p_minutes || ' minutes of ' || me.name || '''s shift ' end ||
    v_label || '. Accept, decline or propose another time in SplitYourShift.');
  return v_id;
end $$;
revoke execute on function public.request_time_swap(uuid, int, uuid, date, boolean, uuid, text) from public, anon;
grant execute on function public.request_time_swap(uuid, int, uuid, date, boolean, uuid, text) to authenticated;

-- Propose another date/shift (and minutes) for a time swap; it goes back to the other worker.
create or replace function public.counter_time_swap(p_id uuid, p_slot uuid, p_date date, p_minutes int default null) returns void
language plpgsql security definer set search_path = public as $$
declare a shift_adjustments; me employees; o uuid; s shift_slots; v_label text;
begin
  select * into a from shift_adjustments where id = p_id and kind = 'late_swap' and status = 'pending'
    and coalesce(turn, to_emp) in (select my_employee_ids()) for update;
  if a.id is null then raise exception 'This request isn''t waiting for you.'; end if;
  select * into s from shift_slots where id = p_slot and org_id = a.org_id and active;
  if s.id is null then raise exception 'Pick a shift.'; end if;
  if p_date is null or p_date < org_today(a.org_id) then raise exception 'Pick today or a later date.'; end if;
  select * into me from employees where id = coalesce(a.turn, a.to_emp);
  o := case when me.id = a.from_emp then a.to_emp else a.from_emp end;
  v_label := slot_label(p_slot, p_date);
  update shift_adjustments set ret_slot = p_slot, ret_date = p_date, label = v_label, minutes = coalesce(nullif(p_minutes, 0), minutes), turn = o where id = p_id;
  perform notify_user(a.org_id, (select user_id from employees where id = o), me.name || ' proposes another time for your time swap: ' || v_label ||
    ' (' || coalesce(nullif(p_minutes, 0), a.minutes) || ' minutes). Accept, decline or propose another time in SplitYourShift.');
end $$;
revoke execute on function public.counter_time_swap(uuid, uuid, date, int) from public, anon;
grant execute on function public.counter_time_swap(uuid, uuid, date, int) to authenticated;

-- Late beyond grace: 'payroll' (real time) or 'paid' (ask the owner to pay from the scheduled start).
-- A time swap uses request_time_swap with the entry.
create or replace function public.late_choice(p_entry uuid, p_choice text) returns uuid
language plpgsql security definer set search_path = public as $$
declare t time_entries; me employees; v_late int; v_id uuid; v_st timestamptz;
begin
  if p_choice not in ('payroll', 'paid') then raise exception 'Pick normal payroll or a paid adjustment.'; end if;
  select * into t from time_entries where id = p_entry and employee_id in (select my_employee_ids());
  if t.id is null or t.slot_id is null then raise exception 'That clock-in isn''t yours.'; end if;
  if exists (select 1 from shift_adjustments where entry_id = t.id and kind like 'late_%' and status not in ('cancelled', 'declined')) then
    raise exception 'You already chose for this late clock-in.';
  end if;
  select * into me from employees where id = t.employee_id;
  v_st := shift_start(t.slot_id, t.work_date);
  v_late := greatest(0, floor(extract(epoch from (t.clock_in - v_st)) / 60))::int;
  insert into shift_adjustments (org_id, location_id, kind, from_emp, slot_id, work_date, label, minutes, entry_id, note, status, created_by)
  values (t.org_id, (select location_id from shift_slots where id = t.slot_id), 'late_payroll', me.id, t.slot_id, t.work_date, slot_label(t.slot_id, t.work_date),
    v_late, t.id, case when p_choice = 'paid' then 'Asked the owner to pay from the scheduled start' else 'Normal payroll' end, 'recorded', auth.uid())
  returning id into v_id;
  if p_choice = 'paid' then
    update time_entries set claimed_in = v_st where id = t.id;   -- the owner approves it in Time clock (late clock-ins to confirm)
    perform notify_user(t.org_id, (select owner_id from organizations where id = t.org_id), me.name || ' clocked in ' || v_late ||
      ' minutes late for ' || slot_label(t.slot_id, t.work_date) || ' and asks to be paid from the scheduled start. Approve or keep the real time in Time clock.');
  end if;
  return v_id;
end $$;
revoke execute on function public.late_choice(uuid, text) from public, anon;
grant execute on function public.late_choice(uuid, text) to authenticated;

-- Clock out (the same round button). Says how long past the scheduled end the worker stayed, beyond grace,
-- and who started late after them, so the app can offer normal payroll or a time swap.
create or replace function public.clock_out_now() returns jsonb
language plpgsql security definer set search_path = public as $$
declare t time_entries; v_end timestamptz; v_extra int := 0; v_grace int; n record; v_loc uuid;
begin
  update time_entries set clock_out = now() where employee_id in (select my_employee_ids()) and clock_out is null returning * into t;
  if t.id is null then raise exception 'You are not clocked in.'; end if;
  if t.slot_id is null then return jsonb_build_object('entry_id', t.id, 'extra_minutes', 0); end if;
  select s.location_id, shift_start(t.slot_id, t.work_date) + make_interval(hours => s.hours) into v_loc, v_end from shift_slots s where s.id = t.slot_id;
  select grace_minutes into v_grace from locations where id = v_loc;
  v_extra := greatest(0, floor(extract(epoch from (now() - v_end)) / 60))::int;
  if v_extra <= coalesce(v_grace, 10) then return jsonb_build_object('entry_id', t.id, 'extra_minutes', 0); end if;
  -- the next worker at this location whose shift started when mine ended, and who came after that
  select a.employee_id, e.name into n from assignments a join shift_slots s on s.id = a.slot_id join employees e on e.id = a.employee_id
  where s.location_id = v_loc and a.employee_id <> t.employee_id and a.work_date between t.work_date and t.work_date + 1
    and shift_start(a.slot_id, a.work_date) = v_end
    and coalesce((select min(x.clock_in) from time_entries x where x.employee_id = a.employee_id and x.slot_id = a.slot_id and x.work_date = a.work_date), now()) > v_end + make_interval(mins => coalesce(v_grace, 10))
  limit 1;
  return jsonb_build_object('entry_id', t.id, 'extra_minutes', v_extra, 'label', slot_label(t.slot_id, t.work_date), 'next_emp', n.employee_id, 'next_name', n.name);
end $$;
revoke execute on function public.clock_out_now() from public, anon;
grant execute on function public.clock_out_now() to authenticated;

-- Forgot to clock out: close the open clock-in at the shift's scheduled end. The owner is told and can correct it.
create or replace function public.clock_out_at_end(p_entry uuid) returns void
language plpgsql security definer set search_path = public as $$
declare t time_entries; v_end timestamptz;
begin
  select * into t from time_entries where id = p_entry and employee_id in (select my_employee_ids()) and clock_out is null for update;
  if t.id is null then raise exception 'That clock-in is already closed.'; end if;
  if t.slot_id is null then raise exception 'This clock-in has no scheduled end. Clock out now, or send a missed punch.'; end if;
  v_end := shift_start(t.slot_id, t.work_date) + make_interval(hours => (select hours from shift_slots where id = t.slot_id));
  if v_end <= t.clock_in or v_end > now() then raise exception 'The shift hasn''t ended yet.'; end if;
  update time_entries set clock_out = v_end, source = 'request', note = concat_ws(' · ', note, 'Forgot to clock out; closed at the scheduled end') where id = t.id;
  perform notify_user(t.org_id, (select owner_id from organizations where id = t.org_id), (select name from employees where id = t.employee_id) ||
    ' forgot to clock out of ' || slot_label(t.slot_id, t.work_date) || '; it was closed at the scheduled end, ' || local_time(t.org_id, v_end) ||
    '. Edit it in Time clock if that''s wrong.');
end $$;
revoke execute on function public.clock_out_at_end(uuid) from public, anon;
grant execute on function public.clock_out_at_end(uuid) to authenticated;

-- Existing functions, updated: no clock-in where the time clock is off; no reminders there; scheduled-hours
-- payroll there; whoever's turn it is answers a request.
create or replace function public.clock_in_now(p_loc uuid default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a record; r time_entries; v_late int; v_grace int; p record; v_emp employees; v_loc uuid;
begin
  if exists (select 1 from time_entries where employee_id in (select my_employee_ids()) and clock_out is null) then
    raise exception 'You are already clocked in. Clock out first.';
  end if;
  select asg.*, s.hours, s.location_id as loc, shift_start(asg.slot_id, asg.work_date) as st into a
  from assignments asg join shift_slots s on s.id = asg.slot_id
  where asg.employee_id in (select my_employee_ids()) and asg.work_date between current_date - 2 and current_date + 1
    and now() between shift_start(asg.slot_id, asg.work_date) - interval '30 minutes'
                  and shift_start(asg.slot_id, asg.work_date) + make_interval(hours => s.hours)
    and not exists (select 1 from time_entries t where t.employee_id = asg.employee_id and t.slot_id = asg.slot_id and t.work_date = asg.work_date)
  order by shift_start(asg.slot_id, asg.work_date) limit 1;

  if a.slot_id is not null then
    if exists (select 1 from organizations where id = a.org_id and status = 'suspended') then raise exception 'This account is suspended.'; end if;
    if not (select time_clock from locations where id = a.loc) then raise exception 'The time clock is turned off at %. Your shift hours are paid as scheduled.', (select name from locations where id = a.loc); end if;
    insert into time_entries (org_id, employee_id, slot_id, location_id, work_date, clock_in, source)
    values (a.org_id, a.employee_id, a.slot_id, a.loc, a.work_date, now(), 'clock') returning * into r;
    v_late := greatest(0, floor(extract(epoch from (now() - a.st)) / 60))::int;
    select grace_minutes into v_grace from locations where id = a.loc;
    if v_late <= coalesce(v_grace, 10) then
      return jsonb_build_object('mode', 'scheduled', 'entry_id', r.id, 'label', slot_label(a.slot_id, a.work_date), 'late_minutes', v_late);
    end if;
    select * into p from stayed_before(a.slot_id, a.work_date, a.employee_id);
    perform notify_user(a.org_id, (select owner_id from organizations where id = a.org_id),
      (select name from employees where id = a.employee_id) || ' clocked in ' || v_late || ' minutes late for ' || slot_label(a.slot_id, a.work_date) || '.' ||
      case when p.employee_id is not null then ' ' || p.name || ' stayed ' || least(p.minutes, v_late) || ' minutes extra.' else '' end);
    return jsonb_build_object('mode', 'late', 'entry_id', r.id, 'label', slot_label(a.slot_id, a.work_date), 'late_minutes', v_late,
      'grace', v_grace, 'covered_by', p.employee_id, 'covered_name', p.name, 'covered_minutes', least(coalesce(p.minutes, 0), v_late));
  end if;

  -- No shift on now.
  select * into v_emp from employees e where e.id in (select my_employee_ids())
    and (p_loc is null or exists (select 1 from locations l where l.id = p_loc and l.org_id = e.org_id))
  order by e.created_at limit 1;
  if v_emp.id is null then raise exception 'You aren''t on a staff list yet.'; end if;
  if exists (select 1 from organizations where id = v_emp.org_id and status = 'suspended') then raise exception 'This account is suspended.'; end if;
  v_loc := coalesce(p_loc, (select el.location_id from employee_locations el join locations x on x.id = el.location_id
                            where el.employee_id = v_emp.id order by x.sort, x.created_at limit 1));
  if v_loc is not null and not (select time_clock from locations where id = v_loc) then
    raise exception 'The time clock is turned off at %.', (select name from locations where id = v_loc);
  end if;
  insert into time_entries (org_id, employee_id, location_id, work_date, clock_in, source, note)
  values (v_emp.org_id, v_emp.id, v_loc, (now() at time zone (select time_zone from organizations where id = v_emp.org_id))::date, now(), 'clock', 'No scheduled shift')
  returning * into r;
  return jsonb_build_object('mode', 'unscheduled', 'entry_id', r.id);
end $$;

create or replace function public.due_reminders()
returns table (user_id uuid, kind text, title text, body text)
language plpgsql security definer set search_path = public as $$
declare c record;
begin
  for c in
    with cand as (
      select a.employee_id, a.slot_id, a.work_date, a.org_id, e.user_id as uid, l.name as loc, s.start_hour, s.hours,
        (a.work_date + make_interval(hours => s.start_hour)) at time zone o.time_zone as st
      from assignments a
      join shift_slots s on s.id = a.slot_id
      join locations l on l.id = s.location_id
      join employees e on e.id = a.employee_id
      join organizations o on o.id = a.org_id
      where a.work_date between current_date - 2 and current_date + 1 and e.user_id is not null and o.status = 'active' and l.time_clock
    )
    select cand.*, 'in' as k from cand
    where now() between st - interval '10 minutes' and st + interval '30 minutes'
      and not exists (select 1 from time_entries t where t.employee_id = cand.employee_id and t.slot_id = cand.slot_id and t.work_date = cand.work_date)
      and not exists (select 1 from time_off_requests q where q.employee_id = cand.employee_id and q.slot_id = cand.slot_id
        and q.work_date = cand.work_date and q.status = 'approved')
    union all
    select cand.*, 'out' from cand
    where now() between st + make_interval(hours => hours) and st + make_interval(hours => hours) + interval '2 hours'
      and exists (select 1 from time_entries t where t.employee_id = cand.employee_id and t.clock_out is null)
  loop
    insert into reminders_sent (employee_id, slot_id, work_date, kind) values (c.employee_id, c.slot_id, c.work_date, c.k)
    on conflict do nothing;
    if not found then continue; end if;
    user_id := c.uid; kind := c.k;
    if c.k = 'in' then
      title := 'Time to clock in';
      body := 'Your shift at ' || c.loc || ' starts at ' || local_time(c.org_id, c.st) || '. Tap to open SplitYourShift and clock in.';
    else
      title := 'Time to clock out';
      body := 'Your shift at ' || c.loc || ' ended at ' || local_time(c.org_id, c.st + make_interval(hours => c.hours)) || '. Tap to clock out.';
    end if;
    perform notify_user(c.org_id, c.uid, title || ': ' || body);
    return next;
  end loop;
end $$;

create or replace function public.payroll_lines(p_loc uuid, p_start date, p_end date, p_emp uuid default null)
returns table (employee_id uuid, name text, rate numeric, overtime_rate numeric, hours numeric, regular_hours numeric, overtime_hours numeric,
  regular_pay numeric, overtime_pay numeric, bonus numeric, deduction numeric, gross numeric, net numeric, open_entries int)
language sql stable security definer set search_path = public as $$
  with l as (
    select * from locations where id = p_loc
      and (owns_org(org_id) or is_admin() or auth.uid() is null or (p_emp is not null and p_emp in (select my_employee_ids())))
  ),
  ent as (
    select t.employee_id, t.clock_out, t.work_date,
      -- Paid time: the real clock times, or (grace method) the scheduled start/end when the worker was within
      -- the grace minutes of it. Grace only ever adds time; time worked beyond the shift is always paid.
      round((extract(epoch from (
        case when l.pay_method = 'grace' and s.id is not null and t.clock_out is not null
               and t.clock_out < shift_start(t.slot_id, t.work_date) + make_interval(hours => s.hours)
               and t.clock_out >= shift_start(t.slot_id, t.work_date) + make_interval(hours => s.hours) - make_interval(mins => l.pay_grace_minutes)
             then shift_start(t.slot_id, t.work_date) + make_interval(hours => s.hours) else t.clock_out end
        - case when l.pay_method = 'grace' and s.id is not null
               and t.clock_in > shift_start(t.slot_id, t.work_date)
               and t.clock_in <= shift_start(t.slot_id, t.work_date) + make_interval(mins => l.pay_grace_minutes)
             then shift_start(t.slot_id, t.work_date) else t.clock_in end)) / 3600)::numeric, 2) as h
    from time_entries t
    join l on l.org_id = t.org_id and l.time_clock
    left join shift_slots s on s.id = t.slot_id
    where t.work_date between p_start and p_end
      and (p_emp is null or t.employee_id = p_emp)
      and coalesce(s.location_id, t.location_id, (select el.location_id from employee_locations el join locations x on x.id = el.location_id
                                   where el.employee_id = t.employee_id order by x.sort, x.created_at limit 1)) = l.id
    union all
    -- Time clock off: the scheduled shifts are the paid hours.
    select a.employee_id, a.work_date::timestamptz, a.work_date, s2.hours::numeric
    from assignments a join shift_slots s2 on s2.id = a.slot_id join l on l.id = s2.location_id and not l.time_clock
    where a.work_date between p_start and p_end and (p_emp is null or a.employee_id = p_emp)
  ),
  wk as (
    select e.employee_id, e.work_date - (((e.work_date - l.pay_anchor) % 7 + 7) % 7) as week, sum(e.h) as h
    from ent e, l where e.clock_out is not null group by 1, 2
  ),
  per as (
    select w.employee_id, sum(w.h) as hours, sum(case when l.overtime then greatest(w.h - l.ot_after, 0) else 0 end) as ot
    from wk w, l group by 1
  ),
  adj as (
    select a.employee_id,
      sum(case when a.kind = 'bonus' then a.amount else 0 end) as bonus,
      sum(case when a.kind = 'deduction' then a.amount else 0 end) as deduction
    from payroll_adjustments a join l on l.id = a.location_id
    where a.period_start = p_start group by 1
  ),
  who as (
    select el.employee_id from employee_locations el join l on l.id = el.location_id
    union select ent.employee_id from ent
    union select adj.employee_id from adj
  ),
  calc as (
    select e.id, e.name, e.rate,
      round(case when l.ot_mode = 'fixed' then l.ot_fixed_rate else e.rate * l.ot_multiplier end, 2) as otr,
      coalesce(p.hours, 0) as hours, coalesce(p.hours - p.ot, 0) as reg, coalesce(p.ot, 0) as ot,
      coalesce(a.bonus, 0) as bonus, coalesce(a.deduction, 0) as deduction,
      (select count(*) from ent x where x.employee_id = e.id and x.clock_out is null)::int as open_entries
    from l, who join employees e on e.id = who.employee_id
    left join per p on p.employee_id = e.id
    left join adj a on a.employee_id = e.id
    where p_emp is null or e.id = p_emp
  )
  select id, name, rate, otr, hours, reg, ot,
    round(reg * rate, 2), round(ot * otr, 2), bonus, deduction,
    round(reg * rate, 2) + round(ot * otr, 2) + bonus,
    round(reg * rate, 2) + round(ot * otr, 2) + bonus - deduction,
    open_entries
  from calc order by name
$$;

create or replace function public.respond_adjustment(p_id uuid, p_accept boolean) returns void
language plpgsql security definer set search_path = public as $$
declare a shift_adjustments; me employees; v_mutual boolean; v_owner uuid;
begin
  select * into a from shift_adjustments where id = p_id and coalesce(turn, to_emp) in (select my_employee_ids()) for update;
  if a.id is null then raise exception 'This request isn''t for you.'; end if;
  if a.status <> 'pending' then raise exception 'This request was already answered.'; end if;
  select * into me from employees where id = coalesce(a.turn, a.to_emp);
  select a.kind in ('future_swap', 'payback', 'late_swap') or coalesce((select mutual_approval from locations where id = a.location_id), true) into v_mutual;
  select owner_id into v_owner from organizations where id = a.org_id;
  if not p_accept then
    update shift_adjustments set status = 'declined', decided_at = now() where id = p_id;
  elsif v_mutual then
    perform adjustment_finalize(p_id);
  else
    update shift_adjustments set status = 'awaiting_owner' where id = p_id;
  end if;
  perform notify_user(a.org_id, (select user_id from employees where id = case when me.id = a.from_emp then a.to_emp else a.from_emp end),
    me.name || case when p_accept then ' accepted' else ' declined' end || ' your request for ' || coalesce(a.label, 'the shift') || '.' ||
    case when p_accept and a.kind = 'future_swap' then ' ' || me.name || ' is on that shift now.'
         when p_accept and a.kind = 'payback' then ' You are on that shift now; the shift you owed is settled.'
         when p_accept and not v_mutual then ' Your manager confirms it next.' else '' end);
  perform notify_user(a.org_id, v_owner, me.name || case when p_accept then ' accepted ' else ' declined ' end ||
    (select name from employees where id = case when me.id = a.from_emp then a.to_emp else a.from_emp end) || '''s ' || case when a.kind = 'future_swap' then 'swap' when a.kind = 'payback' then 'pay back' when a.kind = 'late_swap' then 'time swap' else replace(a.kind, '_', ' ') end ||
    ' request (' || coalesce(a.label, '') || ').' ||
    case when p_accept and a.kind in ('future_swap', 'payback') then ' The schedule is updated.'
         when p_accept and not v_mutual then ' It needs your approval in Time clock.' else '' end);
end $$;

-- Whoever sent a request can cancel it while it is waiting; either worker can withdraw a waiting time swap.
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
  elsif p_action = 'cancel' and ((a.status in ('pending', 'awaiting_owner') and (v_owner or a.from_emp in (select my_employee_ids()) or a.created_by = auth.uid()
                                   or (a.kind = 'late_swap' and a.to_emp in (select my_employee_ids()))))
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
