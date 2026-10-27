# UI Spec — SplitYourShift

> Screens, layout and components. Flows are in AppFlow.md.
> **Visual reference: `schedule-demo/index.html`** — match its grid, staff list, sheets and wizard.
> Owner side: desktop-first, must work on phone. Worker side: phone-first. Admin: desktop.

## 1. Principles
- The week grid looks like the **paper schedule** owners already use: shifts down, days across.
- Owners aren't technical: plain words ("Swap or find cover", "Leave shift open").
- **Block real mistakes, warn on the rest.** Errors say what's wrong and how to fix it.
- Every suggestion explains itself (tags like "Can cover", "At limit (5/5)", "Busy · Hojo 3–11").
- Workers never see an editing control.

## 2. Visual system
- Tailwind + shadcn/ui. Fonts: Barlow Semi Condensed (headings), Source Sans 3 (body), JetBrains Mono (times, dates, counts).
- Tokens (light + dark): `bg`, `surface`, `surface-2`, `line`, `fg`, `muted`, `accent` (steel blue),
  `ok` (green), `warn` (amber), `bad` (red) + soft variants.
- Each worker has a stable hue; chips use a light tint of it (dark tint in dark mode).
- 12-hour times ("7 am – 3 pm"), short form in grid ("7–3"). Dates M/D. Location time zone.
- Min touch target 44px. Warnings use icon/text, never color alone.

## 3. Owner (`/app`)

### Layout
Top bar: product name + business name · week picker (‹ Oct 26 – Nov 1, 2026 ›) · Undo · Publish.
Left rail (stacks above grid on phones): **Staff**, **Time-off requests** (badge), **Shifts owed**.
Main: one **board per location**, then "+ Add a hotel or gas station".

### 3.1 Staff list
Card per worker: color dot · name · `n/max` count (amber at limit, red over) · "Profile".
Cards are draggable; tap selects (shows bottom bar "Tap a shift to place X · Cancel").
Phone: horizontal scrolling row.

### 3.2 Board (week grid) ⭐
- Header: location name, type pill (HOTEL / GAS STATION), "3 × 8-hour shifts", "n open" (red), "Edit shifts".
- Table: first column = shift (short time, long time + hours); 7 day columns with name + date; today tinted.
- Cell: worker chip, or dashed red "Open". Flags inside chip: `2×` (back-to-back double), `off?` (pending time-off).
- Drag states: target cells tinted green/amber/red; hovered cell outlined; floating ghost shows
  name + what will happen ("Replace Obi", "Trade with Reshma", or the error text).
  When dragging a chip, a "Drop here to remove from shift" bar appears at the bottom.
- Click a cell → Shift sheet. Mobile: table scrolls horizontally inside its card; long-press (260 ms) to drag.
- Empty week banner: "No shifts yet … [Copy last week]".

### 3.3 Sheets (right panel; bottom sheet on phones)
- **Shift**: slot card (chip + location · time · date). Filled: [Swap or find cover] [Profile] [Leave shift open].
  Open: "Who can take it" list sorted best-first with Works / warning / blocked tags.
- **Swap step 1** "Replace Dibbo": coworkers with `n/max`, "k shifts to trade", tag (Can cover / At limit / Busy).
- **Swap step 2** "With Obi": Option A card "Obi covers, Dibbo pays back later" (disabled with reason if not allowed);
  Option B card "Trade: Dibbo takes one of Obi's shifts" — list of Obi's shifts, each with result text and Trade/No tag.
  Suggested option gets the accent border. "‹ Pick someone else".
- **Pay back**: creditor's upcoming shifts the debtor can take + "Mark settled without a shift".
- **Profile**: name, phone, max shifts/week, works-at checkboxes, this week's shifts + hours, balance,
  "See what X sees", Delete (click twice).
- **Edit shifts**: location name + shift editor + coverage bar; warns how many assignments a removed row clears.

### 3.4 Onboarding wizard (`/app/onboarding`)
Centered card, progress bar (4 steps new owner / 3 steps add location).
1. Create your owner account (name, email, business name).
2. What do you run? — two big choice cards: **Hotel or motel** / **Gas station**.
3. Set up your shifts — location name; preset choice cards with "Suggested" tag; shift editor rows
   (start select, length select, remove ×; "+ Add a shift"); **24h coverage bar**
   (green 1 person, amber 2+, dashed red nobody) with ticks 12 am / 6 am / 12 pm / 6 pm.
4. Add your workers — textarea one name per line; existing workers checkboxes (add mode);
   default max shifts per week. Button: "Create my schedule".

## 4. Worker (`/me`) — read-only + time off
- Header: name, week picker. No Undo / Publish / drag handles anywhere.
- **My shifts**: cards (day + date, time + hours, location; colored left edge; request status tag).
- Button **Request time off** → sheet: checkbox list of upcoming shifts (2 weeks), reason, Send.
- **My requests**: list with Pending / Approved / Denied tags.
- **Schedule**: the boards for their locations, read-only, own chips outlined, others dimmed.
- Profile: phone, language (en/es).

## 5. Admin (`/admin`)
- Warning-tinted banner when showing sample/test data.
- Stat tiles: visitors (with change vs previous period), sign-ups, owner accounts (hotel/gas split),
  worker accounts, time-off requests, SMS sent.
- **Daily visitors** bar chart (gridlines, last bar emphasized + labeled, tooltip per bar).
- **Sign-up funnel**: horizontal bars visited → started → finished setup → published week, with counts.
- **Owner accounts** table: business, type, locations, workers, joined, last active, plan; search; row → detail.
- **Most visited pages** and referrers tables. Date range selector (14 / 30 / 90 days).

## 6. Feedback & states
- Toasts bottom-center: Done (green), Done, check this (amber), Can't do that (red, 6.5 s).
- Destructive actions confirm in place (button turns red "Click again to …").
- Realtime: requests badge and grid update live when another device changes data.

## 7. Accessibility
WCAG AA contrast in both themes; grid cells focusable (Enter opens shift sheet); every
drag action has a click alternative (tap-to-place, swap sheet, remove button); labeled inputs.
