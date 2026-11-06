-- Plans and coupons.
--   Starter (free): 1 location · Plus ($39/month): up to 3 locations · Premium ($99/month): unlimited.
--   There is no card payment yet: a paid plan comes from a coupon code (1, 2, 3… months) or from the admin.
--   When a paid plan ends, nothing is deleted or locked; only adding locations beyond the plan is stopped.

alter table public.organizations
  add column if not exists plan text not null default 'free' check (plan in ('free', 'plus', 'premium')),
  add column if not exists plan_until timestamptz,          -- null with a paid plan: no end date (set by the admin)
  add column if not exists plan_source text;                -- 'coupon', 'admin' or 'early_access'

-- Owners can't give themselves a plan: only the admin, or the functions below (which set sys.plan_ok).
create or replace function public.guard_plan() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if is_admin() or coalesce(current_setting('sys.plan_ok', true), '') = '1' then return new; end if;
  if tg_op = 'INSERT' then
    new.plan := 'free'; new.plan_until := null; new.plan_source := null;
  elsif (new.plan, new.plan_until, new.plan_source) is distinct from (old.plan, old.plan_until, old.plan_source) then
    raise exception 'Your plan changes only with a coupon code or through support.';
  end if;
  return new;
end $$;
drop trigger if exists guard_plan on public.organizations;
create trigger guard_plan before insert or update on public.organizations for each row execute function public.guard_plan();

-- The plan in force right now (a paid plan that has ended counts as free).
create or replace function public.plan_of(p_org uuid) returns text
language sql stable security definer set search_path = public as $$
  select case when o.plan <> 'free' and (o.plan_until is null or o.plan_until > now()) then o.plan else 'free' end
  from organizations o where o.id = p_org
$$;
create or replace function public.plan_locations(p_plan text) returns int
language sql immutable as $$ select case p_plan when 'free' then 1 when 'plus' then 3 else null end $$;
create or replace function public.plan_rank(p_plan text) returns int
language sql immutable as $$ select case p_plan when 'premium' then 2 when 'plus' then 1 else 0 end $$;
grant execute on function public.plan_of(uuid), public.plan_locations(text), public.plan_rank(text) to authenticated;

-- Adding a location beyond the plan is stopped (existing locations are never touched).
create or replace function public.check_location_limit() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_plan text; v_max int; v_n int;
begin
  if is_admin() then return new; end if;
  v_plan := coalesce(plan_of(new.org_id), 'free'); v_max := plan_locations(v_plan);
  select count(*) into v_n from locations where org_id = new.org_id;
  if v_max is not null and v_n >= v_max then
    raise exception 'Your % plan includes % location%. Upgrade in Plan & billing to add more.',
      case v_plan when 'free' then 'Starter' when 'plus' then 'Plus' else 'Premium' end, v_max, case when v_max = 1 then '' else 's' end;
  end if;
  return new;
end $$;
drop trigger if exists check_location_limit on public.locations;
create trigger check_location_limit before insert on public.locations for each row execute function public.check_location_limit();

-- Businesses that already have more than one location keep working: early access, no end date.
alter table public.organizations disable trigger guard_plan;
update public.organizations o set plan = case when n.c > 3 then 'premium' else 'plus' end, plan_source = 'early_access'
from (select org_id, count(*) c from public.locations group by org_id having count(*) > 1) n
where n.org_id = o.id and o.plan = 'free';
alter table public.organizations enable trigger guard_plan;

-- ---------------------------------------------------------------- coupons

create table if not exists public.coupons (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  plan text not null check (plan in ('plus', 'premium')),
  months int not null check (months between 1 and 24),
  max_uses int check (max_uses is null or max_uses >= 1),   -- null: any number of businesses
  uses int not null default 0,
  expires_at timestamptz,                                    -- last moment the code can be used
  active boolean not null default true,
  note text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create table if not exists public.coupon_redemptions (
  id uuid primary key default gen_random_uuid(),
  coupon_id uuid not null references public.coupons on delete cascade,
  org_id uuid not null references public.organizations on delete cascade,
  redeemed_by uuid default auth.uid(),
  code text not null, plan text not null, months int not null,
  plan_until timestamptz not null,
  created_at timestamptz not null default now(),
  unique (coupon_id, org_id)
);
alter table public.coupons enable row level security;
alter table public.coupon_redemptions enable row level security;
drop policy if exists coupons_admin on public.coupons;
create policy coupons_admin on public.coupons for all using (is_admin()) with check (is_admin());
drop policy if exists redemptions_read on public.coupon_redemptions;
create policy redemptions_read on public.coupon_redemptions for select using (is_admin() or owns_org(org_id));

-- A code like SYS-7KQ4-M2XD from a cryptographically random UUID (no 0/O/1/I).
create or replace function public.new_coupon_code(p_prefix text default 'SYS') returns text
language plpgsql volatile set search_path = public as $$
declare a text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; b bytea; s text := ''; i int; idx int[] := array[0,1,2,3,4,5,9,10];
begin
  loop
    b := decode(replace(gen_random_uuid()::text, '-', ''), 'hex'); s := '';
    foreach i in array idx loop s := s || substr(a, (get_byte(b, i) % 32) + 1, 1); end loop;
    s := upper(coalesce(nullif(regexp_replace(p_prefix, '[^A-Za-z0-9]', '', 'g'), ''), 'SYS')) || '-' || substr(s, 1, 4) || '-' || substr(s, 5, 4);
    exit when not exists (select 1 from coupons where code = s);
  end loop;
  return s;
end $$;

-- Admin: make p_count codes at once.
create or replace function public.generate_coupons(p_plan text, p_months int, p_count int default 1, p_max_uses int default 1,
  p_expires timestamptz default null, p_note text default null, p_prefix text default 'SYS') returns setof public.coupons
language plpgsql security definer set search_path = public as $$
declare i int;
begin
  if not is_admin() then raise exception 'Only the SplitYourShift admin can make coupons.'; end if;
  if p_plan not in ('plus', 'premium') then raise exception 'Pick Plus or Premium.'; end if;
  if coalesce(p_months, 0) not between 1 and 24 then raise exception 'Months must be 1 to 24.'; end if;
  if coalesce(p_count, 0) not between 1 and 200 then raise exception 'Make 1 to 200 codes at a time.'; end if;
  if p_max_uses is not null and p_max_uses < 1 then raise exception 'Uses must be at least 1 (or leave it empty for no limit).'; end if;
  for i in 1 .. p_count loop
    return query insert into coupons (code, plan, months, max_uses, expires_at, note)
      values (new_coupon_code(p_prefix), p_plan, p_months, p_max_uses, p_expires, nullif(trim(p_note), '')) returning *;
  end loop;
end $$;
revoke execute on function public.generate_coupons(text, int, int, int, timestamptz, text, text) from public, anon;
grant execute on function public.generate_coupons(text, int, int, int, timestamptz, text, text) to authenticated;

-- Admin: every coupon with who used it.
create or replace function public.admin_coupons() returns table (id uuid, code text, plan text, months int, max_uses int, uses int,
  expires_at timestamptz, active boolean, note text, created_at timestamptz, used_by jsonb)
language sql stable security definer set search_path = public as $$
  select c.id, c.code, c.plan, c.months, c.max_uses, c.uses, c.expires_at, c.active, c.note, c.created_at,
    coalesce((select jsonb_agg(jsonb_build_object('org', o.name, 'at', r.created_at, 'until', r.plan_until) order by r.created_at)
      from coupon_redemptions r join organizations o on o.id = r.org_id where r.coupon_id = c.id), '[]'::jsonb)
  from coupons c where is_admin() order by c.created_at desc
$$;
grant execute on function public.admin_coupons() to authenticated;

-- Owner: use a code. The plan starts now, or continues after the current end of the same plan.
create or replace function public.redeem_coupon(p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o organizations; c coupons; v_cur text; v_from timestamptz; v_until timestamptz; v_code text;
begin
  select * into o from organizations where owner_id = auth.uid() order by created_at limit 1 for update;
  if o.id is null then raise exception 'Only a business owner can use a coupon.'; end if;
  v_code := upper(regexp_replace(coalesce(p_code, ''), '\s', '', 'g'));
  select * into c from coupons where code = v_code for update;
  if c.id is null or not c.active then raise exception 'That coupon code isn''t valid. Check the letters and try again.'; end if;
  if c.expires_at is not null and c.expires_at < now() then raise exception 'That coupon code has expired.'; end if;
  if c.max_uses is not null and c.uses >= c.max_uses then raise exception 'That coupon code has already been used.'; end if;
  if exists (select 1 from coupon_redemptions where coupon_id = c.id and org_id = o.id) then raise exception 'You already used this coupon.'; end if;
  v_cur := plan_of(o.id);
  if v_cur <> 'free' and o.plan_until is null then raise exception 'Your % plan has no end date, so you don''t need a coupon.', initcap(v_cur); end if;
  if plan_rank(v_cur) > plan_rank(c.plan) then
    raise exception 'You already have Premium until %. This coupon is for Plus.', to_char(o.plan_until at time zone coalesce(o.time_zone, 'America/Chicago'), 'Mon DD, YYYY');
  end if;
  v_from := case when v_cur = c.plan then greatest(now(), o.plan_until) else now() end;
  v_until := v_from + make_interval(months => c.months);
  perform set_config('sys.plan_ok', '1', true);
  update organizations set plan = c.plan, plan_until = v_until, plan_source = 'coupon' where id = o.id;
  perform set_config('sys.plan_ok', '', true);
  update coupons set uses = uses + 1 where id = c.id;
  insert into coupon_redemptions (coupon_id, org_id, code, plan, months, plan_until) values (c.id, o.id, c.code, c.plan, c.months, v_until);
  return jsonb_build_object('plan', c.plan, 'months', c.months, 'until', v_until);
end $$;
revoke execute on function public.redeem_coupon(text) from public, anon;
grant execute on function public.redeem_coupon(text) to authenticated;

-- Admin: set a business's plan by hand (p_until null = no end date).
create or replace function public.admin_set_plan(p_org uuid, p_plan text, p_until timestamptz default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Only the SplitYourShift admin can change a plan.'; end if;
  if p_plan not in ('free', 'plus', 'premium') then raise exception 'Pick Starter, Plus or Premium.'; end if;
  update organizations set plan = p_plan, plan_until = case when p_plan = 'free' then null else p_until end,
    plan_source = case when p_plan = 'free' then null else 'admin' end where id = p_org;
end $$;
revoke execute on function public.admin_set_plan(uuid, text, timestamptz) from public, anon;
grant execute on function public.admin_set_plan(uuid, text, timestamptz) to authenticated;

-- admin_accounts gains the plan.
drop function if exists public.admin_accounts();
create function public.admin_accounts() returns table (
  id uuid, name text, owner_name text, owner_email text, types text, locations bigint, workers bigint,
  created_at timestamptz, last_active_at timestamptz, status text, plan text, plan_until timestamptz, plan_source text, plan_now text)
language sql stable security definer set search_path = public, auth as $$
  select o.id, o.name, o.owner_name, u.email::text,
    (select string_agg(distinct case l.type when 'hotel' then 'Hotel' when 'gas' then 'Gas station' else 'Shop' end, ' + ') from locations l where l.org_id = o.id),
    (select count(*) from locations l where l.org_id = o.id),
    (select count(*) from employees e where e.org_id = o.id),
    o.created_at, o.last_active_at, o.status, o.plan, o.plan_until, o.plan_source, plan_of(o.id)
  from organizations o left join auth.users u on u.id = o.owner_id
  where is_admin()
  order by o.created_at desc
$$;
grant execute on function public.admin_accounts to authenticated;
