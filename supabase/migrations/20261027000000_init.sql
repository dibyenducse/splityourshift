-- SplitYourShift database: tables, access rules (RLS), and server-side functions.
-- Run once in Supabase: Dashboard → SQL Editor → paste → Run (or `supabase db push`).

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- tables

create table public.platform_admins (
  user_id uuid primary key references auth.users on delete cascade,
  created_at timestamptz not null default now()
);

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users on delete cascade,
  name text not null,
  owner_name text,
  pay_period text not null default 'weekly' check (pay_period in ('weekly', 'biweekly')),
  pay_anchor date not null default (date_trunc('week', now())::date),
  overtime boolean not null default true,
  status text not null default 'active' check (status in ('active', 'suspended')),
  created_at timestamptz not null default now(),
  last_active_at timestamptz
);
create index organizations_owner on public.organizations (owner_id);

create table public.locations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations on delete cascade,
  name text not null,
  type text not null check (type in ('hotel', 'gas')),
  sort int not null default 0,
  created_at timestamptz not null default now()
);
create index locations_org on public.locations (org_id);

create table public.shift_slots (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations on delete cascade,
  location_id uuid not null references public.locations on delete cascade,
  start_hour smallint not null check (start_hour between 0 and 23),
  hours smallint not null check (hours between 1 and 16),
  sort int not null default 0,
  active boolean not null default true
);
create index shift_slots_loc on public.shift_slots (location_id);

create table public.employees (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations on delete cascade,
  user_id uuid references auth.users on delete set null,
  name text not null,
  email text,
  phone text,
  phone_digits text generated always as (regexp_replace(coalesce(phone, ''), '\D', '', 'g')) stored,
  max_shifts smallint not null default 5 check (max_shifts between 1 and 21),
  rate numeric(8, 2) not null default 15 check (rate >= 0),
  hue smallint not null default 200,
  lang text not null default 'en',
  invited_at timestamptz,
  created_at timestamptz not null default now()
);
create index employees_org on public.employees (org_id);
create index employees_user on public.employees (user_id);
create index employees_phone on public.employees (phone_digits);
create unique index employees_org_user on public.employees (org_id, user_id) where user_id is not null;

create table public.employee_locations (
  employee_id uuid not null references public.employees on delete cascade,
  location_id uuid not null references public.locations on delete cascade,
  primary key (employee_id, location_id)
);

create table public.availability (
  employee_id uuid not null references public.employees on delete cascade,
  dow smallint not null check (dow between 0 and 6), -- 0 = Monday
  mode text not null default 'any' check (mode in ('any', 'hours', 'off')),
  from_hour smallint not null default 6 check (from_hour between 0 and 23),
  to_hour smallint not null default 22 check (to_hour between 0 and 23),
  primary key (employee_id, dow)
);

create table public.assignments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations on delete cascade,
  location_id uuid not null references public.locations on delete cascade,
  slot_id uuid not null references public.shift_slots on delete cascade,
  work_date date not null,
  employee_id uuid not null references public.employees on delete cascade,
  created_at timestamptz not null default now(),
  unique (slot_id, work_date)
);
create index assignments_emp on public.assignments (employee_id, work_date);
create index assignments_org on public.assignments (org_id, work_date);

create table public.time_off_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations on delete cascade,
  employee_id uuid not null references public.employees on delete cascade,
  slot_id uuid references public.shift_slots on delete set null,
  work_date date not null,
  label text not null,
  reason text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied', 'cancelled')),
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index requests_org on public.time_off_requests (org_id, created_at desc);

create table public.ledger (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations on delete cascade,
  debtor_id uuid not null references public.employees on delete cascade,
  creditor_id uuid not null references public.employees on delete cascade,
  slot_id uuid references public.shift_slots on delete set null,
  work_date date not null,
  label text not null,
  status text not null default 'open' check (status in ('open', 'settled')),
  created_at timestamptz not null default now(),
  settled_at timestamptz
);
create index ledger_org on public.ledger (org_id);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations on delete cascade,
  recipient uuid not null references auth.users on delete cascade,
  text text not null,
  request_id uuid references public.time_off_requests on delete set null,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_recipient on public.notifications (recipient, created_at desc);

create table public.page_views (
  id bigserial primary key,
  ts timestamptz not null default now(),
  visitor text not null,
  path text not null,
  referrer text,
  user_id uuid
);
create index page_views_ts on public.page_views (ts);

-- ---------------------------------------------------------------- helpers

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from platform_admins where user_id = auth.uid())
$$;

create or replace function public.owns_org(o uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from organizations where id = o and owner_id = auth.uid())
$$;

create or replace function public.member_org(o uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select owns_org(o) or exists (select 1 from employees where org_id = o and user_id = auth.uid())
$$;

create or replace function public.my_employee_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select id from employees where user_id = auth.uid()
$$;

create or replace function public.h12(h int) returns int language sql immutable as $$
  select case when h % 24 = 0 then 12 when h % 24 > 12 then h % 24 - 12 else h % 24 end
$$;

create or replace function public.slot_label(p_slot uuid, p_date date) returns text
language sql stable security definer set search_path = public as $$
  select to_char(p_date, 'Dy MM/DD') || ' · ' || l.name || ' ' || h12(s.start_hour) || '–' || h12(s.start_hour + s.hours)
  from shift_slots s join locations l on l.id = s.location_id where s.id = p_slot
$$;

create or replace function public.notify_user(p_org uuid, p_user uuid, p_text text, p_request uuid default null) returns void
language sql security definer set search_path = public as $$
  insert into notifications (org_id, recipient, text, request_id)
  select p_org, p_user, p_text, p_request where p_user is not null
$$;
revoke execute on function public.notify_user from public, anon, authenticated;

-- ---------------------------------------------------------------- row level security

alter table public.platform_admins enable row level security;
alter table public.organizations enable row level security;
alter table public.locations enable row level security;
alter table public.shift_slots enable row level security;
alter table public.employees enable row level security;
alter table public.employee_locations enable row level security;
alter table public.availability enable row level security;
alter table public.assignments enable row level security;
alter table public.time_off_requests enable row level security;
alter table public.ledger enable row level security;
alter table public.notifications enable row level security;
alter table public.page_views enable row level security;

create policy "self" on public.platform_admins for select using (user_id = auth.uid());

create policy "read" on public.organizations for select using (owner_id = auth.uid() or member_org(id) or is_admin());
create policy "create own" on public.organizations for insert with check (owner_id = auth.uid());
create policy "owner edits" on public.organizations for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "owner deletes" on public.organizations for delete using (owner_id = auth.uid());
create policy "admin edits" on public.organizations for update using (is_admin()) with check (is_admin());

create policy "read" on public.locations for select using (member_org(org_id) or is_admin());
create policy "owner writes" on public.locations for all using (owns_org(org_id)) with check (owns_org(org_id));

create policy "read" on public.shift_slots for select using (member_org(org_id) or is_admin());
create policy "owner writes" on public.shift_slots for all using (owns_org(org_id)) with check (owns_org(org_id));

-- Workers read only their own employee row (rate, phone); coworkers' names come from the view below.
create policy "read" on public.employees for select using (owns_org(org_id) or user_id = auth.uid() or is_admin());
create policy "owner writes" on public.employees for all using (owns_org(org_id)) with check (owns_org(org_id));

create policy "read" on public.employee_locations for select using (
  exists (select 1 from employees e where e.id = employee_id and (member_org(e.org_id) or is_admin())));
create policy "owner writes" on public.employee_locations for all using (
  exists (select 1 from employees e where e.id = employee_id and owns_org(e.org_id)))
  with check (exists (select 1 from employees e join locations l on l.org_id = e.org_id
    where e.id = employee_id and l.id = location_id and owns_org(e.org_id)));

create policy "read" on public.availability for select using (
  employee_id in (select my_employee_ids()) or exists (select 1 from employees e where e.id = employee_id and (owns_org(e.org_id) or is_admin())));
create policy "worker writes own" on public.availability for all
  using (employee_id in (select my_employee_ids())) with check (employee_id in (select my_employee_ids()));

-- Schedule changes go through apply_changes() so the rules are always checked.
create policy "read" on public.assignments for select using (member_org(org_id) or is_admin());

create policy "read" on public.time_off_requests for select using (
  owns_org(org_id) or employee_id in (select my_employee_ids()) or is_admin());

create policy "read" on public.ledger for select using (
  owns_org(org_id) or debtor_id in (select my_employee_ids()) or creditor_id in (select my_employee_ids()) or is_admin());
create policy "owner writes" on public.ledger for all using (owns_org(org_id)) with check (owns_org(org_id));

create policy "own" on public.notifications for select using (recipient = auth.uid());
create policy "mark read" on public.notifications for update using (recipient = auth.uid()) with check (recipient = auth.uid());

-- page_views: no direct access; written by track_view(), read by admin functions.

-- Coworker names for workers (no rates or phone numbers).
create or replace view public.coworkers as
  select e.id, e.org_id, e.name, e.hue from public.employees e where member_org(e.org_id) or is_admin();
grant select on public.coworkers to authenticated;

-- ---------------------------------------------------------------- schedule changes

-- p_changes: [{ "slot_id": uuid, "work_date": "YYYY-MM-DD", "employee_id": uuid | null }]
-- Blocks: more shifts than an employee's weekly limit (only if the change makes it worse), and overlapping shifts.
create or replace function public.apply_changes(p_org uuid, p_changes jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c jsonb; v_slot uuid; v_date date; v_emp uuid; v_old uuid; v_loc uuid; v_wk date; v_label text;
  r record;
begin
  if not owns_org(p_org) then raise exception 'Only the owner can change this schedule.'; end if;
  if exists (select 1 from organizations where id = p_org and status = 'suspended') then
    raise exception 'This account is suspended. Contact SplitYourShift support.';
  end if;
  create temp table if not exists _aff (emp uuid, wk date, before int) on commit drop;
  create temp table if not exists _cells (slot uuid, d date, emp uuid) on commit drop;
  delete from _aff; delete from _cells;

  for c in select * from jsonb_array_elements(p_changes) loop
    v_slot := (c ->> 'slot_id')::uuid;
    v_date := (c ->> 'work_date')::date;
    v_emp := nullif(c ->> 'employee_id', '')::uuid;
    v_wk := date_trunc('week', v_date)::date;
    select location_id into v_loc from shift_slots where id = v_slot and org_id = p_org;
    if v_loc is null then raise exception 'That shift no longer exists. Refresh the page.'; end if;
    if v_emp is not null and not exists (select 1 from employees where id = v_emp and org_id = p_org) then
      raise exception 'That worker no longer exists. Refresh the page.';
    end if;
    select employee_id into v_old from assignments where slot_id = v_slot and work_date = v_date for update;

    insert into _aff (emp, wk, before)
    select e, v_wk, (select count(*) from assignments a where a.employee_id = e and a.work_date >= v_wk and a.work_date < v_wk + 7)
    from unnest(array[v_old, v_emp]) as e
    where e is not null and not exists (select 1 from _aff x where x.emp = e and x.wk = v_wk);

    if v_emp is null then
      delete from assignments where slot_id = v_slot and work_date = v_date;
    elsif v_old is null then
      insert into assignments (org_id, location_id, slot_id, work_date, employee_id) values (p_org, v_loc, v_slot, v_date, v_emp);
    else
      update assignments set employee_id = v_emp where slot_id = v_slot and work_date = v_date;
    end if;
    insert into _cells values (v_slot, v_date, v_emp);

    if v_old is distinct from v_emp then
      v_label := slot_label(v_slot, v_date);
      if v_old is not null then
        perform notify_user(p_org, (select user_id from employees where id = v_old), 'You''re no longer on ' || v_label || '.');
      end if;
      if v_emp is not null then
        perform notify_user(p_org, (select user_id from employees where id = v_emp), 'You now work ' || v_label || '.');
      end if;
    end if;
  end loop;

  for r in
    select a.emp, a.wk, a.before, e.max_shifts, e.name,
      (select count(*) from assignments x where x.employee_id = a.emp and x.work_date >= a.wk and x.work_date < a.wk + 7) as after
    from _aff a join employees e on e.id = a.emp
  loop
    if r.after > r.max_shifts and r.after > r.before then
      raise exception '% already has % of % shifts in the week of %. Remove one of their shifts or raise their limit.',
        r.name, r.before, r.max_shifts, to_char(r.wk, 'Mon DD');
    end if;
  end loop;

  for r in
    select e.name, slot_label(o.slot_id, o.work_date) as other
    from _cells c
    join shift_slots s on s.id = c.slot
    join assignments o on o.employee_id = c.emp and not (o.slot_id = c.slot and o.work_date = c.d)
      and o.work_date between c.d - 1 and c.d + 1
    join shift_slots so on so.id = o.slot_id
    join employees e on e.id = c.emp
    where c.emp is not null
      and (c.d + make_interval(hours => s.start_hour)) < (o.work_date + make_interval(hours => so.start_hour + so.hours))
      and (o.work_date + make_interval(hours => so.start_hour)) < (c.d + make_interval(hours => s.start_hour + s.hours))
    limit 1
  loop
    raise exception '% is already working % at that time.', r.name, r.other;
  end loop;

  update organizations set last_active_at = now() where id = p_org;
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.apply_changes to authenticated;

-- ---------------------------------------------------------------- time off

create or replace function public.request_time_off(p_cells jsonb, p_reason text) returns int
language plpgsql security definer set search_path = public as $$
declare c jsonb; a record; n int := 0; v_id uuid; v_owner uuid;
begin
  for c in select * from jsonb_array_elements(p_cells) loop
    select asg.*, e.name as emp_name into a from assignments asg join employees e on e.id = asg.employee_id
    where asg.slot_id = (c ->> 'slot_id')::uuid and asg.work_date = (c ->> 'work_date')::date
      and asg.employee_id in (select my_employee_ids());
    if a.id is null then continue; end if;
    if exists (select 1 from time_off_requests where employee_id = a.employee_id and slot_id = a.slot_id
      and work_date = a.work_date and status in ('pending', 'approved')) then continue; end if;
    insert into time_off_requests (org_id, employee_id, slot_id, work_date, label, reason)
    values (a.org_id, a.employee_id, a.slot_id, a.work_date, slot_label(a.slot_id, a.work_date), nullif(trim(p_reason), ''))
    returning id into v_id;
    select owner_id into v_owner from organizations where id = a.org_id;
    perform notify_user(a.org_id, v_owner,
      a.emp_name || ' asked for ' || slot_label(a.slot_id, a.work_date) || ' off' ||
      coalesce(': "' || nullif(trim(p_reason), '') || '"', '.'), v_id);
    n := n + 1;
  end loop;
  return n;
end $$;
grant execute on function public.request_time_off to authenticated;

create or replace function public.cancel_time_off(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  update time_off_requests set status = 'cancelled', decided_at = now()
  where id = p_id and status = 'pending' and employee_id in (select my_employee_ids())
  returning * into r;
  if r.id is null then raise exception 'This request was already answered or cancelled.'; end if;
  update notifications set read_at = now() where request_id = p_id and read_at is null;
  perform notify_user(r.org_id, (select owner_id from organizations where id = r.org_id),
    (select name from employees where id = r.employee_id) || ' cancelled their time-off request for ' || r.label || '. They''ll work it as scheduled.');
end $$;
grant execute on function public.cancel_time_off to authenticated;

create or replace function public.decide_time_off(p_id uuid, p_approve boolean) returns void
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  select * into r from time_off_requests where id = p_id for update;
  if r.id is null or not owns_org(r.org_id) then raise exception 'Request not found.'; end if;
  if r.status <> 'pending' then raise exception 'This request was already answered or cancelled.'; end if;
  update time_off_requests set status = case when p_approve then 'approved' else 'denied' end, decided_at = now() where id = p_id;
  update notifications set read_at = now() where request_id = p_id and read_at is null;
  perform notify_user(r.org_id, (select user_id from employees where id = r.employee_id),
    case when p_approve then 'Your time off for ' || r.label || ' was approved.'
      else 'Your time-off request for ' || r.label || ' was denied. Talk to your manager if you need to.' end);
end $$;
grant execute on function public.decide_time_off to authenticated;

-- ---------------------------------------------------------------- availability & activation

create or replace function public.on_availability_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_org uuid; v_owner uuid; v_text text;
begin
  select e.org_id, o.owner_id, e.name || ' updated their availability.' into v_org, v_owner, v_text
  from employees e join organizations o on o.id = e.org_id where e.id = new.employee_id;
  if not exists (select 1 from notifications where recipient = v_owner and text = v_text and read_at is null) then
    perform notify_user(v_org, v_owner, v_text);
  end if;
  return new;
end $$;
create trigger availability_notify after insert or update on public.availability
  for each row execute function public.on_availability_change();

-- Called by a worker right after setting their password from the invite link.
create or replace function public.worker_activated() returns void
language sql security definer set search_path = public as $$
  insert into notifications (org_id, recipient, text)
  select e.org_id, o.owner_id, e.name || ' set up their login and can now see their schedule.'
  from employees e join organizations o on o.id = e.org_id where e.user_id = auth.uid()
$$;
grant execute on function public.worker_activated to authenticated;

-- Workers can change their own phone number (used to log in); everything else is set by the owner.
create or replace function public.update_my_profile(p_phone text) returns void
language sql security definer set search_path = public as $$
  update employees set phone = nullif(trim(p_phone), '') where user_id = auth.uid()
$$;
grant execute on function public.update_my_profile to authenticated;

-- Login status of each worker, for the owner's staff list.
create or replace function public.login_status(p_org uuid)
returns table (employee_id uuid, status text)
language sql stable security definer set search_path = public, auth as $$
  select e.id,
    case
      when e.user_id is null then 'none'
      when coalesce(u.encrypted_password, '') <> '' then 'active'
      when e.invited_at < now() - interval '24 hours' then 'expired'
      else 'invited'
    end
  from public.employees e left join auth.users u on u.id = e.user_id
  where e.org_id = p_org and (owns_org(p_org) or is_admin())
$$;
grant execute on function public.login_status to authenticated;

-- Used by the invite Edge Function when a worker already has a login (e.g. works for two owners).
create or replace function public.auth_user_id_by_email(p_email text) returns uuid
language sql stable security definer set search_path = public, auth as $$
  select id from auth.users where lower(email) = lower(p_email) limit 1
$$;
revoke execute on function public.auth_user_id_by_email from public, anon, authenticated;
grant execute on function public.auth_user_id_by_email to service_role;

-- ---------------------------------------------------------------- analytics & admin

create or replace function public.track_view(p_path text, p_ref text) returns void
language plpgsql security definer set search_path = public as $$
declare h json := coalesce(current_setting('request.headers', true), '{}')::json;
begin
  if is_admin() then return; end if;
  insert into page_views (visitor, path, referrer, user_id)
  values (
    md5(current_date::text || coalesce(h ->> 'x-forwarded-for', '') || coalesce(h ->> 'user-agent', '')),
    left(coalesce(p_path, '/'), 200), left(p_ref, 200), auth.uid());
end $$;
grant execute on function public.track_view to anon, authenticated;

create or replace function public.admin_overview(p_days int default 14) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare since timestamptz := date_trunc('day', now()) - make_interval(days => p_days - 1);
begin
  if not is_admin() then raise exception 'Admins only.'; end if;
  return jsonb_build_object(
    'daily', (select coalesce(jsonb_agg(jsonb_build_object('day', d::date, 'visitors', coalesce(v, 0)) order by d), '[]')
      from generate_series(since, date_trunc('day', now()), interval '1 day') d
      left join (select date_trunc('day', ts) as day, count(distinct visitor) as v from page_views where ts >= since group by 1) pv on pv.day = d),
    'visitors', (select count(distinct visitor || date_trunc('day', ts)::text) from page_views where ts >= since),
    'signup_views', (select count(distinct visitor) from page_views where ts >= since and path like '%signup%'),
    'signups', (select count(*) from organizations where created_at >= since),
    'owners', (select count(*) from organizations),
    'hotels', (select count(*) from locations where type = 'hotel'),
    'gas', (select count(*) from locations where type = 'gas'),
    'workers', (select count(*) from employees),
    'workers_active', (select count(*) from employees where user_id is not null),
    'requests', (select count(*) from time_off_requests where created_at >= since),
    'requests_cancelled', (select count(*) from time_off_requests where created_at >= since and status = 'cancelled'),
    'published', (select count(distinct org_id) from assignments where created_at >= since),
    'pages', (select coalesce(jsonb_agg(p), '[]') from (select path, count(*) as views from page_views where ts >= since group by path order by 2 desc limit 8) p)
  );
end $$;
grant execute on function public.admin_overview to authenticated;

create or replace function public.admin_accounts() returns table (
  id uuid, name text, owner_name text, owner_email text, types text, locations bigint, workers bigint,
  created_at timestamptz, last_active_at timestamptz, status text)
language sql stable security definer set search_path = public, auth as $$
  select o.id, o.name, o.owner_name, u.email::text,
    (select string_agg(distinct case l.type when 'hotel' then 'Hotel' else 'Gas station' end, ' + ') from locations l where l.org_id = o.id),
    (select count(*) from locations l where l.org_id = o.id),
    (select count(*) from employees e where e.org_id = o.id),
    o.created_at, o.last_active_at, o.status
  from organizations o left join auth.users u on u.id = o.owner_id
  where is_admin()
  order by o.created_at desc
$$;
grant execute on function public.admin_accounts to authenticated;

-- ---------------------------------------------------------------- realtime

alter publication supabase_realtime add table public.assignments, public.time_off_requests, public.notifications;
