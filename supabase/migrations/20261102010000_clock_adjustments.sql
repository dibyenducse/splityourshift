-- Clock in with one tap, shift adjustments between workers, late-arrival grace, and two pay methods.
--
-- Per business (location):
--   grace_minutes      a clock-in up to this many minutes after the shift starts is not "late" (no adjustment asked).
--   mutual_approval    when two workers agree on a swap, it is final (owner only informed); off = owner approves too.
--   pay_method         'actual' = pay real clock times; 'grace' = within pay_grace_minutes of the shift start/end,
--   pay_grace_minutes  pay the scheduled time. Real times are always stored; grace never lowers pay.
-- shift_adjustments keeps every takeover, swap, extra shift and late-arrival agreement (pending → accepted/declined → completed).

alter table public.locations
  add column if not exists grace_minutes smallint not null default 10 check (grace_minutes between 0 and 120),
  add column if not exists mutual_approval boolean not null default true,
  add column if not exists pay_method text not null default 'actual' check (pay_method in ('actual', 'grace')),
  add column if not exists pay_grace_minutes smallint not null default 0 check (pay_grace_minutes between 0 and 30);

-- Unscheduled clock-ins have no shift; they belong to a business through location_id.
alter table public.time_entries add column if not exists location_id uuid references public.locations on delete set null;

create table public.shift_adjustments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations on delete cascade,
  location_id uuid references public.locations on delete set null,
  kind text not null check (kind in ('takeover', 'swap', 'extra', 'late_ignore', 'late_swap', 'late_payroll', 'proposal')),
  from_emp uuid not null references public.employees on delete cascade,
  to_emp uuid references public.employees on delete cascade,
  slot_id uuid references public.shift_slots on delete set null,
  work_date date,
  label text,
  minutes int,
  entry_id uuid references public.time_entries on delete set null,
  status text not null default 'recorded'
    check (status in ('pending', 'awaiting_owner', 'accepted', 'declined', 'recorded', 'completed', 'cancelled')),
  note text,
  ledger_id uuid references public.ledger on delete set null,
  created_by uuid,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  completed_at timestamptz
);
create index shift_adjustments_org on public.shift_adjustments (org_id, created_at desc);
alter table public.shift_adjustments enable row level security;
create policy "read" on public.shift_adjustments for select using (
  owns_org(org_id) or is_admin() or from_emp in (select my_employee_ids()) or to_emp in (select my_employee_ids()));
alter publication supabase_realtime add table public.shift_adjustments;

-- The worker who worked right before this shift at the same place, and how many minutes they stayed past its start.
create or replace function public.stayed_before(p_slot uuid, p_date date, p_me uuid)
returns table (employee_id uuid, name text, user_id uuid, minutes int)
language sql stable security definer set search_path = public as $$
  with me as (select s.location_id, shift_start(p_slot, p_date) as st from shift_slots s where s.id = p_slot)
  select a.employee_id, e.name, e.user_id,
    greatest(0, floor(extract(epoch from (coalesce(t.clock_out, now()) - me.st)) / 60))::int
  from me
  join assignments a on a.location_id = me.location_id and a.work_date between p_date - 1 and p_date and a.employee_id <> p_me
  join shift_slots ps on ps.id = a.slot_id
  join employees e on e.id = a.employee_id
  join time_entries t on t.employee_id = a.employee_id and t.slot_id = a.slot_id and t.work_date = a.work_date
  where shift_start(a.slot_id, a.work_date) + make_interval(hours => ps.hours) = me.st
    and coalesce(t.clock_out, now()) > me.st + interval '1 minute'
  limit 1
$$;
revoke execute on function public.stayed_before(uuid, date, uuid) from public, anon, authenticated;

-- One-tap clock in. Uses the worker's shift that is on now (from 30 min before it starts until it ends);
-- with no shift on now, the worker is clocked in anyway and asked whether they are covering someone.
-- Returns what the app should ask next: {mode: 'scheduled' | 'late' | 'unscheduled', entry_id, ...}.
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
  insert into time_entries (org_id, employee_id, location_id, work_date, clock_in, source, note)
  values (v_emp.org_id, v_emp.id, v_loc, (now() at time zone (select time_zone from organizations where id = v_emp.org_id))::date, now(), 'clock', 'No scheduled shift')
  returning * into r;
  return jsonb_build_object('mode', 'unscheduled', 'entry_id', r.id);
end $$;
revoke execute on function public.clock_in_now(uuid) from public, anon;
grant execute on function public.clock_in_now(uuid) to authenticated;

-- After an unscheduled clock-in: which shift the worker is covering, and how.
--   takeover: the shift was given to them for good; swap: the other worker covers one of theirs later (they accept);
--   extra: an extra paid shift, nothing owed. p_slot null = not covering anyone (extra shift at p_loc).
create or replace function public.resolve_unscheduled(p_entry uuid, p_kind text, p_slot uuid default null, p_date date default null, p_loc uuid default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare t time_entries; me employees; v_other uuid; o employees; v_loc uuid; v_label text; v_id uuid; v_status text; v_owner uuid;
begin
  if p_kind not in ('takeover', 'swap', 'extra') then raise exception 'Pick takeover, swap or extra shift.'; end if;
  select * into t from time_entries where id = p_entry and employee_id in (select my_employee_ids());
  if t.id is null then raise exception 'That clock-in isn''t yours.'; end if;
  if t.slot_id is not null then raise exception 'This clock-in is already on a shift.'; end if;
  select * into me from employees where id = t.employee_id;
  select owner_id into v_owner from organizations where id = t.org_id;

  if p_slot is null then
    if p_kind <> 'extra' then raise exception 'Pick the shift you are covering.'; end if;
    v_loc := coalesce(p_loc, t.location_id);
    if v_loc is not null and not exists (select 1 from locations where id = v_loc and org_id = t.org_id) then raise exception 'Unknown business.'; end if;
    update time_entries set location_id = v_loc, note = 'Extra shift' where id = t.id;
    insert into shift_adjustments (org_id, location_id, kind, from_emp, work_date, label, entry_id, status, created_by)
    values (t.org_id, v_loc, 'extra', me.id, t.work_date, (select name from locations where id = v_loc), t.id, 'recorded', auth.uid()) returning id into v_id;
    perform notify_user(t.org_id, v_owner, me.name || ' clocked in for an extra shift at ' || coalesce((select name from locations where id = v_loc), 'work') || ' (no scheduled shift).');
    return v_id;
  end if;

  select s.location_id into v_loc from shift_slots s where s.id = p_slot and s.org_id = t.org_id and s.active;
  if v_loc is null then raise exception 'That shift no longer exists.'; end if;
  if now() < shift_start(p_slot, p_date) - interval '30 minutes'
     or now() > shift_start(p_slot, p_date) + make_interval(hours => (select hours from shift_slots where id = p_slot)) then
    raise exception 'You can only cover a shift that is happening now.';
  end if;
  select employee_id into v_other from assignments where slot_id = p_slot and work_date = p_date for update;
  if v_other = me.id then raise exception 'That is already your shift.'; end if;
  if v_other is not null and exists (select 1 from time_entries where employee_id = v_other and slot_id = p_slot and work_date = p_date) then
    raise exception '% already clocked in for this shift.', (select name from employees where id = v_other);
  end if;
  if v_other is null and p_kind = 'swap' then raise exception 'This shift is open, so there is no one to swap with.'; end if;

  v_label := slot_label(p_slot, p_date);
  if v_other is null then
    insert into assignments (org_id, location_id, slot_id, work_date, employee_id) values (t.org_id, v_loc, p_slot, p_date, me.id);
  else
    update assignments set employee_id = me.id where slot_id = p_slot and work_date = p_date;
  end if;
  select * into o from employees where id = v_other;
  update time_entries set slot_id = p_slot, work_date = p_date, location_id = v_loc,
    note = case p_kind when 'takeover' then 'Took over ' when 'swap' then 'Covered (swap) for ' else 'Extra shift for ' end || coalesce(o.name, 'an open shift')
  where id = t.id;
  v_status := case when p_kind = 'swap' then 'pending' else 'recorded' end;
  insert into shift_adjustments (org_id, location_id, kind, from_emp, to_emp, slot_id, work_date, label, entry_id, status, created_by)
  values (t.org_id, v_loc, p_kind, me.id, v_other, p_slot, p_date, v_label, t.id, v_status, auth.uid()) returning id into v_id;

  perform notify_user(t.org_id, v_owner, me.name || case p_kind
    when 'takeover' then ' took over ' || coalesce(o.name || '''s', 'an open') || ' shift ' || v_label || ' (given for good, nothing owed).'
    when 'swap' then ' is covering ' || o.name || '''s shift ' || v_label || ' as a swap; waiting for ' || o.name || ' to accept.'
    else ' is working ' || coalesce(o.name || '''s', 'an open') || ' shift ' || v_label || ' as an extra paid shift (no swap).' end);
  if o.user_id is not null then
    perform notify_user(t.org_id, o.user_id, me.name || case p_kind
      when 'takeover' then ' took over your shift ' || v_label || '. You don''t owe a shift for it.'
      when 'swap' then ' is covering your shift ' || v_label || ' and asks for a swap: you cover one of their shifts later. Accept or decline in SplitYourShift.'
      else ' is working your shift ' || v_label || ' as an extra paid shift. Nothing is owed.' end);
  end if;
  return v_id;
end $$;
revoke execute on function public.resolve_unscheduled(uuid, text, uuid, date, uuid) from public, anon;
grant execute on function public.resolve_unscheduled(uuid, text, uuid, date, uuid) to authenticated;

-- After a late clock-in where the previous worker stayed on: ignore (they approve), swap the minutes later
-- (they accept), or let payroll handle it (recorded only).
create or replace function public.late_choice(p_entry uuid, p_choice text) returns uuid
language plpgsql security definer set search_path = public as $$
declare t time_entries; me employees; p record; v_late int; v_kind text; v_id uuid; v_label text;
begin
  if p_choice not in ('ignore', 'swap', 'payroll') then raise exception 'Pick ignore, swap or payroll.'; end if;
  select * into t from time_entries where id = p_entry and employee_id in (select my_employee_ids());
  if t.id is null or t.slot_id is null then raise exception 'That clock-in isn''t yours.'; end if;
  if exists (select 1 from shift_adjustments where entry_id = t.id and kind like 'late_%' and status <> 'cancelled') then
    raise exception 'You already chose for this late clock-in.';
  end if;
  select * into me from employees where id = t.employee_id;
  v_late := greatest(0, floor(extract(epoch from (t.clock_in - shift_start(t.slot_id, t.work_date))) / 60))::int;
  select * into p from stayed_before(t.slot_id, t.work_date, me.id);
  if p.employee_id is null and p_choice <> 'payroll' then raise exception 'Nobody stayed on for you, so there is nothing to agree on.'; end if;
  v_kind := 'late_' || p_choice;
  v_label := slot_label(t.slot_id, t.work_date);
  insert into shift_adjustments (org_id, location_id, kind, from_emp, to_emp, slot_id, work_date, label, minutes, entry_id, status, created_by)
  values (t.org_id, (select location_id from shift_slots where id = t.slot_id), v_kind, me.id, p.employee_id, t.slot_id, t.work_date, v_label,
    least(v_late, coalesce(p.minutes, v_late)), t.id, case when p_choice = 'payroll' then 'recorded' else 'pending' end, auth.uid())
  returning id into v_id;
  if p_choice <> 'payroll' and p.user_id is not null then
    perform notify_user(t.org_id, p.user_id, me.name || ' was ' || v_late || ' minutes late for ' || v_label || ' and you stayed on. ' ||
      case when p_choice = 'ignore' then 'They ask to call it even (no swap). Approve or decline in SplitYourShift.'
      else 'They offer to come ' || least(v_late, p.minutes) || ' minutes early for you another day. Accept or decline in SplitYourShift.' end);
  end if;
  perform notify_user(t.org_id, (select owner_id from organizations where id = t.org_id), me.name || ' (' || v_late || ' min late, ' || v_label || ') chose: ' ||
    case p_choice when 'ignore' then 'call it even with ' || p.name || ' (waiting for them).'
      when 'swap' then 'pay back ' || p.name || '''s extra minutes by coming early (waiting for them).'
      else 'normal payroll (real clock times).' end);
  return v_id;
end $$;
revoke execute on function public.late_choice(uuid, text) from public, anon;
grant execute on function public.late_choice(uuid, text) to authenticated;

-- Final step of an accepted agreement: a whole-shift swap becomes a "shift owed" entry (the existing payback list).
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
end $$;
revoke execute on function public.adjustment_finalize(uuid) from public, anon, authenticated;

-- The other worker accepts or declines.
create or replace function public.respond_adjustment(p_id uuid, p_accept boolean) returns void
language plpgsql security definer set search_path = public as $$
declare a shift_adjustments; me employees; v_mutual boolean; v_owner uuid;
begin
  select * into a from shift_adjustments where id = p_id and to_emp in (select my_employee_ids()) for update;
  if a.id is null then raise exception 'This request isn''t for you.'; end if;
  if a.status <> 'pending' then raise exception 'This request was already answered.'; end if;
  select * into me from employees where id = a.to_emp;
  select coalesce((select mutual_approval from locations where id = a.location_id), true) into v_mutual;
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
    case when p_accept and not v_mutual then ' Your manager confirms it next.' else '' end);
  perform notify_user(a.org_id, v_owner, me.name || case when p_accept then ' accepted ' else ' declined ' end ||
    (select name from employees where id = a.from_emp) || '''s ' || replace(a.kind, '_', ' ') || ' request (' || coalesce(a.label, '') || ').' ||
    case when p_accept and not v_mutual then ' It needs your approval in Time clock.' else '' end);
end $$;
revoke execute on function public.respond_adjustment(uuid, boolean) from public, anon;
grant execute on function public.respond_adjustment(uuid, boolean) to authenticated;

-- Owner: approve/decline one waiting for them, mark one completed, or cancel. Workers: cancel their own pending one,
-- or mark an accepted minutes-swap completed.
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
  elsif p_action = 'cancel' and a.status in ('pending', 'awaiting_owner') and (v_owner or a.from_emp in (select my_employee_ids())) then
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

-- Owner proposes an adjustment between two workers: the second one accepts or declines.
create or replace function public.propose_adjustment(p_from uuid, p_to uuid, p_kind text, p_minutes int, p_note text) returns uuid
language plpgsql security definer set search_path = public as $$
declare f employees; t employees; v_id uuid;
begin
  if p_kind not in ('swap', 'late_swap') then raise exception 'Pick a swap of a shift or of minutes.'; end if;
  select * into f from employees where id = p_from; select * into t from employees where id = p_to;
  if f.id is null or t.id is null or f.org_id <> t.org_id or not owns_org(f.org_id) then raise exception 'Only the owner can propose this.'; end if;
  if f.id = t.id then raise exception 'Pick two different workers.'; end if;
  insert into shift_adjustments (org_id, kind, from_emp, to_emp, label, minutes, note, status, created_by)
  values (f.org_id, p_kind, f.id, t.id, coalesce(nullif(trim(p_note), ''), 'Proposed by your manager'),
    case when p_kind = 'late_swap' then greatest(1, coalesce(p_minutes, 0)) end, nullif(trim(p_note), ''), 'pending', auth.uid())
  returning id into v_id;
  perform notify_user(f.org_id, t.user_id, 'Your manager proposes: ' || case p_kind when 'swap' then 'you cover one shift for ' || f.name
    else 'a ' || greatest(1, coalesce(p_minutes, 0)) || '-minute swap with ' || f.name end ||
    coalesce(' (' || nullif(trim(p_note), '') || ')', '') || '. Accept or decline in SplitYourShift.');
  perform notify_user(f.org_id, f.user_id, 'Your manager proposed a ' || replace(p_kind, '_', ' ') || ' with ' || t.name || '; waiting for them to accept.');
  return v_id;
end $$;
revoke execute on function public.propose_adjustment(uuid, uuid, text, int, text) from public, anon;
grant execute on function public.propose_adjustment(uuid, uuid, text, int, text) to authenticated;

-- Payroll: grace pay method, and unscheduled clock-ins counted at their business.
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
    join l on l.org_id = t.org_id
    left join shift_slots s on s.id = t.slot_id
    where t.work_date between p_start and p_end
      and (p_emp is null or t.employee_id = p_emp)
      and coalesce(s.location_id, t.location_id, (select el.location_id from employee_locations el join locations x on x.id = el.location_id
                                   where el.employee_id = t.employee_id order by x.sort, x.created_at limit 1)) = l.id
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
