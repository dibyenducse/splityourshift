# SplitYourShift

Drag-and-drop shift scheduling for hotels, motels and gas stations.

- **Owners** set up their shifts (hotel or gas-station patterns), drag workers into a weekly grid,
  swap and cover shifts, approve time off, and see a payroll estimate.
- **Workers** get an email invite, set their own password, and see their shifts, hours and pay,
  set their availability, and ask for (or cancel) time off. They can't change the schedule.
- **Admin** (the site owner) sees visitors, sign-ups and every account, read-only.

Live site: `https://dibyenducse.github.io/splityourshift/` once set up (see **[SETUP.md](SETUP.md)**).

## Where the data lives

| What | Where |
|---|---|
| Website files (HTML/JS/CSS) | GitHub Pages, built from this repo on every push to `main` |
| All data: accounts, schedules, requests, pay rates | **Supabase** (hosted Postgres database). Nothing is stored in the browser except the login session. |
| Passwords | Supabase Auth (hashed). The app never sees or emails a password. |
| Invite and reset emails | Supabase Auth, sent through your SMTP provider (e.g. Resend) |

Access rules are enforced inside the database (row-level security), so one business can never read
another's data, and workers can only read what they're allowed to.

## Project layout

```
src/
  pages/        Home, Auth (log in, sign up, set password), Onboarding, Owner, Worker, Admin, AppShell
  components/   WeekGrid (+ drag and drop), ShiftEditor, ui (toasts, sheets)
  lib/          rules.ts (shift limits, overlaps, availability, pay), api.ts (data loading), supabase.ts
supabase/
  migrations/   database tables, access rules and server functions (one SQL file)
  functions/    invite-worker, phone-login (Edge Functions)
docs/           product blueprint: PRD, AppFlow, UI_Spec, TRD, Schema, Plan
.github/workflows/
  deploy.yml    build + publish the site to GitHub Pages
  supabase.yml  set up / update the database and functions
```

## Development

```bash
npm install
cp .env.example .env      # fill in your Supabase URL and anon key
npm run dev               # http://localhost:5173
npm test                  # rule tests
npm run build
```

No local install is needed to run the live site: GitHub Actions builds and deploys it.
