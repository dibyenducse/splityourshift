# Schema — SplitYourShift (Postgres / Supabase)

> Data model. Migrations in `/supabase/migrations` must match this file.
> All tables: `id uuid pk default gen_random_uuid()`, `created_at timestamptz default now()`,
> `updated_at timestamptz` (trigger). RLS **enabled** on all. Times are `timestamptz` unless noted.

## Enums
```sql
create type member_role    as enum ('owner','worker');           -- admin is separate (platform_admins)
create type location_type  as enum ('hotel','gas_station');
create type week_status    as enum ('draft','published');
create type request_status as enum ('pending','approved','denied','cancelled');
create type ledger_reason  as enum ('cover','trade','payback','manual');
create type ledger_state   as enum ('open','settled','forgiven');
create type lang           as enum ('en','es');
```

## Platform
### platform_admins
| col | type | notes |
|---|---|---|
| user_id | uuid pk fk auth.users | only these users can open `/admin` |
| totp_enabled | bool not null default false | 2FA required to use admin routes |

## Tenancy
### organizations  (one per owner business)
| col | type | notes |
|---|---|---|
| name | text not null | "Patel Hospitality" |
| owner_user_id | uuid fk auth.users | |
| primary_time_zone | text not null | IANA |
| week_start_day | smallint not null default 1 | 1 = Monday |
| plan | text not null default 'free' | free / trial / pro |
| status | text not null default 'active' | active / suspended (admin) |
| onboarding_completed_at | timestamptz null | funnel step |
| first_published_at | timestamptz null | funnel step |
| last_active_at | timestamptz null | admin table |

### memberships
| col | type | notes |
|---|---|---|
| org_id | uuid fk | |
| user_id | uuid fk auth.users | |
| role | member_role | |
| employee_id | uuid fk employees null | required when role = worker |
unique (org_id, user_id)

### locations
| col | type | notes |
|---|---|---|
| org_id | uuid fk | |
| name | text not null | "Microtel" |
| type | location_type not null | chosen in onboarding |
| address | text | |
| time_zone | text not null | IANA |
| preset | text null | 'h3','h2','g3','g10','g2','custom' (analytics) |
| archived_at | timestamptz null | |

### shift_slots  (rows of the week grid)
| col | type | notes |
|---|---|---|
| org_id, location_id | uuid fk | |
| start_minute | int not null check (start_minute between 0 and 1439) | **local** time, minutes after midnight |
| duration_minutes | int not null check (duration_minutes between 60 and 960) | 1–16 h |
| sort_order | smallint not null | |
| label | text null | optional, e.g. "Night audit" |
| active | bool default true | removing = set false + clear future assignments |

## People
### employees  (workers)
| col | type | notes |
|---|---|---|
| org_id | uuid fk | |
| name | text not null | |
| phone | text null | E.164; unique per org when set; worker login |
| language | lang default 'en' | |
| max_shifts_per_week | smallint not null default 5 check (between 1 and 21) | **hard limit** |
| hourly_rate_cents | int not null default 0 | set by owner; used for payroll estimate |
| color_hue | smallint not null | 0–359 |
| status | text check in ('invited','active','inactive') default 'invited' | |
| sms_opt_out | bool default false | |

### availability_rules  (set by the worker)
| col | type | notes |
|---|---|---|
| employee_id | uuid fk | |
| day_of_week | smallint check (0..6) | 0 = Monday; one row per day |
| mode | text check in ('any','hours','off') | |
| from_minute, to_minute | int null | local; to <= from means it crosses midnight |
unique (employee_id, day_of_week)

### pay_settings  (one per organization)
| col | type | notes |
|---|---|---|
| org_id | uuid pk fk | |
| pay_period | text check in ('weekly','biweekly') default 'weekly' | |
| period_anchor | date not null | first day of a pay period (biweekly) |
| overtime_enabled | bool default true | 1.5× after `overtime_weekly_minutes` |
| overtime_weekly_minutes | int default 2400 | 40 h |

### worker_invites
| col | type | notes |
|---|---|---|
| employee_id | uuid fk | |
| kind | text check in ('invite','reset') | |
| token_hash | text not null | sha-256 of the random token; the raw token is only in the link |
| sent_to | text not null | email or phone used |
| expires_at | timestamptz not null | invite 7 days, reset 24 h |
| used_at | timestamptz null | one-time use |
Passwords live in Supabase Auth (hashed); `employees.user_id` links the worker to `auth.users` once activated.
`employees.email text null` (unique per org when set). Login status = active (user_id set) / invited / expired / none.

### employee_locations
`employee_id`, `location_id` — pk (employee_id, location_id). "Usually works at" (warning only if missing).

## Scheduling
### schedule_weeks
| col | type | notes |
|---|---|---|
| org_id, location_id | uuid fk | |
| week_start | date not null | local Monday |
| status | week_status default 'draft' | |
| published_at | timestamptz null | |
| has_unnotified_changes | bool default false | |
unique (location_id, week_start)

### assignments  (one filled cell of the grid)
| col | type | notes |
|---|---|---|
| org_id, location_id | uuid fk | |
| schedule_week_id | uuid fk | |
| slot_id | uuid fk shift_slots | |
| day_index | smallint check (0..6) | 0 = Monday |
| starts_at, ends_at | timestamptz not null | materialized from slot + date + zone |
| employee_id | uuid fk not null | |
unique (slot_id, schedule_week_id, day_index) — one person per cell (headcount > 1 is later)
index (employee_id, starts_at)

## Requests & ledger
### time_off_requests
| col | type | notes |
|---|---|---|
| org_id, employee_id | uuid fk | |
| assignment_id | uuid fk | the shift asked off |
| reason | text | |
| status | request_status default 'pending' | |
| decided_by | uuid null, decided_at timestamptz null, decision_note text | |
unique (assignment_id) where status = 'pending'

### shift_ledger
| col | type | notes |
|---|---|---|
| org_id | uuid fk | |
| debtor_employee_id | uuid fk | the person whose shift was covered |
| creditor_employee_id | uuid fk | who worked it |
| covered_assignment_id | uuid fk | |
| reason | ledger_reason | |
| state | ledger_state default 'open' | |
| settled_with_assignment_id | uuid null | the payback shift |
| resolved_by | uuid null, resolved_at timestamptz null | |

## Analytics (admin panel)
### page_views
| col | type | notes |
|---|---|---|
| visitor_id | text not null | daily-rotating hash of IP + UA + salt (no cookies, no raw IP stored) |
| path | text not null | |
| referrer_host | text null | |
| device | text null | mobile / desktop / tablet |
| country | text null | from edge header |
| user_id | uuid null | if logged in |
| ts | timestamptz not null default now() |
index (ts), (path, ts)

### events
| col | type | notes |
|---|---|---|
| name | text not null | 'signup_started','signup_completed','onboarding_completed','week_published','time_off_requested','sms_sent' |
| org_id | uuid null | |
| user_id | uuid null | |
| props | jsonb default '{}' | |
| ts | timestamptz default now() | |
View `pay_period_summary(org_id, employee_id, period_start, hours, ot_hours, cover_hours, gross_cents)` computed from assignments + rates + pay_settings.
Materialized view `daily_stats(day, visitors, signups, onboarded, published)` refreshed hourly.

## System
- `notifications(org_id, user_id, type, payload jsonb, read_at)`
- `sms_messages(org_id, employee_id, direction, to_phone, body, twilio_sid, status, cost_cents)`
- `audit_log(org_id null, actor_user_id, entity, entity_id, action, before jsonb, after jsonb)` — includes admin actions.

## Database functions (security definer, check membership inside)
- `place_assignment(slot_id, week_start, day_index, employee_id)` → validates (limit, overlap) + upserts.
- `move_or_trade(from_assignment_id, to_slot_id, to_week_start, to_day_index)` → move or swap atomically.
- `cover_shift(assignment_id, new_employee_id)` → reassign + ledger(open).
- `trade_shifts(assignment_a, assignment_b)` → swap employees atomically.
- `pay_back(ledger_id, assignment_id)` → reassign to debtor + settle.
- Helpers: `is_admin()`, `org_role(org_id)`, `current_employee_id(org_id)`.
All write functions `SELECT … FOR UPDATE` the affected rows and re-run the validation server-side.

## RLS summary
| table | admin | owner | worker |
|---|---|---|---|
| organizations | read all, update status | read/update own | read own (name only) |
| locations, shift_slots | read all | CRUD own org | read own locations |
| employees | read all | CRUD own org | read self (incl. own rate); coworkers name+color only via view |
| availability_rules | read all | read own org | CRUD own rows |
| pay_settings | read all | CRUD own org | read |
| schedule_weeks, assignments | read all | CRUD own org | read own locations, **published weeks only** |
| time_off_requests | read all | read/update own org | insert/read/cancel own |
| shift_ledger | read all | CRUD own org | none |
| page_views, events, daily_stats | read | none | none |
| audit_log, sms_messages | read | read own org | none |
Inserts into page_views/events happen only through the service-role tracking route.
