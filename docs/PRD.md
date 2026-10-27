# PRD — SplitYourShift (working name)

> Product Requirements Document. Source of truth for **what** we build and **why**.
> Read this first. Other docs: AppFlow.md → UI_Spec.md → TRD.md → Schema.md → Plan.md
> Clickable reference demo: `schedule-demo/index.html` (owner / worker / admin views).

## 1. Summary
SplitYourShift is a shift-scheduling web app for small **24/7 businesses in the USA**:
independent **hotels/motels** and **gas stations**. Many owners run more than one
of these, with mixed shift patterns (3×8h, 2×12h, 10h, overnight, doubles) and staff
who work at more than one location.

The owner builds the week by **dragging workers into shift slots** on a visual
week grid (like the paper schedule they use today). The app blocks mistakes
(too many shifts, double-booking) and makes **swaps and cover** fast: pick who takes
a shift, see that person's shifts, and trade one back in one click — or record it
as owed and pay it back next week.

## 2. Problem
- Owners build schedules on paper or Excel and text photos to staff.
- When someone needs a day off, the owner has to figure out who is free and
  who would go over their hours, usually by phone.
- Swaps are agreed verbally and forgotten; staff feel it is unfair.
- Generic apps (Homebase, When I Work, Sling) are built for restaurants/retail;
  hotel tools (Harri, Hotel Effectiveness) are expensive and for chains.

## 3. Account types (exactly three)
Public home page (`/`) explains the product (features, how it works, hotel vs gas station, pricing, about/team, FAQ) with **Sign up** and **Log in**; signing up starts the owner wizard (F1).

| Account | Who | Can do | Cannot do |
|---|---|---|---|
| **Admin** | Me, the platform owner | See the admin panel: visitors, sign-ups, funnel, all owner accounts, usage, plans. Suspend/delete accounts. | Edit an owner's schedule (read-only support view only) |
| **Owner** | Hotel or gas station owner | Create locations and shift slots, add/edit/delete workers, drag-and-drop the schedule, publish, approve/deny time off, swap/cover, ledger | See other owners' data |
| **Worker** | Hourly employee of one owner | See their own shifts and the full schedule of their locations (read-only), **send time-off requests**, see request status, edit own phone/language | Move anyone, swap, edit the schedule, see other owners |

Manager (owner's helper with owner powers on some locations) is **later, not MVP**.

## 4. Goals (MVP)
1. Owner sign-up to first published week in **< 15 minutes**.
2. Weekly schedule in **< 10 minutes** (copy last week + drag changes).
3. Zero accidental over-scheduling: going over a worker's weekly shift limit is
   **blocked with a clear error**.
4. A swap or cover takes **≤ 3 clicks** after opening the shift.
5. Workers see their schedule on their phone without asking the owner.
6. Admin can see traffic and sign-up funnel daily.

## 5. Non-goals (MVP)
Payroll processing (tax filing, direct deposit), tips, POS integration, GPS time clock, native mobile apps, city-specific
labor laws (Fair Workweek), manager role, worker-initiated swaps.

## 6. MVP features & acceptance criteria

### F1. Owner sign-up & onboarding wizard
1. Account: name, email, password (or magic link), business name.
2. **"What do you run?" → Hotel/motel, Gas station, or Shop/store.**
3. **Shift setup with suggestions** based on the answer:
   - Hotel: **3 × 8h (7a–3p, 3p–11p, 11p–7a)** ← suggested; 2 × 12h (7a–7p, 7p–7a); Custom.
   - Gas station: **3 × 8h (6a–2p, 2p–10p, 10p–6a)** ← suggested; 3 × 10h overlapping
     (5a–3p, 1p–11p, 9p–7a); 2 × 12h (6a–6p, 6p–6a); Custom (not open 24h, etc.).
   - Shop: **2 × 6h (9a–3p, 3p–9p)** ← suggested; 1 × 10h (10a–8p); 3 × 8h (24h store); Custom.
   - Every shift row is editable: start hour + length (2–16h); add/remove rows.
   - A **24-hour coverage bar** shows hours with nobody (closed/gap) and hours with 2+ people.
4. Add workers: one row per person with name, email or phone, **their own** max shifts/week and hourly rate.
5. Lands on the week grid for the current week.
- Owner can add more locations later with the same wizard (steps 2–4); a worker can
  belong to several locations.
- AC: a gas-station owner can create 5a–3p, 1p–11p, 9p–5a shifts and see them as 3 grid rows.

### F2. Worker profiles (owner-managed)
- Name, phone (US, used for login + SMS), language (en/es), locations, **max shifts per week**
  (default 5), optional hourly rate. Each worker gets a color.
- Owner can see a profile: this week's shifts, hours, shift balance (owes / is owed).
- Owner can delete a worker (their future shifts become open; confirm step).
- AC: profile shows "5/5" when at limit.

### F3. Visual week grid with drag-and-drop ⭐
- One grid per location: **rows = shift slots, columns = Mon–Sun with dates**
  (same layout as the paper schedule). Today's column highlighted.
- Staff list on the side; each name shows **shifts this week / max**.
- Drag a name into a slot → assigned. Drag a slot onto another slot → **move or trade**.
  Drag a slot back to the staff list → remove. Tap-name-then-tap-slot works on phones.
- While dragging, slots turn **green (ok) / amber (warning) / red (not allowed)** with the reason.
- **Blocking errors**: over weekly shift limit (e.g. 6th shift for a max-5 worker),
  overlapping shifts (same time at two locations).
- **Warnings** (allowed): back-to-back double, worker not usually at that location.
- Copy last week; Undo; open slots highlighted; Publish week (notifies workers).
- AC: dragging a max-5 worker into a 6th slot shows "X already has 5 of 5 shifts…" and nothing changes.

### F4. Swap / cover (owner) ⭐
Click a filled shift → **Swap or find cover** → pick a coworker → choose:
- **Trade**: the app lists the coworker's shifts (this week + next 2 weeks), each marked
  whether the original worker can take it (conflict / limit / double). One click swaps both.
- **Cover, pay back later**: coworker takes it as an extra shift (only if under their limit);
  a ledger entry "A owes B 1 shift" is created.
- AC: Dibbo's Wed Microtel 11–7 → Obi: Obi's Mon 3–11 is blocked (Dibbo works Hojo then),
  Thu 3–11 is offered; clicking it swaps both shifts.

### F5. Shift ledger & payback ⭐
- Open balances listed ("Dibbo owes Obi 1 shift").
- **Pay back**: shows the creditor's upcoming shifts the debtor can take → one click
  reassigns and settles. Also "Mark settled".

### F6. Worker app (read-only + time off)
- Login with email or phone + password, set through the invite link (F13).
- **My shifts** (this week / next), hours, request status on each shift.
- **Full schedule** of their locations, read-only, own shifts highlighted.
- **Request time off**: tick one or more upcoming shifts + reason → owner notified.
- **Cancel request** while it is pending (owner is notified; shift stays theirs). After approval or denial the worker can't change it; they talk to the owner.
- No drag-and-drop, no swap, no access to other workers' profiles.

### F7. Time-off requests (owner side)
- Requests list with count badge; shift also shows an "off?" flag on the grid.
- **Approve & find cover** → opens the swap/cover flow for that shift. **Deny** → worker keeps shift.
- Worker gets SMS + in-app status.

### F10. Payroll estimate (owner) ⭐
- Owner sets each worker's **hourly rate** (profile or directly in the payroll table).
- Owner picks the **pay schedule**: weekly or every 2 weeks (biweekly, anchored to a start date).
- **Overtime** toggle: 1.5× for hours over 40 in a workweek (FLSA default; per-week, even in a biweekly period).
- Payroll page per pay period: worker, rate, shifts, hours (per-week split for biweekly), overtime hours,
  **covered for others** (extra shifts taken without a trade, count + amount, already included), gross pay; totals.
- Trades don't change pay (both keep the same hours). Covers move the hours (and pay) to the person who worked.
- Shown as an **estimate before taxes**; actual payroll export is later.

### F11. Worker availability ⭐
- Worker sets **My availability** per weekday: Any time / Only these hours (from–to, may cross midnight) / Not available.
- Owner sees it in the worker profile; placing someone outside it is allowed but gives an
  **"Unavailable" warning** (amber drop color, `n/a` flag on the chip, shown in swap/cover lists).
- Owner gets one notification when a worker updates availability.
- One-off days off still go through time-off requests.

### F12. Worker pay view
- Worker sees **My pay** for the current pay period: estimated pay, hours (per week), rate, overtime, this week's pay,
  and extra shifts they covered. Read-only; rate is set by the owner.

### F13. Worker invites & login ⭐
- Workers never sign up. The owner adds them (name + email and/or phone) and taps **Send invite**
  (or adds them in the onboarding wizard as "Name, email or phone").
- Invite = email (or SMS if no email) with a **one-time link**, valid **7 days**.
  The link opens **Set your password**: email/phone shown read-only, password ×2 (min 8 chars) → logged in.
- **Never email a password.** No generated passwords.
- Afterwards the worker logs in with **email or phone + password**. Change password in My profile.
- **Forgot password** on the log-in page sends a reset link (valid 24 h). The response is the same
  whether or not the email/phone exists (no account guessing).
- Owner sees login status per worker: **Active / Invited / Link expired / Not invited**, with
  Resend invite and Send password reset link in the profile. Owner is notified when a worker activates.
- Optional later: log in with a 6-digit SMS code instead of a password.

### F14. Time clock & shift reminders ⭐
- **Reminders on the worker's phone** (web push; Android Chrome, desktop, and iPhone after "Add to Home Screen"):
  "Time to clock in" from 10 min before a shift starts; "Time to clock out" when it ends (only if still clocked in).
  Sent once each by a 5-minute server job; also shown in the in-app notification list.
- **Big round Clock in button** in the worker app, active from 30 min before the shift until it ends.
  While clocked in it turns into a glowing green light with a running timer, plus a **Clock out** button.
- Only finished entries (clock in + clock out) count for **pay**. Payroll shows scheduled vs worked hours,
  overtime on worked hours, and how many people are still clocked in.
- **Manual fixes**: workers send "Fix my hours" (shift, in, out, reason) → owner approves/denies;
  owners can add, edit, delete hours and "Clock out now" from the **Time clock** tab, which also lists
  who is on the clock and finished shifts with no clock-in.
- Business time zone (owner profile) is used for reminders and the clock-in window.
- **Emergency cover**: any worker can "Clock in for another shift" on a shift happening now (someone else's or open).
  The shift moves to them, a ledger entry "X owes Y 1 shift" is created for a later trade, and the owner and the
  original worker are notified. Blocked if someone already clocked in for that shift.
- **Late clock-in**: more than 10 min after the start, the worker chooses "Start from now" or "I started at <scheduled>".
  The second records a claimed start; pay uses the real clock-in until the owner approves it ("Late clock-ins to confirm").

### F15. Printing
- Every schedule board has a **Print** button (owner and worker); owners with several locations also get **Print all locations**.
- Prints landscape, one location per page, with the week dates, in light colors even when the app is in dark mode.

### F8. Admin panel ⭐
- Visitors per day (last 14/30/90 days), unique visitors, top pages, referrers, devices.
- Sign-up funnel: visited → started sign-up → finished shift setup → published first week.
- Owner accounts table: business, type (hotel/gas/both), locations, workers, joined,
  last active, plan; search; open read-only support view; suspend.
- Totals: owners, workers, locations by type, time-off requests, SMS sent (cost).
- Admin access only for allow-listed admin users (2FA required).

### F9. Notifications
In-app bell with unread count (owner + worker), each item links to its action (owner can Approve & find cover / Deny right from the notification). SMS (Twilio) + in-app: worker invite, week published, my shift changed,
time-off approved/denied. Owner: new time-off request, request cancelled by worker.

## 7. Success metrics (first 3 months after launch)
- 20 paying locations; ≥ 70% of owners publish weekly.
- ≥ 5% visitor → sign-up; ≥ 60% sign-up → first published week.

## 8. Business model (to validate)
Free: 1 location, up to 10 workers. Pro: $39/location/month. 14-day trial. Stripe (phase 2).

## 9. Open questions
- Should workers see coworkers' names on the schedule? (default yes, like the paper sheet)
- Does an owner want a printable/PDF weekly sheet to pin at the front desk? (likely yes, phase 2)
- Gujarati/Hindi UI for owners?
