-- Shift reports and task lists.
--   shift_reports: a note a worker leaves for their shift (for the next shift and the manager). Everyone at the
--                  business can read them by date; only the writer edits their own. The owner is notified.
--   shift_tasks:   the owner's to-do list for a shift (a specific shift, or any shift at a location),
--                  every day or on one date.
--   task_checks:   who ticked a task off, for which date.

create table public.shift_reports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations on delete cascade,
  location_id uuid references public.locations on delete cascade,
  slot_id uuid references public.shift_slots on delete set null,
  work_date date not null,
  employee_id uuid not null references public.employees on delete cascade,
  body text not null check (length(trim(body)) between 1 and 4000),
  created_at timestamptz not null default now(),
  updated_at timestamptz
);
create index shift_reports_day on public.shift_reports (org_id, work_date);

create table public.shift_tasks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations on delete cascade,
  location_id uuid not null references public.locations on delete cascade,
  slot_id uuid references public.shift_slots on delete cascade,   -- null = any shift at this location
  title text not null check (length(trim(title)) between 1 and 200),
  notes text,
  repeat text not null default 'daily' check (repeat in ('daily', 'once')),
  on_date date,                                                    -- for repeat = 'once'
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check (repeat = 'daily' or on_date is not null)
);
create index shift_tasks_org on public.shift_tasks (org_id) where active;

create table public.task_checks (
  task_id uuid not null references public.shift_tasks on delete cascade,
  work_date date not null,
  org_id uuid not null references public.organizations on delete cascade,
  employee_id uuid not null references public.employees on delete cascade,
  done_at timestamptz not null default now(),
  primary key (task_id, work_date)
);

alter table public.shift_reports enable row level security;
alter table public.shift_tasks enable row level security;
alter table public.task_checks enable row level security;

create policy "read" on public.shift_reports for select using (member_org(org_id) or is_admin());
create policy "write own" on public.shift_reports for insert with check (
  exists (select 1 from employees e where e.id = employee_id and e.org_id = shift_reports.org_id and e.user_id = auth.uid()));
create policy "edit own" on public.shift_reports for update using (employee_id in (select my_employee_ids()))
  with check (employee_id in (select my_employee_ids()));
create policy "delete own or owner" on public.shift_reports for delete using (employee_id in (select my_employee_ids()) or owns_org(org_id));

create policy "read" on public.shift_tasks for select using (member_org(org_id) or is_admin());
create policy "owner writes" on public.shift_tasks for all using (owns_org(org_id)) with check (owns_org(org_id));

create policy "read" on public.task_checks for select using (member_org(org_id) or is_admin());
create policy "tick own" on public.task_checks for insert with check (
  exists (select 1 from employees e join shift_tasks t on t.id = task_id
          where e.id = employee_id and e.user_id = auth.uid() and e.org_id = t.org_id and t.org_id = task_checks.org_id));
create policy "untick own or owner" on public.task_checks for delete using (employee_id in (select my_employee_ids()) or owns_org(org_id));

-- Tell the owner about every new shift report.
create or replace function public.shift_report_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_name text; v_owner uuid;
begin
  select name into v_name from employees where id = new.employee_id;
  select owner_id into v_owner from organizations where id = new.org_id;
  if v_owner is distinct from auth.uid() then
    perform notify_user(new.org_id, v_owner, v_name || ' wrote a shift report for ' ||
      coalesce(slot_label(new.slot_id, new.work_date), to_char(new.work_date, 'Dy MM/DD') || coalesce(' · ' || (select name from locations where id = new.location_id), '')) ||
      ': "' || left(regexp_replace(new.body, '\s+', ' ', 'g'), 90) || case when length(new.body) > 90 then '…' else '' end || '"');
  end if;
  return new;
end $$;
create trigger shift_report_notify after insert on public.shift_reports for each row execute function public.shift_report_notify();

alter publication supabase_realtime add table public.shift_reports, public.task_checks;
