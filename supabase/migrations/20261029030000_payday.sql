-- Payday: the weekday pay goes out after a pay period ends (0 = Monday … 6 = Sunday). Default Friday.
-- Example: every 2 weeks, periods Oct 12 – Oct 25, paid Friday Oct 30.
alter table public.organizations add column if not exists pay_weekday smallint not null default 4 check (pay_weekday between 0 and 6);
