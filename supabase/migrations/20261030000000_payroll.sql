-- Payroll per business. Each location (hotel, gas station or shop) has its own pay schedule:
--   weekly / biweekly: periods start on pay_anchor and repeat every 7 / 14 days; payday is the first
--                      pay_weekday after the period ends (e.g. Oct 12 – 25 → Friday Oct 30).
--   monthly:           calendar months; payday is pay_month_day (31 = last day; a short month uses its last day)
--                      of the same month (offset 0) or the next month (offset 1).
-- Hours come from finished time entries (work_date is the business's local date). Overtime: 1.5× over 40 hours
-- in a workweek; workweeks start on the pay period's start weekday. In monthly payroll a week that crosses
-- the month boundary is counted in two parts.
-- "Mark as paid" stores a snapshot; later changes to settings, rates or hours never change a paid payroll.
-- Only a SplitYourShift admin can reopen a paid payroll, and every paid / reopen action is logged.

alter table public.locations
  add column if not exists pay_frequency text not null default 'weekly' check (pay_frequency in ('weekly', 'biweekly', 'monthly')),
  add column if not exists pay_anchor date not null default (date_trunc('week', now())::date),
  add column if not exists pay_weekday smallint not null default 4 check (pay_weekday between 0 and 6),
  add column if not exists pay_month_day smallint not null default 31 check (pay_month_day between 1 and 31),
  add column if not exists pay_month_offset smallint not null default 1 check (pay_month_offset in (0, 1)),
  add column if not exists overtime boolean not null default true;

-- Start from the business-wide settings used until now.
update public.locations l
set pay_frequency = o.pay_period, pay_anchor = o.pay_anchor, pay_weekday = o.pay_weekday, overtime = o.overtime
from public.organizations o where o.id = l.org_id;

create table public.payroll_adjustments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations on delete cascade,
  location_id uuid not null references public.locations on delete cascade,
  employee_id uuid not null references public.employees on delete cascade,
  period_start date not null,
  kind text not null check (kind in ('bonus', 'deduction')),
  amount numeric(10, 2) not null check (amount >= 0),
  note text,
  created_at timestamptz not null default now(),
  unique (location_id, employee_id, period_start, kind)
);

create table public.payroll_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations on delete cascade,
  location_id uuid not null references public.locations on delete cascade,
  location_name text not null,
  frequency text not null,
  period_start date not null,
  period_end date not null,
  pay_date date not null,
  status text not null default 'paid' check (status in ('paid', 'reopened')),
  lines jsonb not null,
  employees int not null,
  hours numeric(10, 2) not null,
  total_gross numeric(12, 2) not null,
  total_net numeric(12, 2) not null,
  paid_at timestamptz not null default now(),
  paid_by uuid,
  reopened_at timestamptz,
  reopened_by uuid,
  reopen_reason text
);
create unique index payroll_runs_one_paid on public.payroll_runs (location_id, period_start) where status = 'paid';
create index payroll_runs_org on public.payroll_runs (org_id, period_start desc);

create table public.payroll_audit (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations on delete cascade,
  run_id uuid references public.payroll_runs on delete cascade,
  action text not null,
  actor uuid,
  reason text,
  at timestamptz not null default now()
);

create table public.payroll_reminders_sent (
  location_id uuid not null references public.locations on delete cascade,
  period_start date not null,
  kind text not null,
  primary key (location_id, period_start, kind)
);

alter table public.payroll_adjustments enable row level security;
alter table public.payroll_runs enable row level security;
alter table public.payroll_audit enable row level security;
alter table public.payroll_reminders_sent enable row level security;
create policy "read" on public.payroll_adjustments for select using (owns_org(org_id) or is_admin() or employee_id in (select my_employee_ids()));
create policy "owner writes" on public.payroll_adjustments for all using (owns_org(org_id)) with check (owns_org(org_id));
create policy "read" on public.payroll_runs for select using (owns_org(org_id) or is_admin());
create policy "read" on public.payroll_audit for select using (owns_org(org_id) or is_admin());

-- A paid payroll is locked: no bonus or deduction changes until an admin reopens it.
create or replace function public.payroll_adjustment_lock() returns trigger
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  r := coalesce(new, old);
  -- Deleting a business or a worker removes their adjustments too; that isn't an edit of a paid payroll.
  if tg_op = 'DELETE' and (not exists (select 1 from locations where id = old.location_id)
      or not exists (select 1 from employees where id = old.employee_id)) then return old; end if;
  if exists (select 1 from payroll_runs where location_id = r.location_id and period_start = r.period_start and status = 'paid') then
    raise exception 'This payroll is marked paid, so it can''t be changed. Contact SplitYourShift support to reopen it.';
  end if;
  return coalesce(new, old);
end $$;
create trigger payroll_adjustment_lock before insert or update or delete on public.payroll_adjustments
  for each row execute function public.payroll_adjustment_lock();

-- Local "today" for a business.
create or replace function public.org_today(p_org uuid) returns date
language sql stable security definer set search_path = public as $$
  select (now() at time zone coalesce((select time_zone from organizations where id = p_org), 'America/Chicago'))::date
$$;

-- Pay periods around a date: k = 0 is the period that contains p_around.
create or replace function public.pay_periods(p_loc uuid, p_around date, p_before int default 0, p_after int default 0)
returns table (period_start date, period_end date, pay_date date)
language plpgsql stable security definer set search_path = public as $$
declare l locations; len int; k0 int; k int; s date; e date; pm date;
begin
  select * into l from locations where id = p_loc;
  if l.id is null then return; end if;
  if not (member_org(l.org_id) or is_admin() or auth.uid() is null) then raise exception 'Not allowed.'; end if;
  for k in -p_before .. p_after loop
    if l.pay_frequency = 'monthly' then
      s := (date_trunc('month', p_around) + make_interval(months => k))::date;
      e := (s + interval '1 month' - interval '1 day')::date;
      pm := (s + make_interval(months => l.pay_month_offset))::date;
      pay_date := least(pm + (l.pay_month_day - 1), (pm + interval '1 month' - interval '1 day')::date);
    else
      len := case when l.pay_frequency = 'biweekly' then 14 else 7 end;
      k0 := floor((p_around - l.pay_anchor)::numeric / len);
      s := l.pay_anchor + (k0 + k) * len;
      e := s + len - 1;
      pay_date := e + coalesce(nullif(((l.pay_weekday - (extract(isodow from e)::int - 1)) % 7 + 7) % 7, 0), 7);
    end if;
    period_start := s; period_end := e;
    return next;
  end loop;
end $$;

-- One line per worker for a business and period. Entries without a shift count at the worker's first location.
create or replace function public.payroll_lines(p_loc uuid, p_start date, p_end date, p_emp uuid default null)
returns table (employee_id uuid, name text, rate numeric, hours numeric, regular_hours numeric, overtime_hours numeric,
  regular_pay numeric, overtime_pay numeric, bonus numeric, deduction numeric, gross numeric, net numeric, open_entries int)
language sql stable security definer set search_path = public as $$
  with l as (
    select * from locations where id = p_loc
      and (owns_org(org_id) or is_admin() or auth.uid() is null or (p_emp is not null and p_emp in (select my_employee_ids())))
  ),
  ent as (
    select t.employee_id, t.clock_out, t.work_date,
      round((extract(epoch from (t.clock_out - t.clock_in)) / 3600)::numeric, 2) as h
    from time_entries t
    join l on l.org_id = t.org_id
    left join shift_slots s on s.id = t.slot_id
    where t.work_date between p_start and p_end
      and (p_emp is null or t.employee_id = p_emp)
      and coalesce(s.location_id, (select el.location_id from employee_locations el join locations x on x.id = el.location_id
                                   where el.employee_id = t.employee_id order by x.sort, x.created_at limit 1)) = l.id
  ),
  wk as (
    select e.employee_id, e.work_date - (((e.work_date - l.pay_anchor) % 7 + 7) % 7) as week, sum(e.h) as h
    from ent e, l where e.clock_out is not null group by 1, 2
  ),
  per as (
    select w.employee_id, sum(w.h) as hours, sum(case when l.overtime then greatest(w.h - 40, 0) else 0 end) as ot
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
    select e.id, e.name, e.rate, coalesce(p.hours, 0) as hours, coalesce(p.hours - p.ot, 0) as reg, coalesce(p.ot, 0) as ot,
      coalesce(a.bonus, 0) as bonus, coalesce(a.deduction, 0) as deduction,
      (select count(*) from ent x where x.employee_id = e.id and x.clock_out is null)::int as open_entries
    from who join employees e on e.id = who.employee_id
    left join per p on p.employee_id = e.id
    left join adj a on a.employee_id = e.id
    where p_emp is null or e.id = p_emp
  )
  select id, name, rate, hours, reg, ot,
    round(reg * rate, 2), round(ot * rate * 1.5, 2), bonus, deduction,
    round(reg * rate, 2) + round(ot * rate * 1.5, 2) + bonus,
    round(reg * rate, 2) + round(ot * rate * 1.5, 2) + bonus - deduction,
    open_entries
  from calc order by name
$$;

-- Mark a pay period paid: stores the numbers as they are now. One paid record per business and period.
create or replace function public.mark_payroll_paid(p_loc uuid, p_start date) returns uuid
language plpgsql security definer set search_path = public as $$
declare l locations; p record; v_lines jsonb; v_open text; v_id uuid;
begin
  select * into l from locations where id = p_loc;
  if l.id is null or not owns_org(l.org_id) then raise exception 'Only the owner can do this.'; end if;
  if exists (select 1 from organizations where id = l.org_id and status = 'suspended') then
    raise exception 'This account is suspended. Contact SplitYourShift support.';
  end if;
  select * into p from pay_periods(p_loc, p_start) limit 1;
  if p.period_start is distinct from p_start then raise exception 'That isn''t a pay period for %. Refresh the page.', l.name; end if;
  if exists (select 1 from payroll_runs where location_id = p_loc and period_start = p_start and status = 'paid') then
    raise exception 'This payroll is already marked paid.';
  end if;
  select string_agg(x.name, ', ') into v_open from payroll_lines(p_loc, p.period_start, p.period_end) x where x.open_entries > 0;
  if v_open is not null then raise exception '% is still clocked in for this period. Clock them out or fix the hours first.', v_open; end if;
  select coalesce(jsonb_agg(to_jsonb(x) - 'open_entries' order by x.name), '[]'::jsonb) into v_lines
  from payroll_lines(p_loc, p.period_start, p.period_end) x;
  insert into payroll_runs (org_id, location_id, location_name, frequency, period_start, period_end, pay_date, lines,
    employees, hours, total_gross, total_net, paid_by)
  values (l.org_id, p_loc, l.name, l.pay_frequency, p.period_start, p.period_end, p.pay_date, v_lines,
    (select count(*) from jsonb_array_elements(v_lines) j where (j ->> 'hours')::numeric > 0 or (j ->> 'net')::numeric <> 0),
    (select coalesce(sum((j ->> 'hours')::numeric), 0) from jsonb_array_elements(v_lines) j),
    (select coalesce(sum((j ->> 'gross')::numeric), 0) from jsonb_array_elements(v_lines) j),
    (select coalesce(sum((j ->> 'net')::numeric), 0) from jsonb_array_elements(v_lines) j),
    auth.uid())
  returning id into v_id;
  insert into payroll_audit (org_id, run_id, action, actor) values (l.org_id, v_id, 'paid', auth.uid());
  return v_id;
end $$;

-- Reopen a paid payroll (SplitYourShift admin only, with a reason). The paid record stays in history.
create or replace function public.reopen_payroll(p_run uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare r payroll_runs;
begin
  if not is_admin() then raise exception 'Only a SplitYourShift admin can reopen a paid payroll.'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Write why it is being reopened.'; end if;
  update payroll_runs set status = 'reopened', reopened_at = now(), reopened_by = auth.uid(), reopen_reason = trim(p_reason)
  where id = p_run and status = 'paid' returning * into r;
  if r.id is null then raise exception 'That payroll isn''t marked paid.'; end if;
  insert into payroll_audit (org_id, run_id, action, actor, reason) values (r.org_id, r.id, 'reopened', auth.uid(), trim(p_reason));
  perform notify_user(r.org_id, (select owner_id from organizations where id = r.org_id),
    'SplitYourShift support reopened the ' || r.location_name || ' payroll for ' || to_char(r.period_start, 'Mon DD') || ' – ' ||
    to_char(r.period_end, 'Mon DD') || ': ' || trim(p_reason));
end $$;

-- Payroll dashboard: one row per business.
create or replace function public.payroll_dashboard(p_org uuid)
returns table (location_id uuid, name text, type text, frequency text, cur_start date, cur_end date,
  next_start date, next_end date, next_pay_date date, next_paid boolean, employees int, hours numeric, payable numeric,
  pending int, completed int)
language plpgsql stable security definer set search_path = public as $$
declare l locations; today date; p record; n record;
begin
  if not (owns_org(p_org) or is_admin()) then raise exception 'Not allowed.'; end if;
  today := org_today(p_org);
  for l in select * from locations where org_id = p_org order by sort, created_at loop
    location_id := l.id; name := l.name; type := l.type; frequency := l.pay_frequency;
    select * into p from pay_periods(l.id, today) limit 1;
    cur_start := p.period_start; cur_end := p.period_end;
    select * into n from pay_periods(l.id, today, 3, 1) x where x.pay_date >= today order by x.pay_date limit 1;
    next_start := n.period_start; next_end := n.period_end; next_pay_date := n.pay_date;
    next_paid := exists (select 1 from payroll_runs r where r.location_id = l.id and r.period_start = n.period_start and r.status = 'paid');
    if next_paid then  -- a paid payroll shows what was paid
      select r.employees, r.hours, r.total_net into employees, hours, payable
      from payroll_runs r where r.location_id = l.id and r.period_start = n.period_start and r.status = 'paid';
    else
      select count(*) filter (where x.hours > 0 or x.net <> 0), coalesce(sum(x.hours), 0), coalesce(sum(x.net), 0)
        into employees, hours, payable from payroll_lines(l.id, n.period_start, n.period_end) x;
    end if;
    -- Pay days that have come (up to a year back, since the business started) without being marked paid.
    select count(*) into pending from pay_periods(l.id, today, 52, 0) x
      where x.pay_date <= today and x.period_end >= l.created_at::date
        and not exists (select 1 from payroll_runs r where r.location_id = l.id and r.period_start = x.period_start and r.status = 'paid');
    select count(*) into completed from payroll_runs r where r.location_id = l.id and r.status = 'paid';
    return next;
  end loop;
end $$;

-- A worker's own pay at each place they work: this period so far, and the next payday.
create or replace function public.my_pay(p_emp uuid)
returns table (location_id uuid, location_name text, cur_start date, cur_end date, cur_pay_date date, cur_hours numeric, cur_gross numeric,
  next_start date, next_end date, next_pay_date date, next_hours numeric, next_gross numeric, next_net numeric, next_paid boolean)
language plpgsql stable security definer set search_path = public as $$
declare e employees; l locations; today date; p record; n record; x record;
begin
  select * into e from employees where id = p_emp;
  if e.id is null or not (p_emp in (select my_employee_ids()) or owns_org(e.org_id) or is_admin()) then raise exception 'Not allowed.'; end if;
  today := org_today(e.org_id);
  for l in select lo.* from locations lo join employee_locations el on el.location_id = lo.id where el.employee_id = p_emp order by lo.sort, lo.created_at loop
    location_id := l.id; location_name := l.name;
    select * into p from pay_periods(l.id, today) limit 1;
    cur_start := p.period_start; cur_end := p.period_end; cur_pay_date := p.pay_date;
    select coalesce(sum(y.hours), 0), coalesce(sum(y.gross), 0) into cur_hours, cur_gross from payroll_lines(l.id, p.period_start, p.period_end, p_emp) y;
    select * into n from pay_periods(l.id, today, 3, 1) z where z.pay_date >= today order by z.pay_date limit 1;
    next_start := n.period_start; next_end := n.period_end; next_pay_date := n.pay_date;
    select * into x from payroll_runs r where r.location_id = l.id and r.period_start = n.period_start and r.status = 'paid';
    next_paid := x.id is not null;
    if next_paid then
      select coalesce(sum((j ->> 'hours')::numeric), 0), coalesce(sum((j ->> 'gross')::numeric), 0), coalesce(sum((j ->> 'net')::numeric), 0)
        into next_hours, next_gross, next_net from jsonb_array_elements(x.lines) j where (j ->> 'employee_id')::uuid = p_emp;
    else
      select coalesce(sum(y.hours), 0), coalesce(sum(y.gross), 0), coalesce(sum(y.net), 0)
        into next_hours, next_gross, next_net from payroll_lines(l.id, n.period_start, n.period_end, p_emp) y;
    end if;
    return next;
  end loop;
end $$;

-- Payday reminders for owners: 2 days before and on the day, until the payroll is marked paid.
create or replace function public.payroll_due_reminders()
returns table (user_id uuid, kind text, title text, body text)
language plpgsql security definer set search_path = public as $$
declare l record; n record; today date; k text; v_emps int; v_total numeric;
begin
  for l in select lo.*, o.owner_id, o.name as org_name from locations lo join organizations o on o.id = lo.org_id where o.status = 'active' loop
    today := org_today(l.org_id);
    for n in select * from pay_periods(l.id, today, 3, 1) x where x.pay_date in (today, today + 2) loop
      if exists (select 1 from payroll_runs r where r.location_id = l.id and r.period_start = n.period_start and r.status = 'paid') then continue; end if;
      k := case when n.pay_date = today then 'day' else 'before' end;
      insert into payroll_reminders_sent values (l.id, n.period_start, k) on conflict do nothing;
      if not found then continue; end if;
      select count(*) filter (where x.hours > 0 or x.net <> 0), coalesce(sum(x.net), 0) into v_emps, v_total
        from payroll_lines(l.id, n.period_start, n.period_end) x;
      user_id := l.owner_id; kind := 'payroll-' || k;
      title := case when k = 'day' then 'Payday today: ' else 'Payday in 2 days: ' end || l.name;
      body := l.name || ' payroll for ' || to_char(n.period_start, 'Mon DD') || ' – ' || to_char(n.period_end, 'Mon DD') ||
        ', paid ' || to_char(n.pay_date, 'Dy Mon DD') || ': ' || v_emps || ' employee' || case when v_emps = 1 then '' else 's' end ||
        ', $' || to_char(v_total, 'FM999,999,990.00') || ' to pay.';
      perform notify_user(l.org_id, l.owner_id, title || '. ' || body);
      return next;
    end loop;
  end loop;
end $$;

revoke execute on function public.pay_periods(uuid, date, int, int), public.payroll_lines(uuid, date, date, uuid),
  public.mark_payroll_paid(uuid, date), public.reopen_payroll(uuid, text), public.payroll_dashboard(uuid),
  public.my_pay(uuid), public.org_today(uuid), public.payroll_due_reminders() from public, anon;
grant execute on function public.pay_periods(uuid, date, int, int), public.payroll_lines(uuid, date, date, uuid),
  public.mark_payroll_paid(uuid, date), public.reopen_payroll(uuid, text), public.payroll_dashboard(uuid),
  public.my_pay(uuid), public.org_today(uuid) to authenticated;
revoke execute on function public.payroll_due_reminders() from authenticated;
grant execute on function public.payroll_due_reminders() to service_role;

alter publication supabase_realtime add table public.payroll_runs;
