-- Shops and stores as a third business type (besides hotels and gas stations).

alter table public.locations drop constraint if exists locations_type_check;
alter table public.locations add constraint locations_type_check check (type in ('hotel', 'gas', 'shop'));

create or replace function public.admin_overview(p_days int default 14) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare since timestamptz := date_trunc('day', now()) - make_interval(days => p_days - 1);
begin
  if not is_admin() then raise exception 'Admins only.'; end if;
  return jsonb_build_object(
    'daily', (select coalesce(jsonb_agg(jsonb_build_object('day', d::date, 'visitors', coalesce(v, 0)) order by d), '[]')
      from generate_series(since, date_trunc('day', now()), interval '1 day') d
      left join (select date_trunc('day', ts) as day, count(distinct visitor) as v from page_views where ts >= since group by 1) pv on pv.day = d),
    'visitors', (select count(distinct visitor || date_trunc('day', ts)::text) from page_views where ts >= since),
    'signup_views', (select count(distinct visitor) from page_views where ts >= since and path like '%signup%'),
    'signups', (select count(*) from organizations where created_at >= since),
    'owners', (select count(*) from organizations),
    'hotels', (select count(*) from locations where type = 'hotel'),
    'gas', (select count(*) from locations where type = 'gas'),
    'shops', (select count(*) from locations where type = 'shop'),
    'workers', (select count(*) from employees),
    'workers_active', (select count(*) from employees where user_id is not null),
    'requests', (select count(*) from time_off_requests where created_at >= since),
    'requests_cancelled', (select count(*) from time_off_requests where created_at >= since and status = 'cancelled'),
    'published', (select count(distinct org_id) from assignments where created_at >= since),
    'pages', (select coalesce(jsonb_agg(p), '[]') from (select path, count(*) as views from page_views where ts >= since group by path order by 2 desc limit 8) p)
  );
end $$;
grant execute on function public.admin_overview to authenticated;

create or replace function public.admin_accounts() returns table (
  id uuid, name text, owner_name text, owner_email text, types text, locations bigint, workers bigint,
  created_at timestamptz, last_active_at timestamptz, status text)
language sql stable security definer set search_path = public, auth as $$
  select o.id, o.name, o.owner_name, u.email::text,
    (select string_agg(distinct case l.type when 'hotel' then 'Hotel' when 'gas' then 'Gas station' else 'Shop' end, ' + ') from locations l where l.org_id = o.id),
    (select count(*) from locations l where l.org_id = o.id),
    (select count(*) from employees e where e.org_id = o.id),
    o.created_at, o.last_active_at, o.status
  from organizations o left join auth.users u on u.id = o.owner_id
  where is_admin()
  order by o.created_at desc
$$;
grant execute on function public.admin_accounts to authenticated;
