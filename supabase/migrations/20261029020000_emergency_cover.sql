-- Emergencies: cover and trade may go over a worker's weekly limit (an "extra shift"), paid back later.
-- Normal scheduling (drag and drop) still stops at the limit; the app passes p_allow_over only for cover, trade and payback.
drop function if exists public.apply_changes(uuid, jsonb);

create function public.apply_changes(p_org uuid, p_changes jsonb, p_allow_over boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c jsonb; v_slot uuid; v_date date; v_emp uuid; v_old uuid; v_loc uuid; v_wk date; v_label text;
  r record;
begin
  if not owns_org(p_org) then raise exception 'Only the owner can change this schedule.'; end if;
  if exists (select 1 from organizations where id = p_org and status = 'suspended') then
    raise exception 'This account is suspended. Contact SplitYourShift support.';
  end if;
  create temp table if not exists _aff (emp uuid, wk date, before int) on commit drop;
  create temp table if not exists _cells (slot uuid, d date, emp uuid) on commit drop;
  -- Supabase blocks DELETE without WHERE on API calls (pg_safeupdate), hence "where true".
  delete from _aff where true; delete from _cells where true;

  for c in select * from jsonb_array_elements(p_changes) loop
    v_slot := (c ->> 'slot_id')::uuid;
    v_date := (c ->> 'work_date')::date;
    v_emp := nullif(c ->> 'employee_id', '')::uuid;
    v_wk := date_trunc('week', v_date)::date;
    select location_id into v_loc from shift_slots where id = v_slot and org_id = p_org;
    if v_loc is null then raise exception 'That shift no longer exists. Refresh the page.'; end if;
    if v_emp is not null and not exists (select 1 from employees where id = v_emp and org_id = p_org) then
      raise exception 'That worker no longer exists. Refresh the page.';
    end if;
    select employee_id into v_old from assignments where slot_id = v_slot and work_date = v_date for update;

    insert into _aff (emp, wk, before)
    select e, v_wk, (select count(*) from assignments a where a.employee_id = e and a.work_date >= v_wk and a.work_date < v_wk + 7)
    from unnest(array[v_old, v_emp]) as e
    where e is not null and not exists (select 1 from _aff x where x.emp = e and x.wk = v_wk);

    if v_emp is null then
      delete from assignments where slot_id = v_slot and work_date = v_date;
    elsif v_old is null then
      insert into assignments (org_id, location_id, slot_id, work_date, employee_id) values (p_org, v_loc, v_slot, v_date, v_emp);
    else
      update assignments set employee_id = v_emp where slot_id = v_slot and work_date = v_date;
    end if;
    insert into _cells values (v_slot, v_date, v_emp);

    if v_old is distinct from v_emp then
      v_label := slot_label(v_slot, v_date);
      if v_old is not null then
        perform notify_user(p_org, (select user_id from employees where id = v_old), 'You''re no longer on ' || v_label || '.');
      end if;
      if v_emp is not null then
        perform notify_user(p_org, (select user_id from employees where id = v_emp), 'You now work ' || v_label || '.');
      end if;
    end if;
  end loop;

  for r in
    select a.emp, a.wk, a.before, e.max_shifts, e.name,
      (select count(*) from assignments x where x.employee_id = a.emp and x.work_date >= a.wk and x.work_date < a.wk + 7) as after
    from _aff a join employees e on e.id = a.emp
  loop
    if not p_allow_over and r.after > r.max_shifts and r.after > r.before then
      raise exception '% already has % of % shifts in the week of %. Remove one of their shifts or raise their limit.',
        r.name, r.before, r.max_shifts, to_char(r.wk, 'Mon DD');
    end if;
  end loop;

  for r in
    select e.name, slot_label(o.slot_id, o.work_date) as other
    from _cells c
    join shift_slots s on s.id = c.slot
    join assignments o on o.employee_id = c.emp and not (o.slot_id = c.slot and o.work_date = c.d)
      and o.work_date between c.d - 1 and c.d + 1
    join shift_slots so on so.id = o.slot_id
    join employees e on e.id = c.emp
    where c.emp is not null
      and (c.d + make_interval(hours => s.start_hour)) < (o.work_date + make_interval(hours => so.start_hour + so.hours))
      and (o.work_date + make_interval(hours => so.start_hour)) < (c.d + make_interval(hours => s.start_hour + s.hours))
    limit 1
  loop
    raise exception '% is already working % at that time.', r.name, r.other;
  end loop;

  update organizations set last_active_at = now() where id = p_org;
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.apply_changes(uuid, jsonb, boolean) to authenticated;

-- Shifts owed even out: if someone who owes a shift covers for the person they owe
-- (for example with an emergency clock-in), the old debt is settled instead of starting a new one.
create or replace function public.ledger_even_out() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_old uuid;
begin
  select id into v_old from ledger
  where org_id = new.org_id and status = 'open' and debtor_id = new.creditor_id and creditor_id = new.debtor_id
  order by created_at limit 1;
  if v_old is null then return new; end if;
  update ledger set status = 'settled', settled_at = now() where id = v_old;
  new.status := 'settled'; new.settled_at := now();
  return new;
end $$;
create trigger ledger_even_out before insert on public.ledger for each row when (new.status = 'open') execute function public.ledger_even_out();
