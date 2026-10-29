-- Owners often work shifts too. This gives the owner a worker profile tied to their own login,
-- so they can switch to the worker view and clock in/out without inviting themselves.
--   p_emp given: "that worker on my staff list is me" (moves the link there).
--   p_emp null:  reuse the profile already linked, else one with the owner's email, else create one.
create or replace function public.my_worker_profile(p_org uuid, p_emp uuid default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare o organizations; e uuid; em text;
begin
  select * into o from organizations where id = p_org;
  if o.id is null or o.owner_id <> auth.uid() then raise exception 'Only the owner can do this.'; end if;
  select email into em from auth.users where id = auth.uid();

  if p_emp is not null then
    if not exists (select 1 from employees where id = p_emp and org_id = p_org and (user_id is null or user_id = auth.uid())) then
      raise exception 'That worker already has their own login.';
    end if;
    update employees set user_id = null where org_id = p_org and user_id = auth.uid() and id <> p_emp;
    update employees set user_id = auth.uid() where id = p_emp;
    return p_emp;
  end if;

  select id into e from employees where org_id = p_org and user_id = auth.uid();
  if e is not null then return e; end if;

  select id into e from employees where org_id = p_org and user_id is null and lower(email) = lower(em) order by created_at limit 1;
  if e is not null then
    update employees set user_id = auth.uid() where id = e;
    return e;
  end if;

  insert into employees (org_id, user_id, name, email, max_shifts, rate, hue)
  values (p_org, auth.uid(), coalesce(nullif(trim(o.owner_name), ''), split_part(em, '@', 1)), em, 7, 0, 30)
  returning id into e;
  insert into employee_locations (employee_id, location_id) select e, id from locations where org_id = p_org;
  return e;
end $$;
revoke all on function public.my_worker_profile(uuid, uuid) from public, anon;
grant execute on function public.my_worker_profile(uuid, uuid) to authenticated;
