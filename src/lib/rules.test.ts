import { describe, expect, it } from 'vitest';
import { cellKey, evaluate, payFor, periodOf, paidPeriod, defAvail, coverage } from './rules';
import type { Bundle, Emp } from './types';

const emp = (id: string, name: string, extra: Partial<Emp> = {}): Emp => ({
  id, org_id: 'o', user_id: null, name, email: null, phone: null, max_shifts: 5, rate: 15, hue: 0, lang: 'en', invited_at: null,
  locs: ['microtel'], avail: defAvail(), status: 'active', ...extra,
});
const days = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'];
function bundle(): Bundle {
  const b: Bundle = {
    org: { id: 'o', owner_id: 'u', name: 'Test', owner_name: null, pay_period: 'weekly', pay_anchor: '2026-10-26', overtime: true, status: 'active', created_at: '', last_active_at: null, time_zone: 'America/Chicago' },
    locs: [{ id: 'microtel', org_id: 'o', name: 'Microtel', type: 'hotel', sort: 0 }, { id: 'hojo', org_id: 'o', name: 'Hojo', type: 'hotel', sort: 1 }],
    slots: [
      { id: 'm7', org_id: 'o', location_id: 'microtel', start_hour: 7, hours: 8, sort: 0, active: true },
      { id: 'm3', org_id: 'o', location_id: 'microtel', start_hour: 15, hours: 8, sort: 1, active: true },
      { id: 'm11', org_id: 'o', location_id: 'microtel', start_hour: 23, hours: 8, sort: 2, active: true },
      { id: 'h3', org_id: 'o', location_id: 'hojo', start_hour: 15, hours: 8, sort: 0, active: true },
    ],
    emps: [emp('dibbo', 'Dibbo', { locs: ['microtel', 'hojo'] }), emp('obi', 'Obi', { rate: 15.5 })],
    assign: {}, reqs: [], ledger: [], entries: [], fixes: [],
  };
  // Obi: Mon, Thu, Sat x2, Sun = 5 shifts (paper schedule)
  for (const [s, d] of [['m3', 0], ['m3', 3], ['m7', 5], ['m3', 5], ['m3', 6]] as const) b.assign[cellKey(s, days[d])] = 'obi';
  // Dibbo: Wed Microtel 11-7, Hojo Mon 3-11
  b.assign[cellKey('m11', days[2])] = 'dibbo';
  b.assign[cellKey('h3', days[0])] = 'dibbo';
  return b;
}

describe('evaluate', () => {
  it('blocks a 6th shift for a worker capped at 5', () => {
    const r = evaluate(bundle(), { [cellKey('m7', days[0])]: 'obi' });
    expect(r.errors[0].msg).toMatch(/Obi already has 5 of 5/);
  });
  it('blocks the same time at two locations', () => {
    const r = evaluate(bundle(), { [cellKey('m3', days[0])]: 'dibbo' });
    expect(r.errors[0].short).toMatch(/Busy/);
  });
  it('allows a trade that keeps both at 5 (Dibbo Wed 11-7 <-> Obi Thu 3-11)', () => {
    const r = evaluate(bundle(), { [cellKey('m11', days[2])]: 'obi', [cellKey('m3', days[3])]: 'dibbo' });
    expect(r.errors).toEqual([]);
  });
  it('warns on back-to-back doubles and unavailable days', () => {
    const b = bundle();
    b.emps[0].avail[1] = { dow: 1, mode: 'off', from_hour: 6, to_hour: 22 };
    const r = evaluate(b, { [cellKey('m11', days[0])]: 'dibbo', [cellKey('m7', days[1])]: 'dibbo' });
    expect(r.errors).toEqual([]);
    expect(r.warnings.map((w) => w.short)).toEqual(expect.arrayContaining(['Double shift', 'Unavailable']));
  });
});

describe('pay', () => {
  const entry = (date: string, from: string, to: string | null) => ({ id: date + from, org_id: 'o', employee_id: 'obi', slot_id: null, work_date: date,
    clock_in: `${date}T${from}:00Z`, clock_out: to ? `${date}T${to}:00Z` : null, source: 'clock' as const, note: null });
  it('pays clocked hours only, with overtime after 40 hours', () => {
    const b = bundle();
    b.entries = [0, 1, 2, 3, 4, 5].map((d) => entry(days[d], '07:00', '15:00'));
    b.entries.push(entry(days[6], '07:00', null)); // still clocked in: not paid yet
    const p = payFor(b, b.emps[1], ['2026-10-26']);
    expect(p.sched).toBe(40);
    expect(p.hours).toBe(48);
    expect(p.ot).toBe(8);
    expect(p.open).toBe(1);
    expect(p.gross).toBeCloseTo(40 * 15.5 + 8 * 15.5 * 1.5);
    expect(periodOf({ ...b.org, pay_period: 'biweekly' }, '2026-11-02')).toEqual(['2026-10-26', '2026-11-02']);
  });
  it('counts partial hours from real clock times', () => {
    const b = bundle();
    b.entries = [entry(days[0], '06:58', '15:13')];
    expect(payFor(b, b.emps[1], ['2026-10-26']).hours).toBe(8.25);
  });
  it('coverage marks gaps and overlaps', () => {
    const c = coverage([{ start_hour: 5, hours: 10 }, { start_hour: 13, hours: 10 }]);
    expect(c[13]).toBe(2);
    expect(c[3]).toBe(0);
  });

  it('finds the period paid on the next payday', () => {
    const org = { ...bundle().org, pay_period: 'biweekly' as const, pay_anchor: '2026-10-26', pay_weekday: 4 };
    expect(paidPeriod(org, '2026-10-26')).toEqual({ weeks: ['2026-10-12', '2026-10-19'], payday: '2026-10-30' });
    expect(paidPeriod(org, '2026-10-12')).toEqual({ weeks: ['2026-09-28', '2026-10-05'], payday: '2026-10-16' });
    expect(paidPeriod(org, '2026-11-02')).toEqual({ weeks: ['2026-10-26', '2026-11-02'], payday: '2026-11-13' });
    expect(paidPeriod({ ...org, pay_period: 'weekly' }, '2026-10-26')).toEqual({ weeks: ['2026-10-19'], payday: '2026-10-30' });
    expect(paidPeriod({ ...org, pay_weekday: 0 }, '2026-10-26')).toEqual({ weeks: ['2026-10-12', '2026-10-19'], payday: '2026-10-26' });
  });
});
