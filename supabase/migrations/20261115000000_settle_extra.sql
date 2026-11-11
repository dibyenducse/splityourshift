-- Stayed late for a coworker who came late, and the two sorted it out: no extra pay, no swap.
-- The clock-out is set to the shift's scheduled end (so the extra minutes aren't paid) and a note is kept.
create or replace function public.settle_extra(p_entry uuid) returns void
language plpgsql security definer set search_path = public as $$
declare t time_entries; v_end timestamptz; v_min int;
begin
  select * into t from time_entries where id = p_entry and employee_id in (select my_employee_ids()) for update;
  if t.id is null then raise exception 'That clock record isn''t yours.'; end if;
  if t.clock_out is null then raise exception 'Clock out first.'; end if;
  if t.slot_id is null then raise exception 'This wasn''t a scheduled shift, so there''s no shift end to use.'; end if;
  select shift_start(t.slot_id, t.work_date) + make_interval(hours => s.hours) into v_end from shift_slots s where s.id = t.slot_id;
  if v_end is null or t.clock_out <= v_end then return; end if;
  v_min := round(extract(epoch from (t.clock_out - v_end)) / 60);
  update time_entries
     set clock_out = v_end,
         note = btrim(coalesce(note, '') || ' Stayed ' || v_min || ' min after the shift; settled with a coworker (not paid).')
   where id = t.id;
end $$;
revoke execute on function public.settle_extra(uuid) from public, anon;
grant execute on function public.settle_extra(uuid) to authenticated;
