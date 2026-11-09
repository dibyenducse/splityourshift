-- Split one day of a shift into parts (e.g. 9 am–9 pm becomes 9–2 for Ann and 2–9 for Ben), from the schedule.
-- Each part is a one-day shift slot (only_date + parent_slot), so clock-in, reminders, swaps and payroll treat it
-- like any shift. The regular shift pattern is untouched; "join" puts the day back together.

alter table public.shift_slots
  add column if not exists only_date date,
  add column if not exists parent_slot uuid references public.shift_slots on delete cascade;
create index if not exists shift_slots_parts on public.shift_slots (parent_slot, only_date) where parent_slot is not null;

-- Nobody can be put on the whole shift for a day that is split into parts.
create or replace function public.block_split_parent() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from shift_slots where parent_slot = new.slot_id and only_date = new.work_date) then
    raise exception 'This shift is split into parts that day. Put people on the parts, or join it back first.';
  end if;
  if exists (select 1 from shift_slots where id = new.slot_id and only_date is not null and only_date <> new.work_date) then
    raise exception 'That part only exists on its own day.';
  end if;
  return new;
end $$;
drop trigger if exists block_split_parent on public.assignments;
create trigger block_split_parent before insert or update on public.assignments for each row execute function public.block_split_parent();

-- p_cuts: hours (0–23, same calendar day) where the shift is cut. p_emps: who works each part (null = open), in order.
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
  if b[1] <= s.start_hour or b[array_length(b, 1)] >= least(s.start_hour + s.hours, 24) then
    raise exception 'Split between the start and the end of the shift (and before midnight).';
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
revoke execute on function public.split_shift(uuid, date, int[], uuid[]) from public, anon;
grant execute on function public.split_shift(uuid, date, int[], uuid[]) to authenticated;

-- Put a split day back into one shift; whoever had the first part keeps it.
create or replace function public.join_shift(p_slot uuid, p_date date) returns void
language plpgsql security definer set search_path = public as $$
declare s shift_slots; v_first uuid;
begin
  select * into s from shift_slots where id = p_slot;
  if s.id is null or not owns_org(s.org_id) then raise exception 'Only the owner can change this shift.'; end if;
  if not exists (select 1 from shift_slots where parent_slot = p_slot and only_date = p_date) then raise exception 'This shift isn''t split that day.'; end if;
  if exists (select 1 from time_entries t join shift_slots p on p.id = t.slot_id where p.parent_slot = p_slot and p.only_date = p_date) then
    raise exception 'Someone already clocked in on a part, so it can''t be joined back. Edit the parts instead.';
  end if;
  select a.employee_id into v_first from assignments a join shift_slots p on p.id = a.slot_id
  where p.parent_slot = p_slot and p.only_date = p_date order by p.start_hour limit 1;
  delete from shift_slots where parent_slot = p_slot and only_date = p_date;
  if v_first is not null then
    insert into assignments (org_id, location_id, slot_id, work_date, employee_id) values (s.org_id, s.location_id, p_slot, p_date, v_first)
    on conflict (slot_id, work_date) do nothing;
  end if;
end $$;
revoke execute on function public.join_shift(uuid, date) from public, anon;
grant execute on function public.join_shift(uuid, date) to authenticated;
