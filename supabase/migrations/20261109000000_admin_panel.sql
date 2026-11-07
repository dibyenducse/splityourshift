-- Admin panel: editable plan catalog, an audit log of admin actions, dashboard stats and a users list.

-- ---------------------------------------------------------------- plan catalog (prices, limits, wording)
create table if not exists public.plan_catalog (
  id text primary key check (id in ('free', 'plus', 'premium')),
  name text not null check (length(name) between 1 and 40),
  price_month numeric(8, 2) not null check (price_month >= 0),
  price_year numeric(9, 2) not null check (price_year >= 0),
  locations int not null check (locations between 1 and 1000),
  blurb text not null default '',
  features text[] not null default '{}',
  popular boolean not null default false,
  sort int not null default 0,
  updated_at timestamptz not null default now()
);
insert into public.plan_catalog (id, name, price_month, price_year, locations, blurb, features, popular, sort) values
  ('free', 'Starter', 19, 199, 2, 'One or two hotels, gas stations or shops', array['Up to 2 locations', 'Drag-and-drop schedule, swaps, time off', 'Time clock and payroll', 'Shift reports and task lists'], false, 0),
  ('plus', 'Plus', 39, 399, 5, 'A growing group under one account', array['Up to 5 locations', 'Everything in Starter', 'Share workers between locations', 'Payroll for each business'], true, 1),
  ('premium', 'Premium', 59, 599, 10, 'For groups with many locations', array['Up to 10 locations', 'Everything in Plus', 'Priority support', 'More than 10? Contact us'], false, 2)
on conflict (id) do nothing;
alter table public.plan_catalog enable row level security;
drop policy if exists plan_catalog_read on public.plan_catalog;
create policy plan_catalog_read on public.plan_catalog for select using (true);
drop policy if exists plan_catalog_admin on public.plan_catalog;
create policy plan_catalog_admin on public.plan_catalog for update using (is_admin()) with check (is_admin());
grant select on public.plan_catalog to anon, authenticated;

-- Location limits come from the catalog now.
create or replace function public.plan_locations(p_plan text) returns int
language sql stable security definer set search_path = public as $$
  select coalesce((select locations from plan_catalog where id = p_plan), case p_plan when 'free' then 2 when 'plus' then 5 else 10 end)
$$;

create or replace function public.check_location_limit() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_plan text; v_max int; v_n int; v_custom int; v_name text;
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
    select name into v_name from plan_catalog where id = v_plan;
    raise exception 'Your % plan includes % locations. Upgrade in Plan & billing to add more.', coalesce(v_name, 'current'), v_max;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------- audit log
create table if not exists public.admin_audit (
  id bigint generated always as identity primary key,
  admin_id uuid,
  admin_email text,
  action text not null,
  target_type text,
  target_id text,
  target_name text,
  detail jsonb,
  created_at timestamptz not null default now()
);
create index if not exists admin_audit_created on public.admin_audit (created_at desc);
alter table public.admin_audit enable row level security;
drop policy if exists admin_audit_read on public.admin_audit;
create policy admin_audit_read on public.admin_audit for select using (is_admin());

create or replace function public.admin_log(p_action text, p_type text, p_id text, p_name text, p_detail jsonb default null) returns void
language plpgsql security definer set search_path = public, auth as $$
begin
  if not is_admin() then return; end if;
  insert into admin_audit (admin_id, admin_email, action, target_type, target_id, target_name, detail)
  values (auth.uid(), (select email from auth.users where id = auth.uid()), p_action, p_type, p_id, p_name, p_detail);
end $$;
revoke execute on function public.admin_log(text, text, text, text, jsonb) from public, anon;

-- Log what admins change (triggers, so nothing is missed).
create or replace function public.audit_admin_changes() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then return new; end if;
  if tg_table_name = 'plan_catalog' then
    perform admin_log('plan.edit', 'plan', new.id, new.name, jsonb_build_object(
      'before', jsonb_build_object('name', old.name, 'month', old.price_month, 'year', old.price_year, 'locations', old.locations),
      'after', jsonb_build_object('name', new.name, 'month', new.price_month, 'year', new.price_year, 'locations', new.locations)));
    new.updated_at := now();
  elsif tg_table_name = 'organizations' then
    if new.status is distinct from old.status then
      perform admin_log(case when new.status = 'suspended' then 'business.suspend' else 'business.reactivate' end, 'business', new.id::text, new.name, null);
    end if;
    if (new.plan, new.plan_until, new.location_limit) is distinct from (old.plan, old.plan_until, old.location_limit) then
      perform admin_log('business.plan', 'business', new.id::text, new.name, jsonb_build_object('plan', new.plan, 'until', new.plan_until, 'location_limit', new.location_limit));
    end if;
  elsif tg_table_name = 'coupons' then
    if tg_op = 'INSERT' then perform admin_log('coupon.create', 'coupon', new.id::text, new.code, jsonb_build_object('plan', new.plan, 'months', new.months, 'max_uses', new.max_uses));
    elsif new.active is distinct from old.active then perform admin_log(case when new.active then 'coupon.on' else 'coupon.off' end, 'coupon', new.id::text, new.code, null); end if;
  end if;
  return new;
end $$;
drop trigger if exists audit_plan_catalog on public.plan_catalog;
create trigger audit_plan_catalog before update on public.plan_catalog for each row execute function public.audit_admin_changes();
drop trigger if exists audit_organizations on public.organizations;
create trigger audit_organizations after update on public.organizations for each row execute function public.audit_admin_changes();
drop trigger if exists audit_coupons on public.coupons;
create trigger audit_coupons after insert or update on public.coupons for each row execute function public.audit_admin_changes();

-- ---------------------------------------------------------------- dashboard
create or replace function public.admin_stats(p_days int default 30) returns jsonb
language plpgsql stable security definer set search_path = public, auth as $$
declare since timestamptz := date_trunc('day', now()) - make_interval(days => greatest(p_days, 1) - 1);
  prev timestamptz := since - make_interval(days => greatest(p_days, 1));
begin
  if not is_admin() then raise exception 'Admins only.'; end if;
  return jsonb_build_object(
    'days', p_days,
    'owners', (select count(*) from organizations),
    'signups', (select count(*) from organizations where created_at >= since),
    'signups_prev', (select count(*) from organizations where created_at >= prev and created_at < since),
    'active_7d', (select count(*) from organizations where last_active_at >= now() - interval '7 days'),
    'suspended', (select count(*) from organizations where status = 'suspended'),
    'locations', (select count(*) from locations),
    'loc_types', jsonb_build_object('hotel', (select count(*) from locations where type = 'hotel'), 'gas', (select count(*) from locations where type = 'gas'), 'shop', (select count(*) from locations where type = 'shop')),
    'workers', (select count(*) from employees),
    'workers_new', (select count(*) from employees where created_at >= since),
    'worker_logins', (select count(*) from employees where user_id is not null),
    'users', (select count(*) from auth.users),
    'blocked', (select count(*) from auth.users where banned_until > now()),
    'plans', (select coalesce(jsonb_object_agg(p, n), '{}') from (select plan_of(id) p, count(*) n from organizations group by 1) x),
    'plan_value', (select coalesce(sum(c.price_month), 0) from organizations o join plan_catalog c on c.id = plan_of(o.id) where o.status = 'active'),
    'paid_plans', (select count(*) from organizations o where plan_of(o.id) <> 'free'),
    'coupons_used', (select count(*) from coupon_redemptions where created_at >= since),
    'clocked_orgs', (select count(distinct org_id) from time_entries where clock_in >= now() - interval '7 days'),
    'payrolls_paid', (select count(*) from payroll_runs where status = 'paid' and paid_at >= since),
    'swaps', (select count(*) from shift_adjustments where created_at >= since),
    'reports', (select count(*) from shift_reports where created_at >= since),
    'visitors', (select count(distinct visitor || date_trunc('day', ts)::text) from page_views where ts >= since),
    'signup_views', (select count(distinct visitor) from page_views where ts >= since and path like '%signup%'),
    'onboarded', (select count(*) from organizations o where created_at >= since and exists (select 1 from locations l where l.org_id = o.id)),
    'scheduled', (select count(*) from organizations o where created_at >= since and exists (select 1 from assignments a where a.org_id = o.id)),
    'daily', (select coalesce(jsonb_agg(jsonb_build_object('day', d::date, 'visitors', coalesce(v.n, 0), 'signups', coalesce(s.n, 0)) order by d), '[]')
      from generate_series(since, date_trunc('day', now()), interval '1 day') d
      left join (select date_trunc('day', ts) as dd, count(distinct visitor) as n from page_views where ts >= since group by 1) v on v.dd = d
      left join (select date_trunc('day', created_at) as dd, count(*) as n from organizations where created_at >= since group by 1) s on s.dd = d),
    'recent', (select coalesce(jsonb_agg(r), '[]') from (select o.id, o.name, u.email, o.created_at, plan_of(o.id) plan,
        (select count(*) from locations l where l.org_id = o.id) locations, (select count(*) from employees e where e.org_id = o.id) workers
      from organizations o left join auth.users u on u.id = o.owner_id order by o.created_at desc limit 8) r),
    'pages', (select coalesce(jsonb_agg(p), '[]') from (select path, count(*) views from page_views where ts >= since group by path order by 2 desc limit 8) p)
  );
end $$;
grant execute on function public.admin_stats(int) to authenticated;

-- ---------------------------------------------------------------- users (every login)
create or replace function public.admin_users() returns table (id uuid, email text, name text, phone text, role text, business text, org_id uuid,
  created_at timestamptz, last_sign_in_at timestamptz, banned_until timestamptz, confirmed boolean)
language sql stable security definer set search_path = public, auth as $$
  select u.id, u.email::text,
    coalesce(o.owner_name, e.name, u.raw_user_meta_data ->> 'name'), coalesce(e.phone, u.phone::text),
    case when pa.user_id is not null then 'admin' when o.id is not null then 'owner' when e.id is not null then 'worker' else 'new' end,
    coalesce(o.name, eo.name), coalesce(o.id, e.org_id),
    u.created_at, u.last_sign_in_at, u.banned_until, u.email_confirmed_at is not null
  from auth.users u
  left join platform_admins pa on pa.user_id = u.id
  left join lateral (select * from organizations where owner_id = u.id order by created_at limit 1) o on true
  left join lateral (select * from employees where user_id = u.id order by created_at limit 1) e on true
  left join organizations eo on eo.id = e.org_id
  where is_admin()
  order by u.created_at desc
$$;
grant execute on function public.admin_users() to authenticated;
