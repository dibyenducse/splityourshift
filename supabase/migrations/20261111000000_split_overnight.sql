-- Split overnight shifts too (e.g. 11 pm–7 am into 11 pm–3 am and 3 am–7 am).
-- A part that starts after midnight keeps its shift's day and gets a start hour of 24–47 (27 = 3 am the next
-- morning); start times are worked out as day + hours everywhere, so clock-in, reminders and payroll follow.

alter table public.shift_slots drop constraint if exists shift_slots_start_hour_check;
alter table public.shift_slots add constraint shift_slots_start_hour_check
  check (start_hour between 0 and 23 or (only_date is not null and start_hour between 24 and 47));

-- p_cuts: where the shift is cut, in hours from midnight of the shift's day (27 = 3 am the next morning). p_emps: who works each part (null = open), in order.
create or replace function public.split_shift(p_slot uuid, p_date date, p_cuts int[], p_emps uuid[]) returns void
language plpgsql security definer set search_path = public as $$
declare s shift_slots; b int[]; i int; v_id uuid; v_emp uuid;
begin
  select * into s from shift_slots where id = p_slot;
  if s.id is null or not owns_org(s.org_id) then raise exception 'Only the owner can split a shift.'; end if;
  if s.only_date is not null then raise exception 'This is already a part. Join the shift back first to split it differently.'; end if;
  if exists (select 1 from shift_slots where parent_slot = p_slot and only_date = p_date) then raise exception 'This shift is already split that day.'; end if;
  if exists (select 1 from organizations where id = s.org_id and status = 'suspended') then raise exception 'This account is suspended. Contact SplitYourShift support.'; end if;
  select array_agg(c order by c) into b from (select distinct unnest(p_cuts) c) x;
  if b is null or array_length(b, 1) = 0 then raise exception 'Pick where to split the shift.'; end if;
  if b[1] <= s.start_hour or b[array_length(b, 1)] >= s.start_hour + s.hours then
    raise exception 'Split between the start and the end of the shift.';
  end if;
  b := array[s.start_hour::int] || b || array[(s.start_hour + s.hours)::int];
  if array_length(p_emps, 1) is distinct from array_length(b, 1) - 1 then raise exception 'Pick who works each part (or leave it open).'; end if;
  if exists (select 1 from unnest(p_emps) e where e is not null and not exists (select 1 from employees where id = e and org_id = s.org_id)) then
    raise exception 'Pick workers from this business.';
  end if;
  delete from assignments where slot_id = p_slot and work_date = p_date;
  for i in 1 .. array_length(b, 1) - 1 loop
    insert into shift_slots (org_id, location_id, start_hour, hours, sort, active, only_date, parent_slot)
    values (s.org_id, s.location_id, b[i], b[i + 1] - b[i], s.sort, true, p_date, p_slot) returning id into v_id;
    v_emp := p_emps[i];
    if v_emp is not null then
      insert into assignments (org_id, location_id, slot_id, work_date, employee_id) values (s.org_id, s.location_id, v_id, p_date, v_emp);
    end if;
  end loop;
end $$;
