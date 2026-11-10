-- Free trial on every plan: the owner picks Starter, Plus or Premium and gets the trial of that plan.
-- One trial per business; during the trial the owner can switch plans (the end date stays).

alter table public.organizations add column if not exists trial_started_at timestamptz;
update public.organizations set trial_started_at = coalesce(trial_started_at, created_at) where plan_source = 'trial';

create or replace function public.guard_plan() returns trigger
language plpgsql security definer set search_path = public as $$
declare s app_settings;
begin
  if is_admin() or coalesce(current_setting('sys.plan_ok', true), '') = '1' then return new; end if;
  if tg_op = 'INSERT' then
    select * into s from app_settings where id;
    if coalesce(s.trial_days, 0) > 0 then
      new.plan := s.trial_plan; new.plan_until := now() + make_interval(days => s.trial_days); new.plan_source := 'trial'; new.trial_started_at := now();
    else
      new.plan := 'free'; new.plan_until := null; new.plan_source := null; new.trial_started_at := null;
    end if;
    new.location_limit := null;
  elsif (new.plan, new.plan_until, new.plan_source, new.location_limit, new.trial_started_at)
        is distinct from (old.plan, old.plan_until, old.plan_source, old.location_limit, old.trial_started_at) then
    raise exception 'Your plan changes only with a coupon code or through support.';
  end if;
  return new;
end $$;

-- Owner: start the free trial of a plan, or switch plans during the trial.
create or replace function public.start_trial(p_plan text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o organizations; v_days int;
begin
  if p_plan not in ('free', 'plus', 'premium') then raise exception 'Pick Starter, Plus or Premium.'; end if;
  select * into o from organizations where owner_id = auth.uid() order by created_at limit 1 for update;
  if o.id is null then raise exception 'Only a business owner can start a trial.'; end if;
  select trial_days into v_days from app_settings where id;
  perform set_config('sys.plan_ok', '1', true);
  if o.plan_source = 'trial' and o.plan_until > now() then
    update organizations set plan = p_plan where id = o.id returning * into o;           -- switch, same end date
  elsif o.trial_started_at is not null or o.plan_source = 'trial' then
    perform set_config('sys.plan_ok', '', true);
    raise exception 'You''ve already used your free trial. Choose a plan to continue.';
  elsif plan_of(o.id) <> 'free' then
    perform set_config('sys.plan_ok', '', true);
    raise exception 'You already have a paid plan.';
  elsif coalesce(v_days, 0) <= 0 then
    perform set_config('sys.plan_ok', '', true);
    raise exception 'Free trials are off right now.';
  else
    update organizations set plan = p_plan, plan_until = now() + make_interval(days => v_days), plan_source = 'trial', trial_started_at = now()
      where id = o.id returning * into o;
  end if;
  perform set_config('sys.plan_ok', '', true);
  return jsonb_build_object('plan', o.plan, 'until', o.plan_until);
end $$;
revoke execute on function public.start_trial(text) from public, anon;
grant execute on function public.start_trial(text) to authenticated;

-- Admin trials also count as the business's one trial.
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
    plan = case when o.plan_source = 'trial' then o.plan else coalesce(v_plan, 'premium') end,
    plan_until = greatest(now(), coalesce(case when o.plan_source = 'trial' then o.plan_until end, now())) + make_interval(days => p_days),
    plan_source = 'trial', trial_started_at = coalesce(o.trial_started_at, now())
  where id = p_org;
end $$;
