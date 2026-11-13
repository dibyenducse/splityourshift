import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase, errText } from '../lib/supabase';
import { DAY_LONG, addDays, money, rangeTitle, shiftLong, todayIso } from '../lib/time';
import { entryHours, slotById } from '../lib/rules';
import type { Bundle } from '../lib/types';
import { ConfirmButton, Sheet, useToast } from '../components/ui';
import { PayslipList } from '../components/Payslips';
import { HowToButton } from '../components/HowTo';
import {
  FREQ_LABEL, dateLong, otText, payMethodText, dateShort, downloadPdf, hrs, markPaid, payDashboard, payLines, payPeriods, payRuns, periodTitle, printReport,
  scheduleText, setAdjustment, setHoursEdit, totals, type DashRow, type PayFrequency, type PayLine, type PayRun, type PaySettings, type Period, type Report,
} from '../lib/payroll';

type Row = Period & { run?: PayRun; reopened: PayRun[] };
const statusOf = (r: Row, today: string) => r.run ? 'Paid' : r.pay_date < today ? 'Overdue' : r.period_end < today ? 'Due' : r.period_start <= today ? 'In progress' : 'Upcoming';
const tagFor: Record<string, string> = { Paid: 'ok', Overdue: 'bad', Due: 'warn', 'In progress': 'plain', Upcoming: 'plain' };

/** Payroll for one business at a time: dashboard, pay period picker, lines, mark as paid, history, reports and settings. */
export default function Payroll({ b, tabs, reload, initialLoc }: { b: Bundle; tabs: React.ReactNode; reload: () => void; initialLoc?: string }) {
  const toast = useToast();
  const today = todayIso();
  const [locId, setLocId] = useState(initialLoc ?? b.locs[0]?.id ?? '');
  const loc = b.locs.find((l) => l.id === locId) ?? b.locs[0];
  const [dash, setDash] = useState<DashRow[]>([]);
  const [runs, setRuns] = useState<PayRun[]>([]);
  const [periods, setPeriods] = useState<Period[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [lines, setLines] = useState<PayLine[] | null>(null);
  const [tick, setTick] = useState(0);
  const [history, setHistory] = useState<{ line: PayLine; tab: 'hours' | 'pay' } | null>(null);
  const refresh = () => setTick((t) => t + 1);
  const [pop, setPop] = useState<Pop>(null);
  useEffect(() => { if (initialLoc) setLocId(initialLoc); }, [initialLoc]);

  useEffect(() => {
    payDashboard(b.org.id).then(setDash, (e) => toast(errText(e), 'error', "Couldn't load payroll"));
    payRuns(b.org.id).then(setRuns, () => {});
  }, [b.org.id, tick, toast]);
  useEffect(() => {
    if (!loc) return;
    payPeriods(loc.id, today, loc.pay_frequency === 'monthly' ? 12 : 26, 2).then((ps) => {
      setPeriods(ps);
      setSel((cur) => (cur && ps.some((p) => p.period_start === cur) ? cur : (ps.filter((p) => p.pay_date >= today).sort((x, y) => x.pay_date.localeCompare(y.pay_date))[0] ?? ps[ps.length - 1])?.period_start ?? null));
    }, (e) => toast(errText(e), 'error', "Couldn't load pay periods"));
  }, [loc?.id, loc?.pay_frequency, loc?.pay_anchor, loc?.pay_weekday, loc?.pay_month_day, loc?.pay_month_offset, today, toast]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pay periods from the schedule, plus paid payrolls made under an older schedule (history never changes).
  const rows: Row[] = useMemo(() => {
    const mine = runs.filter((r) => r.location_id === loc?.id);
    const out: Row[] = periods.map((p) => ({ ...p, run: mine.find((r) => r.status === 'paid' && r.period_start === p.period_start), reopened: mine.filter((r) => r.status === 'reopened' && r.period_start === p.period_start) }));
    for (const r of mine.filter((r) => r.status === 'paid' && !out.some((o) => o.period_start === r.period_start)))
      out.push({ period_start: r.period_start, period_end: r.period_end, pay_date: r.pay_date, run: r, reopened: [] });
    return out.sort((x, y) => y.period_start.localeCompare(x.period_start));
  }, [periods, runs, loc?.id]);
  const row = rows.find((r) => r.period_start === sel);

  const loadLines = useCallback(async () => {
    if (!loc || !row) return setLines(null);
    if (row.run) return setLines(row.run.lines);
    try { setLines(await payLines(loc.id, row)); } catch (e) { toast(errText(e), 'error', "Couldn't load payroll"); }
  }, [loc?.id, row?.period_start, row?.run?.id, toast, b]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { loadLines(); }, [loadLines, tick]);
  // Live: schedule changes (assign, remove, swap) and clock records update the open payroll at once.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const bump = () => { clearTimeout(t); t = setTimeout(refresh, 400); };
    const ch = supabase.channel(`pay-live-${b.org.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'assignments', filter: `org_id=eq.${b.org.id}` }, bump)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'time_entries', filter: `org_id=eq.${b.org.id}` }, bump)
      .subscribe();
    return () => { clearTimeout(t); supabase.removeChannel(ch); };
  }, [b.org.id]);

  if (!loc) return <div className="layout">{tabs}<section className="panel"><p className="empty-note">Add a hotel, gas station or shop first.</p></section></div>;

  const all = dash.reduce((t, d) => ({ payable: t.payable + d.payable, paid: t.paid + (d.next_paid ? d.payable : 0), hours: t.hours + d.hours, employees: t.employees + d.employees,
    lines: t.lines + d.employees, pending: t.pending + d.pending, completed: t.completed + d.completed }), { payable: 0, paid: 0, hours: 0, employees: 0, lines: 0, pending: 0, completed: 0 });
  const cur = periods.find((p) => p.period_start <= today && p.period_end >= today);
  const next = [...periods].filter((p) => p.pay_date >= today).sort((x, y) => x.pay_date.localeCompare(y.pay_date))[0];
  const status = row ? statusOf(row, today) : '';
  const locked = !!row?.run;
  const t = totals(lines ?? []);
  const report = (): Report | null => row && lines ? { business: b.org.name, location: loc.name, period: row, status: row.run ? 'Paid' : 'Pending', paidAt: row.run?.paid_at, lines } : null;
  const open = (lines ?? []).filter((l) => (l.open_entries ?? 0) > 0);

  const saveRate = async (id: string, v: string) => {
    const n = Math.round(parseFloat(v) * 100) / 100; if (!(n >= 0 && n < 1000)) return;
    const { error } = await supabase.from('employees').update({ rate: n }).eq('id', id);
    if (error) toast(errText(error), 'error', 'Not saved'); reload(); refresh();
  };
  const saveAdj = async (l: PayLine, kind: 'bonus' | 'deduction', v: string) => {
    const n = Math.round((parseFloat(v) || 0) * 100) / 100; if (n < 0 || n === l[kind]) return;
    try { await setAdjustment(b.org.id, loc.id, l.employee_id, row!.period_start, kind, n); refresh(); } catch (e) { toast(errText(e), 'error', 'Not saved'); }
  };
  const saveHours = async (l: PayLine, v: string) => {
    const n = v.trim() === '' ? null : Math.round(parseFloat(v) * 100) / 100;
    if (n !== null && !(n >= 0 && n <= 744)) return toast('Enter hours from 0 to 744.', 'error', 'Not saved');
    const target = n === null || n === l.base_hours ? null : n;
    if (target === (l.edited_hours ?? null)) return;
    try { await setHoursEdit(b.org.id, loc.id, l.employee_id, row!.period_start, target); refresh(); } catch (e) { toast(errText(e), 'error', 'Not saved'); }
  };
  const missing = (lines ?? []).filter((l) => (l.missing_shifts ?? 0) > 0);
  const doPaid = async () => {
    try { await markPaid(loc.id, row!.period_start); toast(`${loc.name} payroll for ${periodTitle(row!)} is marked paid. Reminders for it stop.`, 'ok', 'Paid'); refresh(); }
    catch (e) { toast(errText(e), 'error', "Couldn't mark paid"); }
  };
  // payroll type and payday change right from the tiles
  const quickSave = async (patch: Partial<PaySettings>, msg?: string, keepOpen?: boolean) => {
    const { error } = await supabase.from('locations').update(patch).eq('id', loc.id);
    if (error) return toast(errText(error), 'error', 'Not saved');
    toast(`Saved. ${loc.name}: ${msg ?? scheduleText({ ...(loc as unknown as PaySettings), ...patch })}.`, 'ok', 'Payroll settings');
    if (!keepOpen) setPop(null);
    if ('pay_frequency' in patch || 'pay_anchor' in patch) setSel(null);
    reload(); refresh();
  };
  const cell = { width: 84, minHeight: 32, border: '1px solid var(--line-strong)', borderRadius: 6, padding: '4px 6px', background: 'var(--surface)' } as const;

  return (
    <div className="layout">{tabs}
      <div className="pay-grid one"><div className="pay-main">

      <section className="panel">
        <div className="panel-head"><h2>Payroll dashboard · all businesses</h2><span className="tag plain">{dash.length} business{dash.length === 1 ? '' : 'es'}</span></div>
        <div className="tiles" style={{ marginBottom: 12 }}>
          <div className="tile"><div className="k">To pay on the next paydays</div><div className="v">{money(all.payable)}</div><div className="s">{all.paid ? `${money(all.paid)} of it already marked paid` : 'across every business'}</div></div>
          <div className="tile"><div className="k">Hours in those pay periods</div><div className="v">{hrs(all.hours)}</div><div className="s">clocked or scheduled hours, every business</div></div>
          <div className="tile"><div className="k">Pending payrolls</div><div className="v">{all.pending}</div><div className="s">{all.pending ? 'payday came, not marked paid' : 'everything is up to date'}</div></div>
          <div className="tile"><div className="k">Paid so far</div><div className="v">{all.completed}</div><div className="s">payrolls marked paid</div></div>
        </div>
        <div className="table-wrap"><table className="data paytable"><thead><tr><th>Business</th><th>Pay schedule</th><th>Current period</th><th>Next payday</th><th className="num">Employees</th><th className="num">Hours</th><th className="num">To pay</th><th>Status</th><th /></tr></thead>
          <tbody>{dash.map((d) => (
            <tr key={d.location_id} className={d.location_id === loc.id ? 'on' : ''}>
              <td><b>{d.name}</b></td><td>{FREQ_LABEL[d.frequency]}</td>
              <td>{periodTitle({ period_start: d.cur_start, period_end: d.cur_end })}</td>
              <td><b>{dateShort(d.next_pay_date)}</b><div className="hint" style={{ margin: 0 }}>for {periodTitle({ period_start: d.next_start, period_end: d.next_end })}</div></td>
              <td className="num">{d.employees}</td><td className="num">{hrs(d.hours)}</td><td className="num"><b>{money(d.payable)}</b></td>
              <td>{d.pending ? <span className="tag bad">{d.pending} pending</span> : d.next_paid ? <span className="tag ok">Paid</span> : <span className="tag warn">To pay</span>}<div className="hint" style={{ margin: 0 }}>{d.completed} paid so far</div></td>
              <td><button className={`btn small${d.location_id === loc.id ? ' primary' : ''}`} onClick={() => setLocId(d.location_id)}>{d.location_id === loc.id ? 'Showing' : 'Open'}</button></td>
            </tr>))}</tbody>
          {dash.length > 1 && <tfoot><tr><td><b>All businesses</b></td><td /><td /><td /><td className="num">{all.employees}</td><td className="num">{hrs(all.hours)}</td><td className="num"><b>{money(all.payable)}</b></td><td>{all.pending ? <span className="tag bad">{all.pending} pending</span> : <span className="tag ok">Up to date</span>}</td><td /></tr></tfoot>}
        </table></div>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>{loc.name} payroll</h2><span className="clock-tools">{row && <span className={`tag ${tagFor[status]}`}>{status === 'Paid' ? `Paid · ${dateShort(row.pay_date)}` : `${status} · pay ${dateShort(row.pay_date)}`}</span>}</span></div>
        {b.locs.length > 1 && <div className="biz-chips" role="tablist" aria-label="Business">{b.locs.map((l) => (
          <button key={l.id} role="tab" aria-selected={l.id === loc.id} className={`biz-chip${l.id === loc.id ? ' on' : ''}`} onClick={() => setLocId(l.id)}>
            <span aria-hidden="true">{l.type === 'gas' ? '⛽' : l.type === 'shop' ? '🛒' : '🏨'}</span>{l.name}</button>))}</div>}
        <div className="tiles pay-tiles" style={{ marginBottom: 14 }}>
          <div className={`tile tile-edit${pop === 'freq' ? ' open' : ''}`}>
            <button className="tile-btn" onClick={() => setPop(pop === 'freq' ? null : 'freq')} aria-expanded={pop === 'freq'}><div className="k">Payroll type <span className="tile-pen" aria-hidden="true">✎</span></div>
              <div className="v" style={{ fontSize: 22 }}>{FREQ_LABEL[loc.pay_frequency ?? 'weekly']}</div><div className="s">{scheduleText(loc as unknown as PaySettings)}</div></button>
            {pop === 'freq' && <div className="tile-pop">
              <div className="tp-opts">{(['weekly', 'biweekly', 'monthly'] as PayFrequency[]).map((fq) => <button key={fq} className={`cks-pill${(loc.pay_frequency ?? 'weekly') === fq ? ' on' : ''}`} onClick={() => quickSave({ pay_frequency: fq })}>{FREQ_LABEL[fq]}</button>)}</div>
              {(loc.pay_frequency ?? 'weekly') === 'weekly' && <label className="tp-field">Week starts on<select value={(new Date((loc.pay_anchor ?? todayIso()).slice(0, 10) + 'T00:00:00Z').getUTCDay() + 6) % 7}
                onChange={(e) => { const d = +e.target.value, t0 = todayIso(), td = (new Date(t0 + 'T00:00:00Z').getUTCDay() + 6) % 7; quickSave({ pay_anchor: addDays(t0, -((td - d + 7) % 7)) }); }}>{DAY_LONG.map((d, i) => <option key={d} value={i}>{d}</option>)}</select></label>}
              {loc.pay_frequency === 'biweekly' && <label className="tp-field">A 2-week period starts on<input type="date" value={(loc.pay_anchor ?? todayIso()).slice(0, 10)} onChange={(e) => e.target.value && quickSave({ pay_anchor: e.target.value })} /></label>}
              <small className="hint">Saved right away. Payrolls already marked paid don't change.</small></div>}
          </div>
          <div className="tile tile-period">
            <div className="k">Pay period{row && cur && row.period_start !== cur.period_start && <button className="mini" onClick={() => setSel(cur.period_start)}>Back to current</button>}</div>
            <div className="tp-move">
              <button className="btn icon" disabled={!row || rows.indexOf(row) >= rows.length - 1} onClick={() => setSel(rows[rows.indexOf(row!) + 1].period_start)} aria-label="Earlier pay period">‹</button>
              <div className="v" style={{ fontSize: 20 }}>{row ? periodTitle(row) : '—'}</div>
              <button className="btn icon" disabled={!row || rows.indexOf(row) <= 0} onClick={() => setSel(rows[rows.indexOf(row!) - 1].period_start)} aria-label="Later pay period">›</button></div>
            <div className="s">{row ? <>{cur && row.period_start === cur.period_start ? 'This period · ' : ''}<span className={`tag ${tagFor[status]}`}>{status}</span>{weeksOf(row).length > 1 ? ` · ${weeksOf(row).length} weeks` : ''}</> : ''}</div>
          </div>
          <div className={`tile tile-edit${pop === 'payday' ? ' open' : ''}`}>
            <button className="tile-btn" onClick={() => setPop(pop === 'payday' ? null : 'payday')} aria-expanded={pop === 'payday'}><div className="k">{row && next && row.period_start !== next.period_start ? 'Payday for this period' : 'Upcoming payment date'} <span className="tile-pen" aria-hidden="true">✎</span></div>
              <div className="v" style={{ fontSize: 22 }}>{row ? dateShort(row.pay_date) : next ? dateShort(next.pay_date) : '—'}</div><div className="s">{loc.pay_frequency === 'monthly' ? `Day ${loc.pay_month_day === 31 ? 'last' : loc.pay_month_day} of the ${loc.pay_month_offset ? 'next' : 'same'} month` : `The next ${DAY_LONG[loc.pay_weekday ?? 4]} after the period`}</div></button>
            {pop === 'payday' && <div className="tile-pop">
              {loc.pay_frequency !== 'monthly' ? <div className="tp-opts">{DAY_LONG.map((d, i) => <button key={d} className={`cks-pill${(loc.pay_weekday ?? 4) === i ? ' on' : ''}`} onClick={() => quickSave({ pay_weekday: i })}>{d.slice(0, 3)}</button>)}</div>
                : <><label className="tp-field">Date of the month<select value={loc.pay_month_day ?? 31} onChange={(e) => quickSave({ pay_month_day: +e.target.value })}>{Array.from({ length: 30 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}</option>)}<option value={31}>Last day</option></select></label>
                  <label className="tp-field">Paid in<select value={loc.pay_month_offset ?? 1} onChange={(e) => quickSave({ pay_month_offset: +e.target.value })}><option value={0}>The same month</option><option value={1}>The next month</option></select></label></>}
              <small className="hint">{loc.pay_frequency !== 'monthly' ? 'Payday is this weekday, right after the period ends. ' : ''}Saved right away.</small></div>}
          </div>
          <div className="tile"><div className="k">{locked ? 'Paid' : 'To pay'} this period</div><div className="v">{money(t.net)}</div><div className="s">{hrs(t.hours)} h · {hrs(t.ot)} h overtime · gross {money(t.gross)}</div></div>
        </div>

        <PayRules loc={loc} pop={pop} setPop={setPop} save={quickSave} />
        {row && <p className="hint">{periodTitle(row)}, paid {dateLong(row.pay_date)}. {loc.time_clock === false || loc.pay_method === 'schedule' ? (loc.time_clock === false ? 'Time clock is off here:' : 'Paid by the schedule (the time clock is kept for records):') + ' Hours come from the assigned schedule and follow every change to it. You can type in different hours for anyone.' : <>Pay comes from clocked hours. {payMethodText(loc as unknown as PaySettings)}.</>} {otText(loc as unknown as PaySettings)}{loc.pay_frequency === 'monthly' ? '; a week that crosses into another month counts in two parts' : ''}. Taxes aren't included; add them as deductions if you take them out.</p>}
        {locked && <div className="banner"><p><b>Paid and locked.</b> Marked paid {new Date(row!.run!.paid_at).toLocaleString('en-US')}. These numbers won't change, even if rates or hours change later. To correct it, write to <a href="mailto:support@splityourshift.com">support@splityourshift.com</a>; support can reopen it, and that is logged.</p></div>}
        {!locked && open.length > 0 && <div className="banner warn"><p><b>{open.map((l) => l.name).join(', ')}</b> {open.length === 1 ? 'is' : 'are'} still clocked in for this period. Those hours count after they clock out (or after you fix them in Time clock).</p></div>}

        {!locked && missing.length > 0 && <div className="banner warn"><p><b>No clock record:</b> {missing.map((l) => `${l.name} (${l.missing_shifts} shift${l.missing_shifts === 1 ? '' : 's'})`).join(', ')}. Those scheduled shifts have ended with no clock in or out, so they are not paid. Fix them in Time clock if the work was done.</p></div>}
        <div className="table-wrap"><table className="data payroll"><thead><tr>
          <th>Employee</th><th className="num">Hours</th><th>Hourly rate</th><th className="num">Regular pay</th><th className="num">Overtime pay</th><th>Bonus</th><th>Deduction</th><th className="num">Gross</th><th className="num">Net</th><th>Status</th><th>Payslip</th></tr></thead>
          <tbody>{(lines ?? []).map((l) => (
            <tr key={l.employee_id}>
              <td className="name-cell"><b>{l.name}</b>
                <span className="name-acts"><button className="hist-btn" onClick={() => setHistory({ line: l, tab: 'hours' })} title={`${l.name}: hours day by day (scheduled and clocked)`}>⏱ Hours</button>
                  <button className="hist-btn" onClick={() => setHistory({ line: l, tab: 'pay' })} title={`${l.name}: every payday`}>$ Pay</button></span></td>
              <td className="num">{!locked && l.method === 'schedule'
                ? <span className="hrs-edit"><input type="number" min={0} max={744} step={0.25} defaultValue={l.hours} key={`${l.employee_id}-h-${l.hours}-${sel}`} aria-label={`${l.name} hours`} style={{ ...cell, width: 74 }}
                    onBlur={(e) => saveHours(l, e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} /> h</span>
                : <>{hrs(l.hours)} h</>}
                {l.overtime_hours > 0 && <div className="hint" style={{ margin: 0 }}>{hrs(l.regular_hours)} + {hrs(l.overtime_hours)} OT</div>}
                {l.edited_hours != null && <div className="hrs-note"><span className="tag warn" title={`The schedule says ${hrs(l.base_hours ?? 0)} h`}>Edited · schedule {hrs(l.base_hours ?? 0)} h</span>
                  {!locked && l.method === 'schedule' && <button className="linkish" onClick={() => setHoursEdit(b.org.id, loc.id, l.employee_id, row!.period_start, null).then(refresh, (e) => toast(errText(e), 'error', 'Not saved'))}>Use schedule</button>}</div>}
                {l.method === 'schedule' && l.edited_hours == null && !locked && <div className="hint" style={{ margin: 0 }}>from schedule</div>}
                {(l.missing_shifts ?? 0) > 0 && !locked && <div><span className="tag bad" title="Scheduled shifts that ended with no clock record">{l.missing_shifts} no clock record</span></div>}</td>
              <td>{locked ? money(l.rate) : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>$<input type="number" min={0} max={999} step={0.25} defaultValue={l.rate} key={`${l.employee_id}-r-${l.rate}`} aria-label={`${l.name} hourly rate`} style={cell}
                onBlur={(e) => { if (+e.target.value !== l.rate) saveRate(l.employee_id, e.target.value); }} /></span>}</td>
              <td className="num">{money(l.regular_pay)}</td><td className="num">{l.overtime_pay ? money(l.overtime_pay) : '—'}</td>
              {(['bonus', 'deduction'] as const).map((k) => <td key={k}>{locked ? (l[k] ? money(l[k]) : '—') : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>$<input type="number" min={0} step={1} defaultValue={l[k] || ''} placeholder="0" key={`${l.employee_id}-${k}-${l[k]}-${sel}`} aria-label={`${l.name} ${k}`} style={cell}
                onBlur={(e) => saveAdj(l, k, e.target.value)} /></span>}</td>)}
              <td className="num">{money(l.gross)}</td><td className="num"><b>{money(l.net)}</b></td>
              <td>{locked ? <span className="tag ok">Paid</span> : <span className="tag warn">Pending</span>}</td>
              <td><div className="actions" style={{ margin: 0, flexWrap: 'nowrap' }}>
                <button className="btn small" onClick={() => printReport(report()!, 'slips', l.employee_id)}>Print</button>
                <button className="btn small" onClick={() => downloadPdf(report()!, 'slips', l.employee_id)}>PDF</button></div></td>
            </tr>))}</tbody>
          <tfoot><tr><td><b>Total</b></td><td className="num"><b>{hrs(t.hours)} h</b></td><td /><td className="num">{money(t.reg)}</td><td className="num">{t.otPay ? money(t.otPay) : '—'}</td><td>{money(t.bonus)}</td><td>{money(t.ded)}</td><td className="num">{money(t.gross)}</td><td className="num"><b>{money(t.net)}</b></td><td /><td /></tr></tfoot></table></div>

        <div className="actions" style={{ marginTop: 12 }}>
          {row && !locked && (row.period_end < today
            ? <ConfirmButton className="btn primary" label={`Mark as paid · ${money(t.net)}`} confirmLabel="Tap again: lock this payroll as paid" onConfirm={doPaid} />
            : <button className="btn" disabled title="You can mark it paid after the period ends">Mark as paid (after {dateShort(row.period_end)})</button>)}
        </div>
        {row && row.reopened.length > 0 && <p className="hint" style={{ marginTop: 10 }}>Reopened by support: {row.reopened.map((r) => `${new Date(r.reopened_at!).toLocaleDateString('en-US')} (${r.reopen_reason}; was ${money(r.total_net)})`).join(' · ')}</p>}
      </section>

      <section className="panel">
        <div className="panel-head"><h2>Payroll history · {loc.name}</h2></div>
        {runs.some((r) => r.location_id === loc.id) ? <div className="table-wrap"><table className="data"><thead><tr><th>Pay period</th><th>Pay date</th><th className="num">Employees</th><th className="num">Hours</th><th className="num">Total paid</th><th>Status</th><th /></tr></thead>
          <tbody>{runs.filter((r) => r.location_id === loc.id).map((r) => (
            <tr key={r.id}><td>{periodTitle(r)}</td><td>{dateShort(r.pay_date)}</td><td className="num">{r.employees}</td><td className="num">{hrs(r.hours)}</td><td className="num"><b>{money(r.total_net)}</b></td>
              <td>{r.status === 'paid' ? <span className="tag ok">Paid {new Date(r.paid_at).toLocaleDateString('en-US')}</span> : <span className="tag warn" title={r.reopen_reason ?? ''}>Reopened</span>}</td>
              <td><div className="actions" style={{ margin: 0, flexWrap: 'nowrap' }}>
                {r.status === 'paid' && <button className="btn small" onClick={() => setSel(r.period_start)}>Open</button>}
                <button className="btn small" onClick={() => printReport({ business: b.org.name, location: r.location_name, period: r, status: r.status === 'paid' ? 'Paid' : 'Pending', paidAt: r.paid_at, lines: r.lines }, 'summary')}>Print</button>
                <button className="btn small" onClick={() => downloadPdf({ business: b.org.name, location: r.location_name, period: r, status: r.status === 'paid' ? 'Paid' : 'Pending', paidAt: r.paid_at, lines: r.lines }, 'summary')}>PDF</button></div></td></tr>))}</tbody></table></div>
          : <p className="empty-note">No payroll marked paid yet. After payday, open the pay period above and tap Mark as paid; it is saved here.</p>}
      </section>

      <section className="panel">
        <div className="panel-head"><h2>Print / export</h2>{row && <span className="tag plain">{loc.name} · {periodTitle(row)}</span>}</div>
        <p className="hint">US Letter size. Payslips for one person are in the table above (Print, PDF) and in each person's History.</p>
        <div className="actions">
          <button className="btn" disabled={!lines} onClick={() => printReport(report()!, 'summary')}>Print summary</button>
          <button className="btn" disabled={!lines} onClick={() => downloadPdf(report()!, 'summary')}>Download summary PDF</button>
          <button className="btn" disabled={!lines?.length} onClick={() => printReport(report()!, 'slips')}>Print all payslips</button>
          <button className="btn" disabled={!lines?.length} onClick={() => downloadPdf(report()!, 'slips')}>All payslips PDF</button>
        </div>
      </section>

      </div>
      </div>
      {history && row && <WorkerHistory key={history.line.employee_id + history.tab} b={b} locId={loc.id} line={history.line} initialTab={history.tab} start={row.period_start} end={row.period_end} onClose={() => setHistory(null)} />}

    </div>
  );
}

/** Time clock on or off for each location: its own switch, saved right away (separate from payroll settings). */
export function TimeClockSwitches({ b, onSaved }: { b: Bundle; onSaved: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState('');
  const flip = async (l: Bundle['locs'][number], on: boolean) => {
    setBusy(l.id);
    const { error } = await supabase.from('locations').update({ time_clock: on }).eq('id', l.id);
    setBusy('');
    if (error) return toast(errText(error), 'error', 'Not saved');
    toast(on ? `Time clock on at ${l.name}. Workers there clock in and out from their phone.` : `Time clock off at ${l.name}. Workers see no clock; scheduled hours are paid.`, 'ok', on ? 'Clock on' : 'Clock off');
    onSaved();
  };
  return (
    <section className="panel tc-switches">
      <div className="panel-head"><h2>Time clock</h2></div>
      <p className="hint">Do workers clock in and out at this location? Off: they see no clock, and payroll pays the scheduled hours. Nothing is deleted when you switch.</p>
      <div className="tc-list">{b.locs.map((l) => { const on = l.time_clock !== false; return (
        <label key={l.id} className={`tc-row${on ? ' on' : ''}`}>
          <span className="tc-ico" aria-hidden="true">{l.type === 'gas' ? '⛽' : l.type === 'shop' ? '🛒' : '🏨'}</span>
          <span className="tc-name"><b>{l.name}</b><small>{on ? 'Clock on' : 'Clock off · pays scheduled hours'}</small></span>
          <span className="switch"><input type="checkbox" role="switch" checked={on} disabled={busy === l.id} onChange={(e) => flip(l, e.target.checked)} aria-label={`Time clock at ${l.name}`} /><span className="track" aria-hidden="true" /></span>
        </label>); })}</div>
    </section>);
}

/** The Mondays a pay period covers (1 for weekly, 2 for every 2 weeks, 4–5 for monthly). */
function weeksOf(r: { period_start: string; period_end: string }) {
  const out: string[] = []; let w = r.period_start;
  while (w <= r.period_end && out.length < 6) { out.push(w); w = addDays(w, 7); }
  return out;
}

interface HEntry { id: string; slot_id: string | null; work_date: string; clock_in: string; clock_out: string | null; source: string | null; note: string | null; location_id: string | null }

/** One worker in one pay period: each day's scheduled shift and real clock times side by side, which one was paid, weekly totals, and every payday. */
function WorkerHistory({ b, locId, line, initialTab, start, end, onClose }: { b: Bundle; locId: string; line: PayLine; initialTab: 'hours' | 'pay'; start: string; end: string; onClose: () => void }) {
  const [tab, setTab] = useState<'hours' | 'pay'>(initialTab);
  const [entries, setEntries] = useState<HEntry[] | null>(null);
  const [shifts, setShifts] = useState<{ slot_id: string; work_date: string }[]>([]);
  const loc = b.locs.find((l) => l.id === locId)!;
  const clockOff = loc.time_clock === false;
  const mode: 'clock' | 'schedule' | 'grace' = clockOff || line.method === 'schedule' || loc.pay_method === 'schedule' ? 'schedule' : loc.pay_method === 'grace' ? 'grace' : 'clock';
  const grace = Number(loc.grace_minutes ?? 10);
  const tz = b.org.time_zone || 'America/Chicago';
  useEffect(() => {
    let alive = true;
    (async () => {
      const [{ data: te }, { data: as }] = await Promise.all([
        supabase.from('time_entries').select('id, slot_id, work_date, clock_in, clock_out, source, note, location_id').eq('employee_id', line.employee_id).gte('work_date', start).lte('work_date', end).order('clock_in'),
        supabase.from('assignments').select('slot_id, work_date').eq('employee_id', line.employee_id).gte('work_date', start).lte('work_date', end).order('work_date'),
      ]);
      if (!alive) return;
      setEntries(((te ?? []) as HEntry[]).filter((e) => !e.location_id || e.location_id === locId));
      setShifts(((as ?? []) as { slot_id: string; work_date: string }[]).filter((x) => slotById(b, x.slot_id)?.location_id === locId));
    })();
    return () => { alive = false; };
  }, [line.employee_id, start, end, locId, b]);
  const t = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
  const dayLabel = (d: string) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'numeric', day: 'numeric' });
  // minutes from the shift's start to the clock-in (local time of the business)
  const lateMin = (date: string, startHour: number, iso: string) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
    const dayDiff = Math.round((Date.parse(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`) - Date.parse(date + 'T00:00:00Z')) / 864e5);
    return dayDiff * 1440 + Number(parts.hour) * 60 + Number(parts.minute) - startHour * 60;
  };
  type Row = { key: string; date: string; shift: string; schedH: number | null; inT?: string; outT?: string; clockH: number | null; open?: boolean; late?: number; src?: string | null; note?: string | null; paid: 'sched' | 'clock' | 'none' };
  const rows: Row[] = [];
  const used = new Set<string>();
  for (const a of shifts) {
    const sl = slotById(b, a.slot_id)!, en = (entries ?? []).find((e) => e.slot_id === a.slot_id && e.work_date === a.work_date);
    if (en) used.add(en.id);
    const late = en ? lateMin(a.work_date, sl.start_hour, en.clock_in) : undefined;
    const paid: Row['paid'] = mode === 'schedule' ? 'sched' : !en ? 'none' : mode === 'grace' && (late ?? 0) <= grace ? 'sched' : 'clock';
    rows.push({ key: a.slot_id + a.work_date, date: a.work_date, shift: shiftLong(sl.start_hour, sl.hours), schedH: sl.hours, inT: en ? t(en.clock_in) : undefined, outT: en?.clock_out ? t(en.clock_out) : undefined,
      clockH: en?.clock_out ? entryHours(en) : null, open: !!en && !en.clock_out, late, src: en?.source, note: en?.note, paid });
  }
  for (const e of entries ?? []) if (!used.has(e.id)) {
    const sl = e.slot_id ? slotById(b, e.slot_id) : null;
    rows.push({ key: e.id, date: e.work_date, shift: sl ? shiftLong(sl.start_hour, sl.hours) : 'Not on the schedule', schedH: null, inT: t(e.clock_in), outT: e.clock_out ? t(e.clock_out) : undefined,
      clockH: e.clock_out ? entryHours(e) : null, open: !e.clock_out, src: e.source, note: e.note, paid: mode === 'schedule' ? 'none' : 'clock' });
  }
  rows.sort((x, y) => x.date.localeCompare(y.date) || (x.inT ?? '').localeCompare(y.inT ?? ''));
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const sum = (rs: Row[], f: (r: Row) => number | null) => r2(rs.reduce((n, r) => n + (f(r) ?? 0), 0));
  const weeks = weeksOf({ period_start: start, period_end: end });
  const srcText = (s?: string | null) => s === 'owner' ? 'edited by you' : s === 'fix' ? 'fix approved' : 'phone';
  const modeText = mode === 'schedule' ? (clockOff ? 'Scheduled hours (time clock off)' : 'Scheduled hours (clock kept as a record)') : mode === 'grace' ? `Scheduled hours if clocked in within ${grace} min, otherwise clock time` : 'Clock time (clock-in to clock-out)';
  return (
    <Sheet eyebrow={`${rangeTitle(start, end)}`} title={line.name} onClose={onClose}>
      <div className="wh-sum">
        <div><small>Paid hours</small><b>{hrs(line.hours)} h</b>{line.overtime_hours > 0 ? <em>{hrs(line.regular_hours)} + {hrs(line.overtime_hours)} overtime</em> : <em>{money(line.net)} pay</em>}</div>
        <div className="wh-s"><small>📅 Scheduled</small><b>{entries ? `${sum(rows, (r) => r.schedH)} h` : '…'}</b><em>{rows.filter((r) => r.schedH !== null).length} shifts on the schedule</em></div>
        <div className="wh-c"><small>⏱ Clocked</small><b>{clockOff ? 'Off' : entries ? `${sum(rows, (r) => r.clockH)} h` : '…'}</b><em>{clockOff ? 'time clock not used here' : `${rows.filter((r) => r.inT).length} clock-ins`}</em></div>
      </div>
      <p className="wh-mode"><b>Paid by:</b> {modeText}. <span className="wh-key"><i className="k-s" /> scheduled <i className="k-c" /> clocked <i className="k-p" /> what was paid</span></p>
      <div className="seg pf-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'hours'} className={tab === 'hours' ? 'on' : ''} onClick={() => setTab('hours')}>⏱ Hours, day by day</button>
        <button role="tab" aria-selected={tab === 'pay'} className={tab === 'pay' ? 'on' : ''} onClick={() => setTab('pay')}>$ Pay history</button></div>
      {tab === 'hours' && (!entries ? <p className="hint">Loading…</p> : <>
        {weeks.map((w, i) => { const rs = rows.filter((r) => r.date >= w && r.date <= addDays(w, 6));
          return (<div key={w} className="wh-week">
            <div className="wh-week-h"><b>{weeks.length > 1 ? `Week ${i + 1} · ` : ''}{rangeTitle(w, addDays(w, 6))}</b>
              <span className="wh-tots"><span className="wh-chip s">📅 {sum(rs, (r) => r.schedH)} h</span>{!clockOff && <span className="wh-chip c">⏱ {sum(rs, (r) => r.clockH)} h</span>}</span></div>
            {rs.length ? <div className="wh-grid">
              <div className="wh-gh"><span>Day</span><span>📅 Scheduled</span><span>⏱ Clocked</span></div>
              {rs.map((r) => (
                <div key={r.key} className={`wh-gr${r.open ? ' open' : ''}`}>
                  <span className="wh-day">{dayLabel(r.date)}</span>
                  <span className={`wh-cell s${r.paid === 'sched' ? ' paid' : ''}`}>{r.schedH !== null ? <><b>{r.shift}</b><small>{hrs(r.schedH)} h</small></> : <em>not scheduled</em>}</span>
                  <span className={`wh-cell c${r.paid === 'clock' ? ' paid' : ''}`}>{clockOff ? <em>clock off</em> : r.inT ? <><b>{r.inT} – {r.outT ?? 'still on'}</b>
                    <small>{r.open ? 'on the clock' : `${hrs(r.clockH ?? 0)} h`} · {srcText(r.src)}{r.late !== undefined && r.late > 0 ? ` · ${r.late} min late` : r.late !== undefined && r.late < -1 ? ` · ${-r.late} min early` : ''}</small>
                    {r.note && <small className="wh-note">{r.note}</small>}</> : <em className="bad-t">no clock record</em>}</span>
                </div>))}</div> : <p className="empty-note">No hours this week.</p>}
          </div>); })}
        {Math.abs(line.hours - (mode === 'schedule' ? sum(rows, (r) => r.schedH) : line.hours)) > 0.05 && line.edited_hours != null && <p className="hint">Payroll shows {hrs(line.hours)} h because you edited the hours.</p>}
      </>)}
      {tab === 'pay' && <><p className="hint">Every payday {line.name} was paid, at every business. Print or download any payslip.</p>
        <PayslipList business={b.org.name} empId={line.employee_id} /></>}
    </Sheet>);
}

type Pop = 'freq' | 'payday' | 'ot' | 'paid' | 'swap' | null;

/** The rest of the payroll settings, as three small buttons under the tiles; each opens a small panel. */
function PayRules({ loc, pop, setPop, save }: { loc: Bundle['locs'][number]; pop: Pop; setPop: (p: Pop) => void; save: (patch: Partial<PaySettings>, msg?: string, keepOpen?: boolean) => void }) {
  const s0 = loc as unknown as PaySettings;
  const [ot, setOt] = useState({ overtime: s0.overtime ?? true, ot_after: Number(s0.ot_after ?? 40), ot_mode: s0.ot_mode ?? 'multiplier', ot_multiplier: Number(s0.ot_multiplier ?? 1.5), ot_fixed_rate: Number(s0.ot_fixed_rate ?? 0) });
  useEffect(() => { setOt({ overtime: s0.overtime ?? true, ot_after: Number(s0.ot_after ?? 40), ot_mode: s0.ot_mode ?? 'multiplier', ot_multiplier: Number(s0.ot_multiplier ?? 1.5), ot_fixed_rate: Number(s0.ot_fixed_rate ?? 0) }); }, [pop]); // eslint-disable-line react-hooks/exhaustive-deps
  const clockOff = loc.time_clock === false;
  const method = (clockOff ? 'schedule' : loc.pay_method ?? 'actual') as PaySettings['pay_method'];
  const grace = Number(loc.grace_minutes ?? 10);
  const METHOD: Record<PaySettings['pay_method'], [string, string, string]> = {
    actual: ['1', 'By the clock', 'Pay from clock-in to clock-out, minute by minute.'],
    schedule: ['2', 'Scheduled hours', 'Pay each assigned shift as scheduled; the clock is kept as a record.'],
    grace: ['3', 'Scheduled hours + grace period', 'Paid as scheduled when they clock in within the grace period; later than that, they get the late options.'],
  };
  const tog = (p: Pop) => setPop(pop === p ? null : p);
  const hm = (m: number) => `7:${String(m).padStart(2, '0')}`, inT = Math.max(1, Math.min(grace, 5)), lateT = grace + 15;
  return (
    <div className="pay-rules">
      <div className={`rule${pop === 'ot' ? ' open' : ''}`}>
        <button className="rule-chip" onClick={() => tog('ot')} aria-expanded={pop === 'ot'}><span aria-hidden="true">⏫</span><span><small>Overtime ✎</small><b>{loc.overtime === false ? 'No overtime' : otText(s0).replace(/^Overtime /, '')}</b></span></button>
        {pop === 'ot' && <div className="tile-pop rule-pop">
          <label className="inline"><input type="checkbox" checked={ot.overtime} onChange={(e) => setOt({ ...ot, overtime: e.target.checked })} /> Pay overtime</label>
          {ot.overtime && <>
            <label className="tp-field">After this many hours in a week<input type="number" min={1} max={80} value={ot.ot_after} onChange={(e) => setOt({ ...ot, ot_after: +e.target.value || 40 })} /></label>
            <div className="tp-opts"><button className={`cks-pill${ot.ot_mode === 'multiplier' ? ' on' : ''}`} onClick={() => setOt({ ...ot, ot_mode: 'multiplier' })}>× the hourly rate</button>
              <button className={`cks-pill${ot.ot_mode === 'fixed' ? ' on' : ''}`} onClick={() => setOt({ ...ot, ot_mode: 'fixed' })}>A fixed $ per hour</button></div>
            {ot.ot_mode === 'multiplier' ? <label className="tp-field">Multiple<input type="number" min={1} max={5} step={0.05} value={ot.ot_multiplier} onChange={(e) => setOt({ ...ot, ot_multiplier: +e.target.value || 1 })} /></label>
              : <label className="tp-field">Dollars per overtime hour<input type="number" min={0} max={999} step={0.25} value={ot.ot_fixed_rate} onChange={(e) => setOt({ ...ot, ot_fixed_rate: +e.target.value || 0 })} /></label>}
          </>}
          <small className="hint">{otText({ ...s0, ...ot })}.</small>
          <div className="actions" style={{ margin: 0 }}><button className="btn primary small" onClick={() => save(ot, otText({ ...s0, ...ot }))}>Save overtime</button><button className="btn small" onClick={() => setPop(null)}>Cancel</button></div>
        </div>}
      </div>
      <div className={`rule${pop === 'paid' ? ' open' : ''}`}>
        <button className="rule-chip" onClick={() => tog('paid')} aria-expanded={pop === 'paid'}><span aria-hidden="true">⏱</span><span><small>How hours are paid ✎</small><b>{METHOD[method][1]}{method === 'grace' ? ` · ${grace} min` : ''}{clockOff ? ' (clock off)' : ''}</b></span></button>
        {pop === 'paid' && <div className="tile-pop rule-pop wide">
          {clockOff && <p className="pm-off"><span aria-hidden="true">⏸</span><span>The time clock is <b>off</b> at {loc.name}, so only <b>Scheduled hours</b> can be used. Turn it on in the <b>Time clock</b> tab; your last choice comes back.</span></p>}
          <div className="cks-methods pm3">{(['actual', 'schedule', 'grace'] as const).map((m) => (
            <button key={m} type="button" className={`cks-method${method === m ? ' on' : ''}${clockOff && m !== 'schedule' ? ' shadow' : ''}`} aria-pressed={method === m} disabled={clockOff && m !== 'schedule'}
              onClick={() => save({ pay_method: m, pay_grace_minutes: m === 'grace' ? grace : 0 }, `hours paid: ${METHOD[m][1].toLowerCase()}`, true)}>
              <span className="pm-n">{METHOD[m][0]}</span><b>{METHOD[m][1]}{clockOff && m !== 'schedule' && <span className="tag plain pm-need">Needs the time clock</span>}</b><small>{METHOD[m][2]}</small></button>))}</div>
          {method === 'grace' && <div className="cks-row pm-grace"><span className="cks-l">Grace period <small className="cks-sub">how many minutes late still counts as on time</small></span>
            <div className="cks-pills">{[5, 10, 15, 30].map((m) => <button key={m} type="button" className={`cks-pill${grace === m ? ' on' : ''}`} onClick={() => save({ grace_minutes: m, pay_grace_minutes: m }, `grace period ${m} minutes`, true)}>{m} min</button>)}</div></div>}
          {!clockOff && <div className="grace-eg"><b>Example: shift 7:00 am – 3:00 pm{method === 'grace' ? `, grace ${grace} min` : ''}</b>
            <div className="ge-row ok"><span className="ge-t">Clocks in {hm(inT)}</span><span>{method === 'actual' ? `Paid from ${hm(inT)}.` : method === 'schedule' ? 'Paid 7:00 – 3:00.' : 'Within grace: paid from 7:00.'}</span></div>
            <div className="ge-row late"><span className="ge-t">Clocks in {hm(lateT)}</span><span>{method === 'actual' ? `Paid from ${hm(lateT)}.` : method === 'schedule' ? 'Still paid 7:00 – 3:00.' : `Past grace: paid from ${hm(lateT)}, unless a time swap or you approve 7:00.`}</span></div>
            <div className="ge-row"><span className="ge-t">Stays until 3:20</span><span>{method === 'schedule' ? 'Not paid extra.' : '20 extra minutes paid, unless they “sorted it out”.'}</span></div></div>}
          <div className="actions" style={{ margin: 0 }}><button className="btn small" onClick={() => setPop(null)}>Done</button></div>
        </div>}
      </div>
      <div className={`rule${pop === 'swap' ? ' open' : ''}`}>
        <button className="rule-chip" onClick={() => tog('swap')} aria-expanded={pop === 'swap'}><span aria-hidden="true">⇄</span><span><small>Swaps ✎</small><b>{loc.mutual_approval === false ? 'Wait for my approval' : 'Final when both agree'}</b></span></button>
        {pop === 'swap' && <div className="tile-pop rule-pop">
          <div className="cks-methods pm3">
            <button type="button" className={`cks-method${loc.mutual_approval !== false ? ' on' : ''}`} onClick={() => save({ mutual_approval: true }, 'swaps are final when both workers agree')}><b>Final when both agree</b><small>You're just told.</small></button>
            <button type="button" className={`cks-method${loc.mutual_approval === false ? ' on' : ''}`} onClick={() => save({ mutual_approval: false }, 'swaps wait for your approval')}><b>Wait for my approval</b><small>After the coworker accepts, it waits in the Swaps tab.</small></button></div>
        </div>}
      </div>
    </div>);
}
