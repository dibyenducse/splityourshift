-- Short names on the schedule. The owner picks how names show (first name, last name, first name + last
-- initial, or each worker's own short name); the full name shows on hover. Workers see the same names.
alter table public.organizations add column if not exists name_display text not null default 'first'
  check (name_display in ('first', 'last', 'first_initial', 'custom'));
alter table public.employees add column if not exists short_name text check (short_name is null or length(trim(short_name)) between 1 and 20);

-- Coworkers (what workers can see of each other) now include the short name.
create or replace view public.coworkers as
  select e.id, e.org_id, e.name, e.hue, e.short_name from public.employees e where member_org(e.org_id) or is_admin();
grant select on public.coworkers to authenticated;
