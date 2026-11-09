-- 1. Free trial: every new business starts with a trial of a plan. The admin sets the length and plan,
--    and can extend or end the trial of one business.
-- 2. Join link: owners share one link; workers sign up through it and land on the staff list by themselves.
-- 3. Import from a photo: a log so one business can't run the AI import without limit.

-- ---------------------------------------------------------------- 1. free trial
create table if not exists public.app_settings (
  id boolean primary key default true check (id),
  trial_days int not null default 14 check (trial_days between 0 and 365),   -- 0 = no trial
  trial_plan text not null default 'premium' check (trial_plan in ('plus', 'premium')),
  updated_at timestamptz not null default now()
);
insert into public.app_settings default values on conflict do nothing;
alter table public.app_settings enable row level security;
drop policy if exists "read" on public.app_settings;
create policy "read" on public.app_settings for select using (true);
drop policy if exists "admin writes" on public.app_settings;
create policy "admin writes" on public.app_settings for update using (is_admin()) with check (is_admin());
grant select on public.app_settings to anon, authenticated;
grant update on public.app_settings to authenticated;

-- New businesses get the trial; owners still can't change their plan themselves.
create or replace function public.guard_plan() returns trigger
language plpgsql security definer set search_path = public as $$
declare s app_settings;
begin
  if is_admin() or coalesce(current_setting('sys.plan_ok', true), '') = '1' then return new; end if;
  if tg_op = 'INSERT' then
    select * into s from app_settings where id;
    if coalesce(s.trial_days, 0) > 0 then
      new.plan := s.trial_plan; new.plan_until := now() + make_interval(days => s.trial_days); new.plan_source := 'trial';
    else
      new.plan := 'free'; new.plan_until := null; new.plan_source := null;
    end if;
    new.location_limit := null;
  elsif (new.plan, new.plan_until, new.plan_source, new.location_limit) is distinct from (old.plan, old.plan_until, old.plan_source, old.location_limit) then
    raise exception 'Your plan changes only with a coupon code or through support.';
  end if;
  return new;
end $$;

-- Admin: extend a business's trial by some days, or end it now (p_days = 0).
create or replace function public.admin_trial(p_org uuid, p_days int) returns void
language plpgsql security definer set search_path = public as $$
declare o organizations; v_plan text;
begin
  if not is_admin() then raise exception 'Only the SplitYourShift admin can change a trial.'; end if;
  select * into o from organizations where id = p_org for update;
  if o.id is null then raise exception 'Business not found.'; end if;
  if p_days <= 0 then
    if o.plan_source is distinct from 'trial' then raise exception 'This business isn''t on a trial.'; end if;
    update organizations set plan = 'free', plan_until = null, plan_source = null where id = p_org;
    return;
  end if;
  if p_days > 365 then raise exception 'Extend by at most 365 days at a time.'; end if;
  if plan_of(p_org) <> 'free' and o.plan_source is distinct from 'trial' then
    raise exception 'This business already has a paid plan. Change it under Plan instead.';
  end if;
  select trial_plan into v_plan from app_settings where id;
  update organizations set
    plan = case when o.plan_source = 'trial' and o.plan <> 'free' then o.plan else coalesce(v_plan, 'premium') end,
    plan_until = greatest(now(), coalesce(case when o.plan_source = 'trial' then o.plan_until end, now())) + make_interval(days => p_days),
    plan_source = 'trial'
  where id = p_org;
end $$;
revoke execute on function public.admin_trial(uuid, int) from public, anon;
grant execute on function public.admin_trial(uuid, int) to authenticated;

-- A coupon during a trial starts the paid plan now (the trial doesn't block a Plus coupon).
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
  v_cur := case when o.plan_source = 'trial' then 'free' else plan_of(o.id) end;
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

-- Log trial settings changes with the other admin changes.
create or replace function public.audit_admin_changes() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then return new; end if;
  if tg_table_name = 'plan_catalog' then
    perform admin_log('plan.edit', 'plan', new.id, new.name, jsonb_build_object(
      'before', jsonb_build_object('name', old.name, 'month', old.price_month, 'year', old.price_year, 'locations', old.locations),
      'after', jsonb_build_object('name', new.name, 'month', new.price_month, 'year', new.price_year, 'locations', new.locations)));
    new.updated_at := now();
  elsif tg_table_name = 'app_settings' then
    perform admin_log('trial.settings', 'settings', 'trial', 'Free trial', jsonb_build_object(
      'before', jsonb_build_object('days', old.trial_days, 'plan', old.trial_plan),
      'after', jsonb_build_object('days', new.trial_days, 'plan', new.trial_plan)));
    new.updated_at := now();
  elsif tg_table_name = 'organizations' then
    if new.status is distinct from old.status then
      perform admin_log(case when new.status = 'suspended' then 'business.suspend' else 'business.reactivate' end, 'business', new.id::text, new.name, null);
    end if;
    if (new.plan, new.plan_until, new.location_limit) is distinct from (old.plan, old.plan_until, old.location_limit) then
      perform admin_log(case when new.plan_source = 'trial' or old.plan_source = 'trial' and new.plan_source is null then 'business.trial' else 'business.plan' end,
        'business', new.id::text, new.name, jsonb_build_object('plan', new.plan, 'until', new.plan_until, 'location_limit', new.location_limit));
    end if;
  elsif tg_table_name = 'coupons' then
    if tg_op = 'INSERT' then perform admin_log('coupon.create', 'coupon', new.id::text, new.code, jsonb_build_object('plan', new.plan, 'months', new.months, 'max_uses', new.max_uses));
    elsif new.active is distinct from old.active then perform admin_log(case when new.active then 'coupon.on' else 'coupon.off' end, 'coupon', new.id::text, new.code, null); end if;
  end if;
  return new;
end $$;
drop trigger if exists audit_app_settings on public.app_settings;
create trigger audit_app_settings before update on public.app_settings for each row execute function public.audit_admin_changes();

-- ---------------------------------------------------------------- 2. join link
create table if not exists public.join_links (
  org_id uuid primary key references public.organizations on delete cascade,
  code text not null unique,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.join_links enable row level security;
drop policy if exists "owner reads" on public.join_links;
create policy "owner reads" on public.join_links for select using (owns_org(org_id) or is_admin());

create or replace function public.new_join_code() returns text
language plpgsql volatile set search_path = public as $$
declare v text;
begin
  loop
    -- 10 letters and digits without look-alikes (no 0/O, 1/I/L)
    select string_agg(substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + floor(random() * 31)::int, 1), '') into v from generate_series(1, 10);
    exit when not exists (select 1 from join_links where code = v);
  end loop;
  return v;
end $$;

-- Owner: the business's join code (made the first time). p_reset = make a new code; the old link stops working.
create or replace function public.join_link(p_org uuid, p_reset boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare l join_links;
begin
  if not owns_org(p_org) then raise exception 'Only the owner can share the join link.'; end if;
  select * into l from join_links where org_id = p_org for update;
  if l.org_id is null then
    insert into join_links (org_id, code) values (p_org, new_join_code()) returning * into l;
  elsif p_reset then
    update join_links set code = new_join_code(), active = true, created_at = now() where org_id = p_org returning * into l;
  end if;
  return jsonb_build_object('code', l.code, 'active', l.active, 'created_at', l.created_at);
end $$;
revoke execute on function public.join_link(uuid, boolean) from public, anon;
grant execute on function public.join_link(uuid, boolean) to authenticated;

create or replace function public.join_link_active(p_org uuid, p_active boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not owns_org(p_org) then raise exception 'Only the owner can change the join link.'; end if;
  update join_links set active = p_active where org_id = p_org;
end $$;
revoke execute on function public.join_link_active(uuid, boolean) from public, anon;
grant execute on function public.join_link_active(uuid, boolean) to authenticated;

-- Join page: the business name for a code (nothing else is shown to someone who isn't logged in).
create or replace function public.join_info(p_code text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('business', o.name, 'active', l.active)
  from join_links l join organizations o on o.id = l.org_id
  where l.code = upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'))
$$;
grant execute on function public.join_info(text) to anon, authenticated;

-- Add a user to the business behind a code: links a staff row the owner already made (same email or phone), or adds one.
create or replace function public.join_org(p_user uuid, p_code text, p_name text, p_phone text) returns uuid
language plpgsql security definer set search_path = public, auth as $$
declare v_org uuid; v_owner uuid; v_email text; v_emp uuid; v_name text; v_n int; v_digits text; v_new boolean := false;
  v_hues int[] := array[12, 205, 145, 275, 38, 180, 330, 95, 240, 58, 300, 160, 20, 220];
begin
  if p_user is null then raise exception 'Please log in first.'; end if;
  select l.org_id, o.owner_id into v_org, v_owner from join_links l join organizations o on o.id = l.org_id
    where l.code = upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g')) and l.active;
  if v_org is null then raise exception 'This join link doesn''t work anymore. Ask your manager for the new one.'; end if;
  if v_owner = p_user then raise exception 'This is the join link for your own business. Share it with your workers.'; end if;
  select id into v_emp from employees where org_id = v_org and user_id = p_user;
  if v_emp is not null then return v_emp; end if;
  select email, coalesce(raw_user_meta_data->>'full_name', raw_user_meta_data->>'name') into v_email, v_name from auth.users where id = p_user;
  v_name := coalesce(nullif(trim(p_name), ''), nullif(trim(v_name), ''), split_part(coalesce(v_email, 'New worker'), '@', 1));
  v_digits := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  select id into v_emp from employees where org_id = v_org and user_id is null
    and ((v_email is not null and lower(email) = lower(v_email)) or (length(v_digits) >= 7 and phone_digits = v_digits))
    order by created_at limit 1;
  if v_emp is not null then
    update employees set user_id = p_user, email = coalesce(email, v_email), phone = coalesce(phone, nullif(trim(p_phone), '')) where id = v_emp;
  else
    select count(*) into v_n from employees where org_id = v_org;
    insert into employees (org_id, user_id, name, email, phone, hue)
      values (v_org, p_user, left(v_name, 80), v_email, nullif(trim(p_phone), ''), v_hues[1 + v_n % 14]) returning id into v_emp;
    insert into employee_locations (employee_id, location_id) select v_emp, id from locations where org_id = v_org on conflict do nothing;
    v_new := true;
  end if;
  insert into notifications (org_id, recipient, text)
    values (v_org, v_owner, v_name || case when v_new then ' joined your team with your join link. Set their shift limit and pay rate in their profile.'
                                      else ' joined with your join link and is now linked to their profile.' end);
  return v_emp;
end $$;
revoke execute on function public.join_org(uuid, text, text, text) from public, anon, authenticated;

create or replace function public.join_by_code(p_code text, p_name text default null, p_phone text default null) returns uuid
language sql security definer set search_path = public as $$ select join_org(auth.uid(), p_code, p_name, p_phone) $$;
revoke execute on function public.join_by_code(text, text, text) from public, anon;
grant execute on function public.join_by_code(text, text, text) to authenticated;

-- Signing up through a join link (email confirmation can happen later, on any device): join right away.
create or replace function public.join_on_signup() returns trigger
language plpgsql security definer set search_path = public, auth as $$
begin
  if new.raw_user_meta_data ? 'join_code' then
    begin
      perform join_org(new.id, new.raw_user_meta_data->>'join_code', new.raw_user_meta_data->>'name', new.raw_user_meta_data->>'phone');
    exception when others then null;  -- never block a sign-up; the join page can try again after log-in
    end;
  end if;
  return new;
end $$;
drop trigger if exists join_on_signup on auth.users;
create trigger join_on_signup after insert on auth.users for each row execute function public.join_on_signup();

-- ---------------------------------------------------------------- 3. photo import log
create table if not exists public.ai_imports (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.organizations on delete cascade,
  user_id uuid,
  ok boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists ai_imports_org on public.ai_imports (org_id, created_at desc);
alter table public.ai_imports enable row level security;
drop policy if exists "admin reads" on public.ai_imports;
create policy "admin reads" on public.ai_imports for select using (is_admin());
