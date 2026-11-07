-- Plans v2: Starter 2 locations, Plus 5, Premium 10. More than 10: support sets a custom limit per business.

alter table public.organizations add column if not exists location_limit int check (location_limit is null or location_limit between 1 and 1000);

create or replace function public.plan_locations(p_plan text) returns int
language sql immutable as $$ select case p_plan when 'free' then 2 when 'plus' then 5 else 10 end $$;

-- The limit for one business: a custom limit from support, or the plan's.
create or replace function public.location_limit_of(p_org uuid) returns int
language sql stable security definer set search_path = public as $$
  select coalesce(o.location_limit, plan_locations(plan_of(o.id))) from organizations o where o.id = p_org
$$;
grant execute on function public.location_limit_of(uuid) to authenticated;

-- Owners can't change their plan or limit themselves.
create or replace function public.guard_plan() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if is_admin() or coalesce(current_setting('sys.plan_ok', true), '') = '1' then return new; end if;
  if tg_op = 'INSERT' then
    new.plan := 'free'; new.plan_until := null; new.plan_source := null; new.location_limit := null;
  elsif (new.plan, new.plan_until, new.plan_source, new.location_limit) is distinct from (old.plan, old.plan_until, old.plan_source, old.location_limit) then
    raise exception 'Your plan changes only with a coupon code or through support.';
  end if;
  return new;
end $$;

create or replace function public.check_location_limit() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_plan text; v_max int; v_n int; v_custom int;
begin
  if is_admin() then return new; end if;
  v_plan := coalesce(plan_of(new.org_id), 'free');
  select location_limit into v_custom from organizations where id = new.org_id;
  v_max := coalesce(v_custom, plan_locations(v_plan));
  select count(*) into v_n from locations where org_id = new.org_id;
  if v_n >= v_max then
    if v_custom is not null or v_plan = 'premium' then
      raise exception 'Your plan includes % locations. For more, contact support@splityourshift.com and we''ll set it up.', v_max;
    end if;
    raise exception 'Your % plan includes % locations. Upgrade in Plan & billing to add more.',
      case v_plan when 'free' then 'Starter' else 'Plus' end, v_max;
  end if;
  return new;
end $$;

-- Admin: plan, end date and (optional) a custom location limit.
drop function if exists public.admin_set_plan(uuid, text, timestamptz);
create or replace function public.admin_set_plan(p_org uuid, p_plan text, p_until timestamptz default null, p_limit int default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Only the SplitYourShift admin can change a plan.'; end if;
  if p_plan not in ('free', 'plus', 'premium') then raise exception 'Pick Starter, Plus or Premium.'; end if;
  update organizations set plan = p_plan, plan_until = case when p_plan = 'free' then null else p_until end,
    plan_source = case when p_plan = 'free' then null else 'admin' end, location_limit = p_limit where id = p_org;
end $$;
revoke execute on function public.admin_set_plan(uuid, text, timestamptz, int) from public, anon;
grant execute on function public.admin_set_plan(uuid, text, timestamptz, int) to authenticated;

drop function if exists public.admin_accounts();
create function public.admin_accounts() returns table (
  id uuid, name text, owner_name text, owner_email text, types text, locations bigint, workers bigint,
  created_at timestamptz, last_active_at timestamptz, status text, plan text, plan_until timestamptz, plan_source text, plan_now text, location_limit int)
language sql stable security definer set search_path = public, auth as $$
  select o.id, o.name, o.owner_name, u.email::text,
    (select string_agg(distinct case l.type when 'hotel' then 'Hotel' when 'gas' then 'Gas station' else 'Shop' end, ' + ') from locations l where l.org_id = o.id),
    (select count(*) from locations l where l.org_id = o.id),
    (select count(*) from employees e where e.org_id = o.id),
    o.created_at, o.last_active_at, o.status, o.plan, o.plan_until, o.plan_source, plan_of(o.id), o.location_limit
  from organizations o left join auth.users u on u.id = o.owner_id
  where is_admin()
  order by o.created_at desc
$$;
grant execute on function public.admin_accounts to authenticated;
