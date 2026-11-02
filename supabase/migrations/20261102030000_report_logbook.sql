-- Shift report logbook: a report names its shift (Morning / Evening / Night) and the worker picks the shift date
-- themselves (a Sunday 11 pm – Monday 7 am night shift is Sunday's, even when written on Monday morning).
-- Any worker of the business can write, any number per day; no schedule or clock-in needed.

alter table public.shift_reports add column if not exists shift_name text check (shift_name is null or shift_name in ('Morning', 'Evening', 'Night'));
alter table public.shift_reports alter column body type text;
alter table public.shift_reports drop constraint if exists shift_reports_body_check;
alter table public.shift_reports add constraint shift_reports_body_check check (length(trim(body)) between 1 and 20000);

-- Name the shifts of reports written before this change from their shift's start time.
update public.shift_reports r set shift_name = case when s.start_hour >= 4 and s.start_hour < 11 then 'Morning'
  when s.start_hour >= 11 and s.start_hour < 19 then 'Evening' else 'Night' end
from public.shift_slots s where s.id = r.slot_id and r.shift_name is null;

create index if not exists shift_reports_recent on public.shift_reports (org_id, created_at desc);

create or replace function public.shift_report_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_name text; v_owner uuid;
begin
  select name into v_name from employees where id = new.employee_id;
  select owner_id into v_owner from organizations where id = new.org_id;
  if v_owner is distinct from auth.uid() then
    perform notify_user(new.org_id, v_owner, v_name || ' posted a shift report: ' ||
      coalesce((select name from locations where id = new.location_id) || ' – ', '') || coalesce(new.shift_name || ' shift', 'shift') ||
      ', ' || to_char(new.work_date, 'Dy MM/DD') || '. "' ||
      left(regexp_replace(new.body, '\s+', ' ', 'g'), 90) || case when length(new.body) > 90 then '…' else '' end || '"');
  end if;
  return new;
end $$;
