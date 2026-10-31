-- 1. Overtime is set by each owner, per business: after how many hours a week, and paid as a multiple of the
--    worker's rate (e.g. 1.5× or 2×) or as a fixed dollar amount per overtime hour.
-- 2. Payslips: a worker (or their owner) can list every paid payslip of theirs.
-- 3. Profile photos: a public "avatars" bucket; each user writes only to their own folder.

alter table public.locations
  add column if not exists ot_after numeric(5, 2) not null default 40 check (ot_after > 0),
  add column if not exists ot_mode text not null default 'multiplier' check (ot_mode in ('multiplier', 'fixed')),
  add column if not exists ot_multiplier numeric(4, 2) not null default 1.5 check (ot_multiplier >= 1 and ot_multiplier <= 5),
  add column if not exists ot_fixed_rate numeric(8, 2) not null default 0 check (ot_fixed_rate >= 0);

-- payroll_lines gains overtime_rate (the dollars per overtime hour); the return type changes, so drop and re-create.
drop function if exists public.payroll_lines(uuid, date, date, uuid);
create function public.payroll_lines(p_loc uuid, p_start date, p_end date, p_emp uuid default null)
returns table (employee_id uuid, name text, rate numeric, overtime_rate numeric, hours numeric, regular_hours numeric, overtime_hours numeric,
  regular_pay numeric, overtime_pay numeric, bonus numeric, deduction numeric, gross numeric, net numeric, open_entries int)
language sql stable security definer set search_path = public as $$
  with l as (
    select * from locations where id = p_loc
      and (owns_org(org_id) or is_admin() or auth.uid() is null or (p_emp is not null and p_emp in (select my_employee_ids())))
  ),
  ent as (
    select t.employee_id, t.clock_out, t.work_date,
      round((extract(epoch from (t.clock_out - t.clock_in)) / 3600)::numeric, 2) as h
    from time_entries t
    join l on l.org_id = t.org_id
    left join shift_slots s on s.id = t.slot_id
    where t.work_date between p_start and p_end
      and (p_emp is null or t.employee_id = p_emp)
      and coalesce(s.location_id, (select el.location_id from employee_locations el join locations x on x.id = el.location_id
                                   where el.employee_id = t.employee_id order by x.sort, x.created_at limit 1)) = l.id
  ),
  wk as (
    select e.employee_id, e.work_date - (((e.work_date - l.pay_anchor) % 7 + 7) % 7) as week, sum(e.h) as h
    from ent e, l where e.clock_out is not null group by 1, 2
  ),
  per as (
    select w.employee_id, sum(w.h) as hours, sum(case when l.overtime then greatest(w.h - l.ot_after, 0) else 0 end) as ot
    from wk w, l group by 1
  ),
  adj as (
    select a.employee_id,
      sum(case when a.kind = 'bonus' then a.amount else 0 end) as bonus,
      sum(case when a.kind = 'deduction' then a.amount else 0 end) as deduction
    from payroll_adjustments a join l on l.id = a.location_id
    where a.period_start = p_start group by 1
  ),
  who as (
    select el.employee_id from employee_locations el join l on l.id = el.location_id
    union select ent.employee_id from ent
    union select adj.employee_id from adj
  ),
  calc as (
    select e.id, e.name, e.rate,
      round(case when l.ot_mode = 'fixed' then l.ot_fixed_rate else e.rate * l.ot_multiplier end, 2) as otr,
      coalesce(p.hours, 0) as hours, coalesce(p.hours - p.ot, 0) as reg, coalesce(p.ot, 0) as ot,
      coalesce(a.bonus, 0) as bonus, coalesce(a.deduction, 0) as deduction,
      (select count(*) from ent x where x.employee_id = e.id and x.clock_out is null)::int as open_entries
    from l, who join employees e on e.id = who.employee_id
    left join per p on p.employee_id = e.id
    left join adj a on a.employee_id = e.id
    where p_emp is null or e.id = p_emp
  )
  select id, name, rate, otr, hours, reg, ot,
    round(reg * rate, 2), round(ot * otr, 2), bonus, deduction,
    round(reg * rate, 2) + round(ot * otr, 2) + bonus,
    round(reg * rate, 2) + round(ot * otr, 2) + bonus - deduction,
    open_entries
  from calc order by name
$$;

revoke execute on function public.payroll_lines(uuid, date, date, uuid) from public, anon;
grant execute on function public.payroll_lines(uuid, date, date, uuid) to authenticated;

-- Every paid payslip of one worker, newest first (from the locked paid records).
create or replace function public.my_payslips(p_emp uuid)
returns table (run_id uuid, location_id uuid, location_name text, period_start date, period_end date, pay_date date,
  paid_at timestamptz, line jsonb)
language plpgsql stable security definer set search_path = public as $$
declare e employees;
begin
  select * into e from employees where id = p_emp;
  if e.id is null or not (p_emp in (select my_employee_ids()) or owns_org(e.org_id) or is_admin()) then raise exception 'Not allowed.'; end if;
  return query
    select r.id, r.location_id, r.location_name, r.period_start, r.period_end, r.pay_date, r.paid_at, j
    from payroll_runs r, jsonb_array_elements(r.lines) j
    where r.org_id = e.org_id and r.status = 'paid' and (j ->> 'employee_id')::uuid = p_emp
    order by r.pay_date desc, r.location_name;
end $$;
revoke execute on function public.my_payslips(uuid) from public, anon;
grant execute on function public.my_payslips(uuid) to authenticated;

-- Profile photos (Supabase Storage). Files live at avatars/<user id>/...
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('avatars', 'avatars', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
    on conflict (id) do nothing;
    drop policy if exists "avatar upload" on storage.objects;
    drop policy if exists "avatar update" on storage.objects;
    drop policy if exists "avatar delete" on storage.objects;
    create policy "avatar upload" on storage.objects for insert to authenticated
      with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
    create policy "avatar update" on storage.objects for update to authenticated
      using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
    create policy "avatar delete" on storage.objects for delete to authenticated
      using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
  end if;
end $$;
