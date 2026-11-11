import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase, errText } from '../lib/supabase';
import { DAY_LONG, addDays, money, todayIso } from '../lib/time';
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
  const [history, setHistory] = useState<PayLine | null>(null);
  const refresh = () => setTick((t) => t + 1);
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
  const cell = { width: 84, minHeight: 32, border: '1px solid var(--line-strong)', borderRadius: 6, padding: '4px 6px', background: 'var(--surface)' } as const;

  return (
    <div className="layout">{tabs}
      <PaySettingsPanel key={loc.id} b={b} locId={loc.id} onPick={setLocId} onSaved={() => { reload(); refresh(); }} />

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
        <div className="payctl">
          {b.locs.length > 1 && <div className="field"><label htmlFor="pr-loc">Business</label>
            <select id="pr-loc" value={loc.id} onChange={(e) => setLocId(e.target.value)}>{b.locs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>}
          <div className="field"><label htmlFor="pr-period">Pay period</label>
            <select id="pr-period" value={sel ?? ''} onChange={(e) => setSel(e.target.value)}>{rows.map((r) => <option key={r.period_start} value={r.period_start}>{periodTitle(r)} · pay {dateShort(r.pay_date)} · {statusOf(r, today)}</option>)}</select></div>
          <div className="field"><span className="lbl">Go to</span><div className="actions" style={{ margin: 0 }}>
            <button className="btn small" disabled={!row || rows.indexOf(row) >= rows.length - 1} onClick={() => setSel(rows[rows.indexOf(row!) + 1].period_start)}>‹ Earlier</button>
            <button className="btn small" disabled={!row || rows.indexOf(row) <= 0} onClick={() => setSel(rows[rows.indexOf(row!) - 1].period_start)}>Later ›</button></div></div>
        </div>
        <div className="tiles" style={{ marginBottom: 14 }}>
          <div className="tile"><div className="k">Payroll type</div><div className="v" style={{ fontSize: 22 }}>{FREQ_LABEL[loc.pay_frequency ?? 'weekly']}</div><div className="s">{scheduleText(loc as unknown as PaySettings)}</div></div>
          <div className="tile"><div className="k">Current pay period</div><div className="v" style={{ fontSize: 22 }}>{cur ? periodTitle(cur) : '—'}</div><div className="s">{cur ? `paid ${dateLong(cur.pay_date)}` : ''}</div></div>
          <div className="tile"><div className="k">Upcoming payment date</div><div className="v" style={{ fontSize: 22 }}>{next ? dateShort(next.pay_date) : '—'}</div><div className="s">{next ? `for ${periodTitle(next)}` : ''}</div></div>
          <div className="tile"><div className="k">{locked ? 'Paid' : 'To pay'} this period</div><div className="v">{money(t.net)}</div><div className="s">{hrs(t.hours)} h · {hrs(t.ot)} h overtime · gross {money(t.gross)}</div></div>
        </div>

        {row && <p className="hint">{periodTitle(row)}, paid {dateLong(row.pay_date)}. {loc.time_clock === false || loc.pay_method === 'schedule' ? (loc.time_clock === false ? 'Time clock is off here:' : 'Paid by the schedule (the time clock is kept for records):') + ' Hours come from the assigned schedule and follow every change to it. You can type in different hours for anyone.' : <>Pay comes from clocked hours. {payMethodText(loc as unknown as PaySettings)}.</>} {otText(loc as unknown as PaySettings)}{loc.pay_frequency === 'monthly' ? '; a week that crosses into another month counts in two parts' : ''}. Taxes aren't included; add them as deductions if you take them out.</p>}
        {locked && <div className="banner"><p><b>Paid and locked.</b> Marked paid {new Date(row!.run!.paid_at).toLocaleString('en-US')}. These numbers won't change, even if rates or hours change later. To correct it, write to <a href="mailto:support@splityourshift.com">support@splityourshift.com</a>; support can reopen it, and that is logged.</p></div>}
        {!locked && open.length > 0 && <div className="banner warn"><p><b>{open.map((l) => l.name).join(', ')}</b> {open.length === 1 ? 'is' : 'are'} still clocked in for this period. Those hours count after they clock out (or after you fix them in Time clock).</p></div>}

        {!locked && missing.length > 0 && <div className="banner warn"><p><b>No clock record:</b> {missing.map((l) => `${l.name} (${l.missing_shifts} shift${l.missing_shifts === 1 ? '' : 's'})`).join(', ')}. Those scheduled shifts have ended with no clock in or out, so they are not paid. Fix them in Time clock if the work was done.</p></div>}
        <div className="table-wrap"><table className="data payroll"><thead><tr>
          <th>Employee</th><th className="num">Hours</th><th>Hourly rate</th><th className="num">Regular pay</th><th className="num">Overtime pay</th><th>Bonus</th><th>Deduction</th><th className="num">Gross</th><th className="num">Net</th><th>Status</th><th>Payslip</th></tr></thead>
          <tbody>{(lines ?? []).map((l) => (
            <tr key={l.employee_id}>
              <td>{l.name}</td>
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
                <button className="btn small" onClick={() => downloadPdf(report()!, 'slips', l.employee_id)}>PDF</button>
                <button className="btn small" onClick={() => setHistory(l)} title={`Every payday ${l.name} was paid`}>History</button></div></td>
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

      {history && <Sheet eyebrow="Pay history" title={history.name} onClose={() => setHistory(null)}>
        <p className="hint">Every payday {history.name} was paid, at every business. Print or download any payslip.</p>
        <PayslipList business={b.org.name} empId={history.employee_id} />
      </Sheet>}

    </div>
  );
}

function PaySettingsPanel({ b, locId, onPick, onSaved }: { b: Bundle; locId: string; onPick: (id: string) => void; onSaved: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(() => { try { return localStorage.getItem('sys-payset') !== '0'; } catch { return true; } });
  const loc = b.locs.find((l) => l.id === locId)!;
  const [f, setF] = useState<PaySettings>({
    pay_frequency: loc.pay_frequency ?? 'weekly', pay_anchor: (loc.pay_anchor ?? todayIso()).slice(0, 10), pay_weekday: loc.pay_weekday ?? 4,
    pay_month_day: loc.pay_month_day ?? 31, pay_month_offset: loc.pay_month_offset ?? 1, overtime: loc.overtime ?? true,
    ot_after: Number(loc.ot_after ?? 40), ot_mode: loc.ot_mode ?? 'multiplier', ot_multiplier: Number(loc.ot_multiplier ?? 1.5), ot_fixed_rate: Number(loc.ot_fixed_rate ?? 0),
    grace_minutes: Number(loc.grace_minutes ?? 10), mutual_approval: loc.mutual_approval ?? true, pay_method: loc.pay_method ?? 'actual', pay_grace_minutes: Number(loc.pay_grace_minutes ?? 0),
    time_clock: loc.time_clock ?? true,
  });
  const startDow = (new Date(f.pay_anchor + 'T00:00:00Z').getUTCDay() + 6) % 7;
  // Weekly: only the start weekday matters, so keep the anchor on that weekday near today.
  const setStartDow = (d: number) => { const t = todayIso(); const td = (new Date(t + 'T00:00:00Z').getUTCDay() + 6) % 7; setF({ ...f, pay_anchor: addDays(t, -((td - d + 7) % 7)) }); };
  const save = async () => {
    // one grace period: the late notice and (with paid grace) the scheduled hours paid use the same minutes
    const { error } = await supabase.from('locations').update({ ...f, pay_grace_minutes: f.pay_method === 'grace' ? f.grace_minutes : 0 }).eq('id', locId);
    if (error) return toast(errText(error), 'error', 'Not saved');
    toast(`Saved. ${loc.name}: ${scheduleText(f)}. Paid payrolls stay as they were.`, 'ok', 'Payroll settings'); onSaved();
  };
  const chev = <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>;
  return (
    <section className="panel paysettings">
      <details open={open} onToggle={(e) => { const o = (e.target as HTMLDetailsElement).open; setOpen(o); try { localStorage.setItem('sys-payset', o ? '1' : '0'); } catch { /* private mode */ } }}>
        <summary aria-label={open ? 'Collapse payroll settings' : 'Expand payroll settings'}>
          <span className="ps-title"><h2>Payroll settings · {loc.name}</h2>
            <span className="ps-chips"><span className="tag plain">{FREQ_LABEL[f.pay_frequency]}</span><span className="tag plain">{f.overtime ? `OT after ${f.ot_after} h` : 'No overtime'}</span>
              <span className={`tag ${f.time_clock ? 'ok' : 'warn'}`}>{f.time_clock ? (f.pay_method === 'schedule' ? 'Clock on · pay by schedule' : `Clock on · grace ${f.grace_minutes} min`) : 'Clock off · scheduled hours'}</span></span></span>
          <span className="clock-tools"><HowToButton topic="payroll" /><span className="ps-chev">{chev}</span></span></summary>
        {b.locs.length > 1 && <div className="bizpills" role="tablist" aria-label="Business">
          {b.locs.map((l) => <button key={l.id} role="tab" aria-selected={l.id === locId} className={`bizpill${l.id === locId ? ' on' : ''}`} onClick={() => onPick(l.id)}>
            <b>{l.name}</b><small>{FREQ_LABEL[l.pay_frequency ?? 'weekly']}{l.time_clock === false ? ' · clock off' : ''}</small></button>)}</div>}
        <div className="ps-grid">
          <div className="ps-card"><h3>Pay schedule</h3>
            <div className="ps-fields">
          <div className="field"><label htmlFor="ps-freq">How often you pay</label>
            <select id="ps-freq" value={f.pay_frequency} onChange={(e) => setF({ ...f, pay_frequency: e.target.value as PayFrequency })}>
              <option value="weekly">Weekly</option><option value="biweekly">Every 2 weeks (biweekly)</option><option value="monthly">Monthly</option></select></div>
          {f.pay_frequency === 'weekly' && <div className="field"><label htmlFor="ps-start">Pay week starts on</label>
            <select id="ps-start" value={startDow} onChange={(e) => setStartDow(+e.target.value)}>{DAY_LONG.map((d, i) => <option key={d} value={i}>{d}</option>)}</select></div>}
          {f.pay_frequency === 'biweekly' && <div className="field"><label htmlFor="ps-anchor">A two-week pay period starts on</label>
            <input type="date" id="ps-anchor" value={f.pay_anchor} onChange={(e) => e.target.value && setF({ ...f, pay_anchor: e.target.value })} />
            <span className="hint">Any start date of a past or future period, e.g. Oct 12, 2026 for Oct 12 – 25.</span></div>}
          {f.pay_frequency !== 'monthly' && <div className="field"><label htmlFor="ps-payday">Payday</label>
            <select id="ps-payday" value={f.pay_weekday} onChange={(e) => setF({ ...f, pay_weekday: +e.target.value })}>{DAY_LONG.map((d, i) => <option key={d} value={i}>The next {d} after the period ends</option>)}</select></div>}
          {f.pay_frequency === 'monthly' && <>
            <div className="field"><label htmlFor="ps-mday">Payday (date of the month)</label>
              <select id="ps-mday" value={f.pay_month_day} onChange={(e) => setF({ ...f, pay_month_day: +e.target.value })}>
                {Array.from({ length: 30 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}{d > 28 ? ' (or the last day of a shorter month)' : ''}</option>)}<option value={31}>Last day of the month</option></select></div>
            <div className="field"><label htmlFor="ps-moff">A month's pay is paid in</label>
              <select id="ps-moff" value={f.pay_month_offset} onChange={(e) => setF({ ...f, pay_month_offset: +e.target.value })}><option value={0}>The same month</option><option value={1}>The next month</option></select></div>
          </>}
            </div>
            <span className="hint">{scheduleText(f)}. Changing it never changes a payroll already marked paid.</span>
          </div>
          <div className="ps-card"><h3>Overtime</h3>
          <label className="inline"><input type="checkbox" checked={f.overtime} onChange={(e) => setF({ ...f, overtime: e.target.checked })} /> Pay overtime</label>
          {f.overtime && <div className="otrow">
            <label>after <input type="number" min={1} max={168} step={0.5} value={f.ot_after} onChange={(e) => setF({ ...f, ot_after: +e.target.value || 40 })} aria-label="Overtime starts after hours" /> hours in a week, paid</label>
            <select value={f.ot_mode} onChange={(e) => setF({ ...f, ot_mode: e.target.value as PaySettings['ot_mode'] })} aria-label="How overtime is paid">
              <option value="multiplier">as a multiple of each worker's rate</option><option value="fixed">as a fixed amount per hour</option></select>
            {f.ot_mode === 'multiplier'
              ? <label><input type="number" min={1} max={5} step={0.05} value={f.ot_multiplier} onChange={(e) => setF({ ...f, ot_multiplier: +e.target.value || 1 })} aria-label="Overtime multiple" /> × the hourly rate</label>
              : <label>$<input type="number" min={0} max={999} step={0.25} value={f.ot_fixed_rate} onChange={(e) => setF({ ...f, ot_fixed_rate: +e.target.value || 0 })} aria-label="Overtime dollars per hour" /> per overtime hour</label>}
          </div>}
          <span className="hint">{otText(f)}.</span>
          </div>
          <div className="ps-card ps-clock"><h3>Time clock and pay</h3>
          <label className="switch"><input type="checkbox" role="switch" checked={f.time_clock} onChange={(e) => setF({ ...f, time_clock: e.target.checked })} /><span className="track" aria-hidden="true" /><span><b>Time clock {f.time_clock ? 'on' : 'off'}</b> at {loc.name}</span></label>
          {!f.time_clock ? <span className="hint">Off: workers here see no time clock. Payroll pays each assigned shift and follows schedule changes; you can still edit anyone's hours. Nothing is deleted when you switch.</span> : <>
            <div className="cks-row"><span className="cks-l">Grace period</span>
              <div className="cks-pills">{[5, 10, 15, 30].map((m) => <button key={m} type="button" className={`cks-pill${f.grace_minutes === m ? ' on' : ''}`} aria-pressed={f.grace_minutes === m} onClick={() => setF({ ...f, grace_minutes: m })}>{m} min</button>)}
                <label className="cks-custom"><input type="number" min={0} max={120} value={f.grace_minutes} onChange={(e) => setF({ ...f, grace_minutes: Math.max(0, Math.min(120, +e.target.value || 0)) })} aria-label="Grace minutes" /> min</label></div>
              <span className="hint">Clocking in up to {f.grace_minutes} minutes late gets no late notice. Later than that, {f.pay_method === 'schedule' ? 'the worker is told and can offer a time swap; pay still follows the schedule' : 'the worker picks normal payroll, a paid adjustment (you approve) or a time swap'}.</span></div>
            <div className="cks-row"><span className="cks-l">How hours are paid</span>
              <div className="cks-methods">{([['actual', 'Clocked time', 'Pay from clock-in to clock-out'], ['grace', 'Shift hours + grace', 'Pay the scheduled shift; a few late minutes are still paid'], ['schedule', 'By the schedule', 'Keep the clock for records; pay the assigned shifts']] as const).map(([m, t, sub]) =>
                <button key={m} type="button" className={`cks-method${f.pay_method === m ? ' on' : ''}`} aria-pressed={f.pay_method === m} onClick={() => setF({ ...f, pay_method: m })}><b>{t}</b><small>{sub}</small></button>)}</div>
              <span className="hint">{payMethodText({ ...f, pay_grace_minutes: f.pay_method === 'grace' ? f.grace_minutes : 0 })}.</span></div>
          </>}
          <label className="inline"><input type="checkbox" checked={f.mutual_approval} onChange={(e) => setF({ ...f, mutual_approval: e.target.checked })} /> When two workers agree on a swap, it's final (you're just told)</label>
          {!f.mutual_approval && <span className="hint">Off: after the coworker accepts, the swap waits for your approval in the Swaps tab.</span>}
          </div>
        </div>
        <div className="ps-foot"><span className="hint">Saved per business. Paid payrolls stay as they were.</span><button className="btn primary" onClick={save}>Save payroll settings</button></div>
      </details>
    </section>
  );
}
