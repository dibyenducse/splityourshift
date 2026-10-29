import type { Avail, Bundle, Emp, Org, Slot } from './types';
import { DAY_LONG, addDays, daysBetween, mondayOf, mmdd, norm, shiftShort, ampm, DAY_SHORT } from './time';

export const cellKey = (slotId: string, date: string) => `${slotId}|${date}`;
export const parseCell = (k: string) => { const [slot, date] = k.split('|'); return { slot, date }; };

const EPOCH = '2020-01-06'; // a Monday
export type Changes = Record<string, string | null>;
export interface Issue { short: string; msg: string }
export interface Result { errors: Issue[]; warnings: Issue[] }

export function slotOf(b: Bundle, k: string): Slot | undefined { return b.slots.find((s) => s.id === parseCell(k).slot); }
export const empOf = (b: Bundle, id: string | null | undefined) => (id ? b.emps.find((e) => e.id === id) : undefined);
export const locName = (b: Bundle, id: string) => b.locs.find((l) => l.id === id)?.name ?? '?';
export const valid = (b: Bundle, k: string) => !!slotOf(b, k);
export const absStart = (b: Bundle, k: string) => daysBetween(EPOCH, parseCell(k).date) * 24 + slotOf(b, k)!.start_hour;
export const absEnd = (b: Bundle, k: string) => absStart(b, k) + slotOf(b, k)!.hours;

export function slotLabel(b: Bundle, k: string) {
  const s = slotOf(b, k); const { date } = parseCell(k);
  if (!s) return 'a removed shift';
  const dow = (daysBetween(EPOCH, date) % 7 + 7) % 7;
  return `${DAY_SHORT[dow]} ${mmdd(date)} · ${locName(b, s.location_id)} ${shiftShort(s.start_hour, s.hours)}`;
}

export function keysOf(b: Bundle, empId: string, A: Record<string, string> = b.assign) {
  return Object.keys(A).filter((k) => A[k] === empId && valid(b, k)).sort((x, y) => absStart(b, x) - absStart(b, y));
}
export const inWeek = (k: string, week: string) => { const d = parseCell(k).date; return d >= week && d < addDays(week, 7); };
export const countWeek = (b: Bundle, empId: string, week: string, A: Record<string, string> = b.assign) =>
  keysOf(b, empId, A).filter((k) => inWeek(k, week)).length;
export const hoursWeek = (b: Bundle, empId: string, week: string) =>
  keysOf(b, empId).filter((k) => inWeek(k, week)).reduce((n, k) => n + slotOf(b, k)!.hours, 0);

export const defAvail = (): Avail[] => Array.from({ length: 7 }, (_, dow) => ({ dow, mode: 'any', from_hour: 6, to_hour: 22 }));
export const availText = (a?: Avail) => !a || a.mode === 'any' ? 'Any time' : a.mode === 'off' ? 'Not available' : `${ampm(a.from_hour)} – ${ampm(a.to_hour)}`;
export function availFor(b: Bundle, e: Emp, k: string) {
  const dow = (daysBetween(EPOCH, parseCell(k).date) % 7 + 7) % 7;
  const a = e.avail.find((x) => x.dow === dow);
  if (!a || a.mode === 'any') return true;
  if (a.mode === 'off') return false;
  const s = slotOf(b, k)!; const to = a.to_hour <= a.from_hour ? a.to_hour + 24 : a.to_hour;
  return s.start_hour >= a.from_hour && s.start_hour + s.hours <= to;
}

/** Checks a set of cell changes. Errors block the change; warnings are shown but allowed. Mirrors apply_changes() in the database. */
/** `allowOver`: emergency cover or trade — going over the weekly limit is a warning (an extra shift), not an error. */
export function evaluate(b: Bundle, changes: Changes, opts: { allowOver?: boolean } = {}): Result {
  const next = { ...b.assign };
  for (const k in changes) { const v = changes[k]; if (v) next[k] = v; else delete next[k]; }
  const errors: Issue[] = [], warnings: Issue[] = [];
  for (const id of new Set(Object.values(changes).filter(Boolean) as string[])) {
    const w = empOf(b, id); if (!w) continue;
    const mine = keysOf(b, id, next), before = keysOf(b, id);
    for (const wk of new Set(mine.map((k) => mondayOf(parseCell(k).date)))) {
      const n = mine.filter((k) => inWeek(k, wk)).length, was = before.filter((k) => inWeek(k, wk)).length;
      if (n > w.max_shifts && n > was && opts.allowOver) warnings.push({ short: `Extra shift (${n}/${w.max_shifts})`, msg: `Extra shift: ${w.name} will work ${n} shifts that week (limit ${w.max_shifts}).` });
      else if (n > w.max_shifts && n > was) errors.push({ short: `At limit (${was}/${w.max_shifts})`, msg: `${w.name} already has ${was} of ${w.max_shifts} shifts that week. For an emergency, tap the shift and use Swap or find cover: they can take it as an extra shift.` });
    }
    for (const k of Object.keys(changes).filter((x) => changes[x] === id)) {
      const s = absStart(b, k), e = absEnd(b, k), slot = slotOf(b, k)!;
      for (const o of mine) {
        if (o === k) continue;
        const os = absStart(b, o), oe = absEnd(b, o), oslot = slotOf(b, o)!;
        if (s < oe && os < e) errors.push({ short: `Busy · ${locName(b, oslot.location_id)} ${shiftShort(oslot.start_hour, oslot.hours)}`, msg: `${w.name} is already working ${slotLabel(b, o)} at that time.` });
        else if (oe === s || e === os) warnings.push({ short: 'Double shift', msg: `${w.name} will work a ${slot.hours + oslot.hours}-hour double (${slotLabel(b, os < s ? o : k)} and the next shift).` });
      }
      if (!w.locs.includes(slot.location_id)) warnings.push({ short: `New to ${locName(b, slot.location_id)}`, msg: `${w.name} doesn't usually work at ${locName(b, slot.location_id)}.` });
      if (!availFor(b, w, k)) {
        const dow = (daysBetween(EPOCH, parseCell(k).date) % 7 + 7) % 7;
        warnings.push({ short: 'Unavailable', msg: `${w.name} said they can't work ${DAY_LONG[dow]}s ${shiftShort(slot.start_hour, slot.hours)} (their availability: ${availText(w.avail.find((a) => a.dow === dow))}).` });
      }
    }
  }
  const uniq = (arr: Issue[]) => arr.filter((x, i) => arr.findIndex((y) => y.msg === x.msg) === i);
  return { errors: uniq(errors), warnings: uniq(warnings) };
}

// ---------- pay ----------
export const OT_LIMIT = 40;
export function periodOf(org: Org, week: string): string[] {
  if (org.pay_period !== 'biweekly') return [week];
  const anchor = mondayOf(org.pay_anchor);
  const start = addDays(anchor, Math.floor(daysBetween(anchor, week) / 14) * 14);
  return [start, addDays(start, 7)];
}
/** Hours of a finished time entry (0 while still clocked in). */
export const entryHours = (e: { clock_in: string; clock_out: string | null }) =>
  e.clock_out ? Math.round(((new Date(e.clock_out).getTime() - new Date(e.clock_in).getTime()) / 36e5) * 100) / 100 : 0;
export const round2 = (n: number) => Math.round(n * 100) / 100;

/** Pay for a period. Paid hours come from the time clock (finished entries); scheduled hours are shown for comparison. */
export function payFor(b: Bundle, e: Emp, weeks: string[]) {
  const useOt = b.org.overtime !== false;
  let shifts = 0, sched = 0, hours = 0, reg = 0, ot = 0, open = 0;
  const perWeek = weeks.map((wk) => {
    const ks = keysOf(b, e.id).filter((k) => inWeek(k, wk));
    shifts += ks.length; sched += ks.reduce((n, k) => n + slotOf(b, k)!.hours, 0);
    const es = b.entries.filter((x) => x.employee_id === e.id && x.work_date >= wk && x.work_date < addDays(wk, 7));
    open += es.filter((x) => !x.clock_out).length;
    const h = round2(es.reduce((n, x) => n + entryHours(x), 0));
    hours += h;
    reg += useOt ? Math.min(OT_LIMIT, h) : h; ot += useOt ? Math.max(0, h - OT_LIMIT) : 0;
    return h;
  });
  const rate = Number(e.rate) || 0;
  const covers = b.ledger.filter((l) => l.creditor_id === e.id && l.slot_id && weeks.some((wk) => l.work_date >= wk && l.work_date < addDays(wk, 7)));
  const coverHours = covers.reduce((n, l) => n + b.entries.filter((x) => x.employee_id === e.id && x.slot_id === l.slot_id && x.work_date === l.work_date).reduce((m, x) => m + entryHours(x), 0), 0);
  hours = round2(hours); reg = round2(reg); ot = round2(ot);
  return { shifts, sched, hours, reg, ot, rate, perWeek, open, gross: reg * rate + ot * rate * 1.5, covers: covers.length, coverPay: coverHours * rate };
}

// ---------- shift set-up ----------
export interface Row { id?: string; start_hour: number; hours: number }
export const PRESETS: Record<'hotel' | 'gas' | 'shop', { id: string; name: string; sub: string; rows: [number, number][] | null; rec?: boolean }[]> = {
  hotel: [
    { id: 'h3', name: '3 shifts × 8 hours', sub: '7 am–3 pm · 3–11 pm · 11 pm–7 am. Most common for front desk.', rows: [[7, 8], [15, 8], [23, 8]], rec: true },
    { id: 'h2', name: '2 shifts × 12 hours', sub: '7 am–7 pm · 7 pm–7 am', rows: [[7, 12], [19, 12]] },
    { id: 'custom', name: 'Custom', sub: 'Set your own start times and lengths.', rows: null },
  ],
  gas: [
    { id: 'g3', name: '3 shifts × 8 hours', sub: '6 am–2 pm · 2–10 pm · 10 pm–6 am. Open 24 hours.', rows: [[6, 8], [14, 8], [22, 8]], rec: true },
    { id: 'g10', name: '3 shifts × 10 hours', sub: '5 am–3 pm · 1–11 pm · 9 pm–7 am. Two people during rush hours.', rows: [[5, 10], [13, 10], [21, 10]] },
    { id: 'g2', name: '2 shifts × 12 hours', sub: '6 am–6 pm · 6 pm–6 am', rows: [[6, 12], [18, 12]] },
    { id: 'custom', name: 'Custom', sub: 'Not open 24 hours, or a different pattern.', rows: null },
  ],
  shop: [
    { id: 's2', name: '2 shifts × 6 hours', sub: '9 am–3 pm · 3–9 pm. Open 9 am to 9 pm.', rows: [[9, 6], [15, 6]], rec: true },
    { id: 's1', name: '1 shift × 10 hours', sub: '10 am–8 pm. One person a day.', rows: [[10, 10]] },
    { id: 's3', name: '3 shifts × 8 hours', sub: '6 am–2 pm · 2–10 pm · 10 pm–6 am. Open 24 hours.', rows: [[6, 8], [14, 8], [22, 8]] },
    { id: 'custom', name: 'Custom', sub: 'Your own opening hours and shift lengths.', rows: null },
  ],
};
export const TYPE_LABEL: Record<'hotel' | 'gas' | 'shop', string> = { hotel: 'Hotel', gas: 'Gas station', shop: 'Shop' };
export function coverage(rows: Row[]) {
  const c = Array(24).fill(0) as number[];
  for (const r of rows) for (let t = 0; t < r.hours; t++) c[norm(r.start_hour + t)]++;
  return c;
}
export const HUES = [12, 205, 145, 275, 38, 180, 330, 95, 240, 58, 300, 160, 20, 220];
