-- Every owner is on their own staff list automatically (owners often work shifts too).
-- New business → owner's worker profile is created; new location → the owner works there too.

create or replace function public.add_owner_worker() returns trigger
language plpgsql security definer set search_path = public as $$
declare em text;
begin
  if exists (select 1 from employees where org_id = new.id and user_id = new.owner_id) then return new; end if;
  select email into em from auth.users where id = new.owner_id;
  insert into employees (org_id, user_id, name, email, max_shifts, rate, hue)
  values (new.id, new.owner_id, coalesce(nullif(trim(new.owner_name), ''), split_part(coalesce(em, 'Owner'), '@', 1)), em, 7, 0, 30);
  return new;
end $$;
create trigger owner_worker after insert on public.organizations for each row execute function public.add_owner_worker();

create or replace function public.owner_works_new_location() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into employee_locations (employee_id, location_id)
  select e.id, new.id from employees e join organizations o on o.id = e.org_id and o.owner_id = e.user_id
  where e.org_id = new.org_id
  on conflict do nothing;
  return new;
end $$;
create trigger owner_location after insert on public.locations for each row execute function public.owner_works_new_location();

-- Businesses that already exist: link the worker with the owner's email, otherwise create the profile.
update public.employees e set user_id = o.owner_id
from public.organizations o, auth.users u
where e.org_id = o.id and u.id = o.owner_id and e.user_id is null and lower(e.email) = lower(u.email)
  and not exists (select 1 from public.employees x where x.org_id = o.id and x.user_id = o.owner_id)
  and e.id = (select min(y.id::text)::uuid from public.employees y where y.org_id = o.id and y.user_id is null and lower(y.email) = lower(u.email));

insert into public.employees (org_id, user_id, name, email, max_shifts, rate, hue)
select o.id, o.owner_id, coalesce(nullif(trim(o.owner_name), ''), split_part(coalesce(u.email, 'Owner'), '@', 1)), u.email, 7, 0, 30
from public.organizations o left join auth.users u on u.id = o.owner_id
where not exists (select 1 from public.employees x where x.org_id = o.id and x.user_id = o.owner_id);

insert into public.employee_locations (employee_id, location_id)
select e.id, l.id from public.employees e
join public.organizations o on o.id = e.org_id and o.owner_id = e.user_id
join public.locations l on l.org_id = o.id
on conflict do nothing;
