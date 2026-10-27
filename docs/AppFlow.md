# AppFlow — SplitYourShift

> Step-by-step user journeys. Screens are specified in UI_Spec.md. Feature IDs (F1…F9) refer to PRD.md.

## 0. Entry points & routing
| Path | Who | Notes |
|---|---|---|
| `/` | everyone | Marketing landing (tracked for admin analytics) |
| `/signup`, `/login` | owners | email + password / magic link |
| `/w/login` | workers | phone → SMS code |
| `/app/...` | owner | schedule, staff, requests, ledger, settings |
| `/me/...` | worker | my shifts, schedule (read-only), requests |
| `/admin/...` | admin | analytics + accounts; 2FA |

After login: `admin` → `/admin`, `owner` → `/app` (or `/app/onboarding` if no location yet),
`worker` → `/me`. Any route outside a user's role returns 404 (not 403).

## 1. Owner sign-up & onboarding (F1)
1. `/signup`: name, email, password, business name → verify email.
2. **What do you run?** Hotel/motel · Gas station.
3. **Set up your shifts**: location name; preset cards (suggested one pre-selected);
   editable rows (start, length, add/remove); 24h coverage bar.
4. **Add your workers**: names (one per line), optional phones, default max shifts/week;
   in "add location" mode also tick existing workers who work there.
5. **Create my schedule** → `/app/schedule` current week, empty grid, banner
   "Drag names from the staff list into the shifts".
6. Later: **+ Add a hotel or gas station** reruns steps 2–4. **Edit shifts** on a grid
   reopens step 3 for that location (removing a shift row clears its assignments after a warning).

## 2. Weekly scheduling (F3)
1. Owner opens Schedule → week picker. Empty week → **Copy last week** (if one exists).
2. Drag names from the staff list into slots (or tap name → tap slot).
3. Each drop is validated on the client for instant colors, then **re-validated on the server**:
   - error → nothing saved, red toast with reason, slot shakes;
   - warning → saved, amber toast.
4. Drag slot → slot: empty target = move; filled target = trade (both validated).
5. Drag slot → staff list (or "remove" bar) = make the slot open.
6. **Publish week** → each affected worker gets one SMS with their shifts.
   Later edits to a published week → "Notify changes" sends only the diffs.

## 3. Swap / cover (F4, F5) — owner only
```mermaid
sequenceDiagram
  participant O as Owner
  participant S as System
  O->>S: Click Dibbo · Wed Microtel 11–7 → "Swap or find cover"
  S->>O: Coworkers list: "Can cover" / "At limit" + number of tradeable shifts
  O->>S: Pick Obi
  S->>O: Option A: Obi covers (blocked if Obi at limit)<br/>Option B: Obi's shifts (this + next 2 weeks) with ok/blocked per row
  alt Trade
    O->>S: Click Obi's Thu 3–11
    S->>S: Dibbo→Thu 3–11, Obi→Wed 11–7 (one transaction)
  else Cover
    O->>S: "Obi covers this shift"
    S->>S: Obi→Wed 11–7, ledger: Dibbo owes Obi 1
  end
  S->>O: Toast + grid updated; affected workers notified if week published
```
**Pay back:** Shifts owed → Pay back → creditor's upcoming shifts the debtor can take →
click → reassigned + ledger settled.

## 4. Time off (F6, F7)
1. Worker `/me` → **Request time off** → ticks shift(s) in the next 2 weeks → reason → Send.
2. Owner gets SMS + badge; the shift shows an "off?" flag on the grid.
3. Owner: **Approve & find cover** → opens the swap flow (§3) for that shift;
   or **Deny** (optional note).
4. Worker sees status on the shift card and in My requests; gets SMS.
5. **Cancel**: while pending, the worker taps Cancel request → status Cancelled, owner gets a notification,
   the shift stays theirs. Approved/denied requests can't be cancelled by the worker.
Edge cases: a worker can't request the same shift twice while pending; cancelled
requests stay in history as Cancelled; requests on shifts that were reassigned meanwhile are auto-closed.

## 5. Worker onboarding (F6)
1. Owner adds worker with email and/or phone → **Send invite** → email (or SMS) with a one-time link (7 days).
2. Link → `/invite/<token>` → "Welcome, Maria": email + phone shown read-only → choose password ×2 → logged in at `/me`.
3. Next time: `/w/login` with email **or** phone + password. "Forgot password?" → reset link (24 h), same page.
4. Used or expired link → friendly page ("already used, log in" / "expired, ask your manager to resend").
5. Worker never sees owner tools; all `/app` routes return 404.

## 6. Admin (F8)
1. Admin logs in (email + password + TOTP 2FA) → `/admin`.
2. Overview: visitors chart, sign-ups, funnel, totals.
3. Accounts: search owner → detail (locations, worker count, last active, plan, SMS usage)
   → **Support view** (read-only schedule) or **Suspend**.
4. All admin actions written to `audit_log`.
