-- Time clock: clock in/out, hour fixes, phone reminders.
-- Pay is based on clocked hours (time_entries with a clock_out).

alter table public.organizations add column if not exists time_zone text not null default 'America/Chicago';

create table public.time_entries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations on delete cascade,
  employee_id uuid not null references public.employees on delete cascade,
  slot_id uuid references public.shift_slots on delete set null,
  work_date date not null,
  clock_in timestamptz not null,
  clock_out timestamptz,
  source text not null default 'clock' check (source in ('clock', 'owner', 'request')),
  note text,
  created_at timestamptz not null default now(),
  check (clock_out is null or clock_out > clock_in)
);
create index time_entries_org on public.time_entries (org_id, work_date);
create index time_entries_emp on public.time_entries (employee_id, clock_in desc);
create unique index time_entries_one_open on public.time_entries (employee_id) where clock_out is null;

create table public.time_fix_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations on delete cascade,
  employee_id uuid not null references public.employees on delete cascade,
  slot_id uuid references public.shift_slots on delete set null,
  work_date date not null,
  clock_in timestamptz not null,
  clock_out timestamptz not null,
  reason text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied', 'cancelled')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  check (clock_out > clock_in)
);
create index time_fix_org on public.time_fix_requests (org_id, created_at desc);

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
create index push_user on public.push_subscriptions (user_id);

create table public.reminders_sent (
  employee_id uuid not null references public.employees on delete cascade,
  slot_id uuid not null references public.shift_slots on delete cascade,
  work_date date not null,
  kind text not null,
  sent_at timestamptz not null default now(),
  primary key (employee_id, slot_id, work_date, kind)
);

alter table public.time_entries enable row level security;
alter table public.time_fix_requests enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.reminders_sent enable row level security;

create policy "read" on public.time_entries for select using (
  owns_org(org_id) or employee_id in (select my_employee_ids()) or is_admin());
create policy "owner writes" on public.time_entries for all using (owns_org(org_id)) with check (owns_org(org_id));

create policy "read" on public.time_fix_requests for select using (
  owns_org(org_id) or employee_id in (select my_employee_ids()) or is_admin());

create policy "own" on public.push_subscriptions for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------- helpers

-- Real start time of a shift, using the business's time zone.
create or replace function public.shift_start(p_slot uuid, p_date date) returns timestamptz
language sql stable security definer set search_path = public as $$
  select (p_date + make_interval(hours => s.start_hour)) at time zone o.time_zone
  from shift_slots s join organizations o on o.id = s.org_id where s.id = p_slot
$$;

create or replace function public.local_time(p_org uuid, p_ts timestamptz) returns text
language sql stable security definer set search_path = public as $$
  select ltrim(lower(to_char(p_ts at time zone o.time_zone, 'HH12:MI am')), '0') from organizations o where o.id = p_org
$$;

-- ---------------------------------------------------------------- clock in / out (workers)

create or replace function public.clock_in(p_slot uuid, p_date date) returns public.time_entries
language plpgsql security definer set search_path = public as $$
declare a record; st timestamptz; en timestamptz; r time_entries;
begin
  select asg.*, s.hours into a from assignments asg join shift_slots s on s.id = asg.slot_id
  where asg.slot_id = p_slot and asg.work_date = p_date and asg.employee_id in (select my_employee_ids());
  if a.id is null then raise exception 'This shift isn''t on your schedule. Ask your manager.'; end if;
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
  insert into time_entries (org_id, employee_id, slot_id, work_date, clock_in, source)
  values (a.org_id, a.employee_id, p_slot, p_date, now(), 'clock') returning * into r;
  return r;
end $$;
grant execute on function public.clock_in to authenticated;

create or replace function public.clock_out() returns public.time_entries
language plpgsql security definer set search_path = public as $$
declare r time_entries;
begin
  update time_entries set clock_out = now()
  where employee_id in (select my_employee_ids()) and clock_out is null
  returning * into r;
  if r.id is null then raise exception 'You are not clocked in.'; end if;
  return r;
end $$;
grant execute on function public.clock_out to authenticated;

-- ---------------------------------------------------------------- hour fixes

create or replace function public.request_time_fix(p_slot uuid, p_date date, p_in timestamptz, p_out timestamptz, p_reason text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_emp uuid; v_org uuid; v_name text; v_id uuid;
begin
  if p_out <= p_in then raise exception 'Clock-out has to be after clock-in.'; end if;
  if p_out - p_in > interval '20 hours' then raise exception 'That''s more than 20 hours. Check the times.'; end if;
  if p_slot is not null then
    select a.employee_id, a.org_id into v_emp, v_org from assignments a
    where a.slot_id = p_slot and a.work_date = p_date and a.employee_id in (select my_employee_ids());
    if v_emp is null then raise exception 'That shift isn''t on your schedule.'; end if;
  else
    select id, org_id into v_emp, v_org from employees where user_id = auth.uid() order by created_at limit 1;
  end if;
  select name into v_name from employees where id = v_emp;
  insert into time_fix_requests (org_id, employee_id, slot_id, work_date, clock_in, clock_out, reason)
  values (v_org, v_emp, p_slot, p_date, p_in, p_out, nullif(trim(p_reason), '')) returning id into v_id;
  perform notify_user(v_org, (select owner_id from organizations where id = v_org),
    v_name || ' asked to fix hours for ' || to_char(p_date, 'Dy MM/DD') || ': ' || local_time(v_org, p_in) || ' – ' || local_time(v_org, p_out) ||
    coalesce(' ("' || nullif(trim(p_reason), '') || '")', '') || '. Open Time clock to approve.');
  return v_id;
end $$;
grant execute on function public.request_time_fix to authenticated;

create or replace function public.cancel_time_fix(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update time_fix_requests set status = 'cancelled', decided_at = now()
  where id = p_id and status = 'pending' and employee_id in (select my_employee_ids());
  if not found then raise exception 'This request was already answered or cancelled.'; end if;
end $$;
grant execute on function public.cancel_time_fix to authenticated;

create or replace function public.decide_time_fix(p_id uuid, p_approve boolean) returns void
language plpgsql security definer set search_path = public as $$
declare r record; v_entry uuid;
begin
  select * into r from time_fix_requests where id = p_id for update;
  if r.id is null or not owns_org(r.org_id) then raise exception 'Request not found.'; end if;
  if r.status <> 'pending' then raise exception 'This request was already answered or cancelled.'; end if;
  update time_fix_requests set status = case when p_approve then 'approved' else 'denied' end, decided_at = now() where id = p_id;
  if p_approve then
    select id into v_entry from time_entries where employee_id = r.employee_id and work_date = r.work_date
      and slot_id is not distinct from r.slot_id order by clock_in limit 1;
    if v_entry is not null then
      update time_entries set clock_in = r.clock_in, clock_out = r.clock_out, source = 'request' where id = v_entry;
    else
      insert into time_entries (org_id, employee_id, slot_id, work_date, clock_in, clock_out, source, note)
      values (r.org_id, r.employee_id, r.slot_id, r.work_date, r.clock_in, r.clock_out, 'request', r.reason);
    end if;
  end if;
  perform notify_user(r.org_id, (select user_id from employees where id = r.employee_id),
    case when p_approve then 'Your hours for ' || to_char(r.work_date, 'Dy MM/DD') || ' were approved: ' || local_time(r.org_id, r.clock_in) || ' – ' || local_time(r.org_id, r.clock_out) || '.'
      else 'Your hours fix for ' || to_char(r.work_date, 'Dy MM/DD') || ' was denied. Talk to your manager.' end);
end $$;
grant execute on function public.decide_time_fix to authenticated;

-- ---------------------------------------------------------------- reminders

-- Returns the clock-in / clock-out reminders that are due now and records them so each goes out once.
-- Called every 5 minutes by the send-reminders Edge Function (service role only).
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
      where a.work_date between current_date - 2 and current_date + 1 and e.user_id is not null and o.status = 'active'
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
revoke execute on function public.due_reminders from public, anon, authenticated;
grant execute on function public.due_reminders to service_role;

alter publication supabase_realtime add table public.time_entries, public.time_fix_requests;

-- ---------------------------------------------------------------- schedule: run reminders every 5 minutes
-- __PROJECT_REF__ is filled in by .github/workflows/supabase.yml before this runs.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'splityourshift-reminders';
  perform cron.schedule('splityourshift-reminders', '*/5 * * * *',
    $job$ select net.http_post(
      url := 'https://__PROJECT_REF__.supabase.co/functions/v1/send-reminders',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := '{}'::jsonb) $job$);
end $$;
