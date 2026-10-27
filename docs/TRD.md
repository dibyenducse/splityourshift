# TRD — SplitYourShift

> Technical Requirements Document: stack, architecture, rules the code must follow.
> **Implemented as:** Vite + React SPA on GitHub Pages, Supabase (Postgres + Auth + Realtime + Edge Functions).
> The actual code layout is in the root README; where this file still mentions Next.js routes, read them as React pages.
> Data model: Schema.md. Build order: Plan.md. Visual reference: `schedule-demo/index.html`.

## 1. Stack
| Layer | Choice |
|---|---|
| Framework | **Vite + React 18** single-page app (HashRouter), TypeScript `strict`. Static build, so it runs on GitHub Pages / any static host |
| UI | Plain CSS with design tokens (`src/styles.css`), light + dark |
| DB / Auth / Realtime | **Supabase** (Postgres 15, Auth, Realtime, RLS) |
| Date/time | `date-fns` + `@date-fns/tz` — no raw `Date` math across zones |
| Validation | `zod` on every server action / route input |
| Drag-and-drop | Own pointer-events implementation (see demo) or `@dnd-kit/core`; must support touch long-press + keyboard alternative |
| SMS | Twilio Programmable Messaging |
| Analytics | First-party tracking into Postgres (`page_views`, `events`); no third-party cookies |
| Server code | Postgres functions (`apply_changes`, `request_time_off`, …) + Supabase Edge Functions (`invite-worker`, `phone-login`) |
| Tests | Vitest (engine, server actions), Playwright (e2e) |
| Hosting | **GitHub Pages** (`.github/workflows/deploy.yml`) + Supabase cloud; npm |

## 2. Project structure
```
/app
  /(marketing)/page.tsx, /pricing, /hotel-shift-scheduling, /gas-station-scheduling
  /(auth)/signup, /login, /w/login
  /app/onboarding            owner wizard
  /app/schedule              week grid (default owner page)
  /app/requests, /app/staff, /app/ledger, /app/settings
  /me, /me/requests          worker
  /admin, /admin/accounts/[id]
  /api/t/route.ts            page-view tracking (POST, beacon)
  /api/cron/stats/route.ts   refresh daily_stats
  /api/cron/notify/route.ts  flush batched SMS
/lib
  /engine/                   PURE rules — no DB, no Next imports
    time.ts  validate.ts  suggest.ts  payback.ts  presets.ts  *.test.ts
  /db/      supabase clients + typed queries
  /sms/     driver (twilio|console), templates en/es
  /analytics/ visitorId(), track(), event names
  /actions/ server actions per domain (schedule, swap, requests, workers, admin)
/supabase/migrations
/docs
```

## 3. Roles, auth & access
- **Admin**: row in `platform_admins`; email + password + **TOTP 2FA** required; only `/admin/*`.
- **Owner**: email auth; `memberships.role = 'owner'`; everything inside their org.
- **Worker**: phone OTP; `memberships.role = 'worker'` + `employee_id`; read-only schedule + time-off requests.
- `middleware.ts` resolves role and returns **404** for routes outside the role.
- RLS on every table (Schema.md). Server actions also check role explicitly; never trust the client.
- Service-role key only in `/api/t`, cron routes, and admin server actions; never in the browser.
- Admin "support view" is read-only and logged to `audit_log`.

## 4. Time rules
- Slots store **local** `start_minute` + `duration_minutes`; assignments store real `starts_at/ends_at`
  computed with the location's IANA zone (overnight + DST handled by the tz library).
- A shift belongs to the local date it **starts** on. Week = Monday 00:00 local → 7 days.
- Overlap: `a.start < b.end && b.start < a.end`. Adjacent (double): `a.end == b.start`.

## 5. Business rules
| Rule | Type | Default |
|---|---|---|
| Worker's shifts in a week > `max_shifts_per_week` | **error** (blocks) | 5 |
| Worker in two overlapping shifts (any location) | **error** | — |
| Back-to-back shifts (double) | warning | — |
| Worker not linked to that location | warning | — |
| A move/trade only errors if it makes things worse (count goes up or a new overlap) | — | — |

## 6. Rules engine (`/lib/engine`) ⭐
Pure and deterministic; the same code runs in the browser (instant drag colors) and on the server (final check).
```ts
type Change = { cellKey: string; employeeId: string | null };   // cellKey = week|location|day|slot
type Issue = { employeeId: string; code: 'OVER_LIMIT'|'OVERLAP'|'DOUBLE'|'NEW_LOCATION'; short: string; message: string };
validate(changes: Change[], ctx: Ctx): { errors: Issue[]; warnings: Issue[] }
coverCandidates(cellKey, ctx): { employeeId; canCover: Result; tradeable: number; weekCount }[]
tradeOptions(cellKey, otherEmployeeId, ctx): { cellKey; result: Result }[]   // other's shifts, this + next 2 weeks
paybackOptions(ledgerEntry, ctx): { cellKey; result: Result }[]
coverage(slots): number[24]                                       // for onboarding bar
PRESETS: { hotel: [...], gas_station: [...] }                     // PRD F1
```
Ordering for "who can take it": no errors → fewer warnings → fewer shifts this week → name.

## 7. Write path
Every grid change calls one Postgres function (Schema.md) that locks affected rows
(`FOR UPDATE`), re-validates, writes, and appends `audit_log`. The client applies the change
optimistically and rolls back with the server's error message if rejected.

## 8. Notifications & SMS
- One SMS per worker on publish (their shifts); change SMS batched (5 min) for published weeks.
- Templates en/es, ≤ 160 chars where possible; `STOP`/`START` handled by Twilio webhook.
- `SMS_DRIVER=console` in development. Store every message in `sms_messages` with cost.

## 9. Analytics for the admin panel
- Client sends `navigator.sendBeacon('/api/t', {path, referrer})` on each route change (marketing + app).
- `/api/t` computes `visitor_id = sha256(daily_salt + ip + user_agent)` (salt rotates daily, raw IP never stored),
  device from UA, country from Vercel header; ignores bots (UA list) and admins.
- Server actions emit `events` for funnel steps (signup_started, signup_completed, onboarding_completed,
  week_published, time_off_requested, sms_sent).
- `daily_stats` materialized view refreshed hourly; admin pages read only from it + `events`.
- Privacy policy page must describe this tracking.

## 10. Non-functional
- Drag colors computed < 50 ms for 2 locations × 3 slots × 7 days; server validation < 200 ms.
- Owner pages LCP < 2.5 s on 4G; grid usable at 390 px width.
- WCAG AA; every drag action has a click alternative.
- No PII in logs (mask phones). Sentry optional via env.

## 11. Testing
- Engine: unit test per rule and the PRD acceptance cases (6th shift blocked; Dibbo/Obi trade).
- RLS: tests per role. E2E (Playwright): sign-up → publish; worker cannot open `/app`; time-off → cover.

## 12. Environment variables
```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_FROM_NUMBER=
SMS_DRIVER=twilio|console
ANALYTICS_SALT_SECRET=
CRON_SECRET=
APP_URL=
```

## 13. Rules for the coding agent
1. Read all 6 docs and open `schedule-demo/index.html` before coding. Conflicts: Schema.md wins for data,
   TRD.md for tech, PRD.md for behavior, the demo for look and interaction.
2. Engine stays pure; write tests first for engine changes.
3. Every DB change = new migration + update Schema.md in the same change.
4. Validate inputs with zod; re-validate every schedule change on the server.
5. Workers must never receive an editing control or an endpoint that edits the schedule.
6. Tick tasks in Plan.md as you finish them.
