# Plan — SplitYourShift build plan

> Ordered tasks for the coding agent. Do phases in order; tick `[x]` when done.
> Each task must leave the app building, typechecking and tests passing. Rules: TRD.md §13.
> Visual reference for every owner/worker/admin screen: `schedule-demo/index.html`.

## Phase 0 — Setup
- [ ] Next.js 15 + TypeScript strict + pnpm + Tailwind + shadcn/ui + ESLint/Prettier
- [ ] next-intl (en, es); fonts per UI_Spec §2; light/dark tokens
- [ ] Supabase local + `pnpm db:types`; Vitest + Playwright; CI (typecheck, lint, unit)
- [ ] `.env.example` from TRD §12

## Phase 1 — Data, roles & auth
- [ ] Migrations for every table in Schema.md (platform, tenancy, people, scheduling, requests, ledger, analytics, system)
- [ ] Helper functions + RLS policies; RLS tests (owner A ≠ org B; worker can't read drafts or other workers' requests; non-admin can't read analytics)
- [ ] Owner sign-up/login (email); worker login (phone OTP); admin login + TOTP
- [ ] Role routing + middleware: wrong role → 404 (AppFlow §0)
- [ ] Seed: Microtel + Hojo (3×8h) with the 10/26/2026 paper schedule, 11 workers, 1 pending time-off request

## Phase 2 — Rules engine (pure, test-first) ⭐
- [ ] `time.ts`: slot → instants (overnight, DST), overlap, adjacency, weekly counts/hours
- [ ] `validate.ts`: errors (over weekly shift limit, overlap) / warnings (double, not usual location); one test each
- [ ] `suggest.ts`: cover candidates + trade options (this + next 2 weeks) — AC from PRD F4 (Dibbo/Obi case) as a test
- [ ] `payback.ts`: creditor's upcoming shifts the debtor can take

## Phase 3 — Owner onboarding
- [ ] Wizard steps 1–4 (UI_Spec §3.4): account, business type, shift presets + editor + 24h coverage bar, workers
- [ ] Presets per PRD F1 (hotel h3/h2/custom, gas g3/g10/g2/custom)
- [ ] "Add a hotel or gas station" (steps 2–4) and "Edit shifts" sheet
- [ ] Events: signup_started, signup_completed, onboarding_completed

## Phase 4 — Week grid & drag-and-drop ⭐
- [ ] Board per location (rows = slots, cols = days), staff list with n/max
- [ ] Drag-and-drop with pointer events (mouse + touch long-press) + tap-to-place fallback
- [ ] Live drop colors from engine; server functions `place_assignment`, `move_or_trade`; error toast + shake
- [ ] Remove by dragging to staff list / remove bar; Undo (last 40 actions)
- [ ] Copy last week; Publish + notify changes; week picker; realtime refresh

## Phase 5 — Swap, cover, ledger
- [ ] Shift sheet; Swap step 1 & 2 (UI_Spec §3.3); `trade_shifts`, `cover_shift`
- [ ] Shifts owed panel; Pay back sheet; `pay_back`; mark settled
- [ ] Worker profile sheet (limits, locations, balance, delete with confirm)

## Phase 6 — Worker app & time off
- [ ] `/me`: my shifts, read-only boards (own highlighted), my requests
- [ ] Request time off sheet → owner badge + "off?" flag
- [ ] Owner: Approve & find cover (opens swap flow) / Deny
- [ ] Spanish strings for all worker screens

## Phase 6b — Pay & availability
- [ ] Engine: `payFor(employee, weeks)` (hours, OT per week, cover hours, gross) + unit tests (40 h boundary, biweekly split)
- [ ] Owner Payroll tab: pay schedule, OT toggle, inline rate edit, totals; profile shows rate + period pay
- [ ] Worker My pay panel (read-only)
- [ ] Worker My availability editor; engine warning `UNAVAILABLE`; `n/a` chip flag; owner notification
- [ ] RLS: worker can read only their own rate and pay

## Phase 6c — Worker invites
- [ ] `worker_invites` table + server action `sendInvite(employeeId)` (email via Resend/Postmark, SMS via Twilio)
- [ ] `/invite/[token]` set-password page → create Supabase Auth user (email or phone identity) → link `employees.user_id`
- [ ] Worker login with email or phone + password; forgot-password reset link; change password in profile
- [ ] Owner: login status tags, Resend invite, Send reset link; notification on activation
- [ ] Tests: expired link, reused link, wrong password, unknown email gives the same response

## Phase 7 — SMS
- [ ] Twilio driver (console in dev); invite, week published, shift changed, request decided, new request (owner)
- [ ] STOP/START handling; A2P 10DLC registration before launch

## Phase 8 — Admin panel
- [ ] First-party tracking route `/api/t` (page_views, no cookies, hashed visitor id) + events from server actions
- [ ] `daily_stats` view + hourly refresh cron
- [ ] `/admin` overview: tiles, daily visitors chart, sign-up funnel, top pages/referrers, date range
- [ ] Accounts table, detail, read-only support view, suspend; all actions → audit_log

## Phase 9 — Launch
- [ ] Landing pages: home, pricing, /hotel-shift-scheduling, /gas-station-scheduling
- [ ] E2E: sign-up → publish; 6th-shift error; Dibbo/Obi trade; time-off → cover; worker can't reach /app
- [ ] Sentry; Vercel + Supabase prod; custom domain

## Later (not MVP)
Stripe billing · manager role · printable weekly sheet (PDF) · more than 1 person per slot ·
SMS open-shift broadcast ("reply YES") · GPS time clock · payroll export ·
Fair Workweek / California daily OT rules · native apps · Gujarati/Hindi UI
