-- Pay by the schedule while keeping the time clock: pay_method 'schedule'.
--   Workers still clock in and out (records, late and forgot-to-clock-out questions), but payroll pays each
--   worker's assigned shift hours, like a location with the time clock off. The owner can still edit hours.

alter table public.locations drop constraint if exists locations_pay_method_check;
alter table public.locations add constraint locations_pay_method_check check (pay_method in ('actual', 'grace', 'schedule'));

create or replace function public.payroll_lines(p_loc uuid, p_start date, p_end date, p_emp uuid default null)
returns table (employee_id uuid, name text, rate numeric, overtime_rate numeric, hours numeric, regular_hours numeric, overtime_hours numeric,
  regular_pay numeric, overtime_pay numeric, bonus numeric, deduction numeric, gross numeric, net numeric, open_entries int,
  method text, base_hours numeric, edited_hours numeric, missing_shifts int)
language sql stable security definer set search_path = public as $$
  with l as (
    select * from locations where id = p_loc
      and (owns_org(org_id) or is_admin() or auth.uid() is null or (p_emp is not null and p_emp in (select my_employee_ids())))
  ),
  ent as (
    select t.employee_id, t.clock_out, t.work_date,
      -- Paid time: the real clock times, or (grace method) the scheduled start/end when the worker was within
      -- the grace minutes of it. Grace only ever adds time; time worked beyond the shift is always paid.
      round((extract(epoch from (
        case when l.pay_method = 'grace' and s.id is not null and t.clock_out is not null
               and t.clock_out < shift_start(t.slot_id, t.work_date) + make_interval(hours => s.hours)
               and t.clock_out >= shift_start(t.slot_id, t.work_date) + make_interval(hours => s.hours) - make_interval(mins => l.pay_grace_minutes)
             then shift_start(t.slot_id, t.work_date) + make_interval(hours => s.hours) else t.clock_out end
        - case when l.pay_method = 'grace' and s.id is not null
               and t.clock_in > shift_start(t.slot_id, t.work_date)
               and t.clock_in <= shift_start(t.slot_id, t.work_date) + make_interval(mins => l.pay_grace_minutes)
             then shift_start(t.slot_id, t.work_date) else t.clock_in end)) / 3600)::numeric, 2) as h
    from time_entries t
    join l on l.org_id = t.org_id and l.time_clock and l.pay_method <> 'schedule'
    left join shift_slots s on s.id = t.slot_id
    where t.work_date between p_start and p_end
      and (p_emp is null or t.employee_id = p_emp)
      and coalesce(s.location_id, t.location_id, (select el.location_id from employee_locations el join locations x on x.id = el.location_id
                                   where el.employee_id = t.employee_id order by x.sort, x.created_at limit 1)) = l.id
    union all
    -- Time clock off: the scheduled shifts are the paid hours.
    select a.employee_id, a.work_date::timestamptz, a.work_date, s2.hours::numeric
    from assignments a join shift_slots s2 on s2.id = a.slot_id join l on l.id = s2.location_id and (not l.time_clock or l.pay_method = 'schedule')
    where a.work_date between p_start and p_end and (p_emp is null or a.employee_id = p_emp)
  ),
  wk0 as (
    select e.employee_id, e.work_date - (((e.work_date - l.pay_anchor) % 7 + 7) % 7) as week, sum(e.h) as h
    from ent e, l where e.clock_out is not null group by 1, 2
  ),
  base as (select employee_id, sum(h) as h from wk0 group by 1),
  -- Time clock off: hours the owner typed in for the period replace the schedule's total. The difference is put
  -- in the period's last week, so weekly overtime is still worked out from the edited total.
  ovr as (
    select a.employee_id, a.amount as h from payroll_adjustments a join l on l.id = a.location_id and (not l.time_clock or l.pay_method = 'schedule')
    where a.kind = 'hours' and a.period_start = p_start and (p_emp is null or a.employee_id = p_emp)
  ),
  wk as (
    select employee_id, week, sum(h) as h from (
      select employee_id, week, h from wk0
      union all
      select o.employee_id, p_end - (((p_end - l.pay_anchor) % 7 + 7) % 7), o.h - coalesce(b.h, 0)
      from ovr o cross join l left join base b on b.employee_id = o.employee_id
    ) u group by 1, 2
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
    union select ovr.employee_id from ovr
  ),
  calc as (
    select e.id, e.name, e.rate,
      round(case when l.ot_mode = 'fixed' then l.ot_fixed_rate else e.rate * l.ot_multiplier end, 2) as otr,
      coalesce(p.hours, 0) as hours, coalesce(p.hours - p.ot, 0) as reg, coalesce(p.ot, 0) as ot,
      coalesce(a.bonus, 0) as bonus, coalesce(a.deduction, 0) as deduction,
      (select count(*) from ent x where x.employee_id = e.id and x.clock_out is null)::int as open_entries,
      case when l.time_clock and l.pay_method <> 'schedule' then 'clock' else 'schedule' end as method,
      coalesce(bs.h, 0) as base_hours, o.h as edited_hours,
      -- Time clock on: scheduled shifts that have ended with no clock record (shown so nothing is paid by mistake).
      case when not l.time_clock or l.pay_method = 'schedule' then 0 else (
        select count(*) from assignments a join shift_slots s on s.id = a.slot_id
        where s.location_id = l.id and a.employee_id = e.id and a.work_date between p_start and p_end
          and shift_start(a.slot_id, a.work_date) + make_interval(hours => s.hours) < now()
          and not exists (select 1 from time_entries t where t.employee_id = a.employee_id and t.slot_id = a.slot_id and t.work_date = a.work_date)
      ) end::int as missing_shifts
    from l, who join employees e on e.id = who.employee_id
    left join per p on p.employee_id = e.id
    left join adj a on a.employee_id = e.id
    left join base bs on bs.employee_id = e.id
    left join ovr o on o.employee_id = e.id
    where p_emp is null or e.id = p_emp
  )
  select id, name, rate, otr, hours, reg, ot,
    round(reg * rate, 2), round(ot * otr, 2), bonus, deduction,
    round(reg * rate, 2) + round(ot * otr, 2) + bonus,
    round(reg * rate, 2) + round(ot * otr, 2) + bonus - deduction,
    open_entries, method, base_hours, edited_hours, missing_shifts
  from calc order by name
$$;
