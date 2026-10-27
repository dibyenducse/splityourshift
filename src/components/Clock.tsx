import { useEffect, useState } from 'react';
import { supabase, errText } from '../lib/supabase';
import { enablePush, isIOS, isStandalone, pushIsOn, pushSupported } from '../lib/push';
import { DAY_SHORT, addDays, mmdd, shiftLong, todayIso } from '../lib/time';
import { cellKey, entryHours, keysOf, locName, parseCell, slotLabel, slotOf } from '../lib/rules';
import type { Bundle, TimeEntry, TimeFix } from '../lib/types';
import { Sheet, useToast } from './ui';

/** Start of a shift in this device's time zone (the business and its staff are in the same place). */
export function shiftWindow(b: Bundle, k: string) {
  const s = slotOf(b, k)!; const [y, m, d] = parseCell(k).date.split('-').map(Number);
  const start = new Date(y, m - 1, d, s.start_hour); const end = new Date(start.getTime() + s.hours * 36e5);
  return { start, end };
}
export const clockTime = (t: string | Date) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const elapsed = (from: string, now: number) => { const m = Math.max(0, Math.floor((now - new Date(from).getTime()) / 60000)); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; };

/** Worker's big clock in / clock out button. */
export function ClockPanel({ b, empId, userId, reload }: { b: Bundle; empId: string; userId: string; reload: () => void }) {
  const toast = useToast();
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [push, setPush] = useState(pushIsOn());
  const [fix, setFix] = useState(false);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 20000); return () => clearInterval(t); }, []);

  const mine = keysOf(b, empId).filter((k) => { const d = parseCell(k).date; return d >= addDays(todayIso(), -1) && d <= addDays(todayIso(), 14); });
  const entryFor = (k: string) => b.entries.find((e) => e.employee_id === empId && e.slot_id === parseCell(k).slot && e.work_date === parseCell(k).date);
  const open = b.entries.find((e) => e.employee_id === empId && !e.clock_out);
  const current = mine.find((k) => { const w = shiftWindow(b, k); return now >= w.start.getTime() - 30 * 60000 && now <= w.end.getTime() && !entryFor(k); });
  const doneNow = mine.find((k) => { const w = shiftWindow(b, k); const e = entryFor(k); return e?.clock_out && now <= w.end.getTime() + 2 * 36e5 && now >= w.start.getTime() - 30 * 60000; });
  const next = mine.find((k) => shiftWindow(b, k).start.getTime() > now && !entryFor(k));
  const openKey = open?.slot_id ? cellKey(open.slot_id, open.work_date) : null;

  const act = async (fn: () => PromiseLike<{ error: unknown }>, ok: string) => {
    setBusy(true);
    const { error } = await fn();
    setBusy(false);
    if (error) toast(errText(error), 'error', "Didn't work"); else { toast(ok, 'ok', 'Done'); reload(); }
  };
  const turnOn = async () => {
    try { await enablePush(userId); setPush(true); toast("Reminders are on. You'll get a notification when it's time to clock in and out.", 'ok', 'Reminders on'); }
    catch (e) { toast(errText(e), 'error', "Couldn't turn on"); }
  };

  let face;
  if (open) {
    face = (<>
      <div className="clock-btn on" role="status" aria-live="polite"><span>On the clock<b>{elapsed(open.clock_in, now)}</b></span></div>
      <p className="clock-sub">Since {clockTime(open.clock_in)}{openKey && slotOf(b, openKey) ? ` · ${slotLabel(b, openKey)}` : ''}</p>
      <button className="btn big danger clock-out" disabled={busy} onClick={() => act(() => supabase.rpc('clock_out'), 'Clocked out. Your hours are saved.')}>Clock out</button>
    </>);
  } else if (current) {
    const w = shiftWindow(b, current);
    face = (<>
      <button className="clock-btn" disabled={busy} onClick={() => act(() => supabase.rpc('clock_in', { p_slot: parseCell(current).slot, p_date: parseCell(current).date }), 'Clocked in. Have a good shift!')}>
        <span>Clock in<small>{clockTime(w.start)} shift</small></span></button>
      <p className="clock-sub">{slotLabel(b, current)}{now > w.start.getTime() + 5 * 60000 ? ` · started ${Math.round((now - w.start.getTime()) / 60000)} min ago` : ''}</p>
    </>);
  } else if (doneNow) {
    const e = entryFor(doneNow)!;
    face = (<>
      <div className="clock-btn done"><span>Done ✓<small>{entryHours(e)} h</small></span></div>
      <p className="clock-sub">{slotLabel(b, doneNow)} · {clockTime(e.clock_in)} – {clockTime(e.clock_out!)}</p>
    </>);
  } else {
    face = (<>
      <div className="clock-btn off"><span>Off<small>no shift now</small></span></div>
      <p className="clock-sub">{next ? `Next shift: ${slotLabel(b, next)}. You can clock in 30 minutes before it starts.` : 'No upcoming shifts in the next two weeks.'}</p>
    </>);
  }

  return (
    <section className="panel">
      <div className="panel-head"><h2>Time clock</h2><span className={`lamp${open ? ' on' : ''}`} title={open ? 'On the clock' : 'Not clocked in'} /></div>
      <div className="clock">{face}</div>
      <div className="actions" style={{ justifyContent: 'center' }}>
        {pushSupported() || isIOS() ? (push ? <span className="tag ok">Shift reminders on</span>
          : <button className="btn small primary" onClick={turnOn}>Turn on shift reminders</button>) : null}
        <button className="btn small" onClick={() => setFix(true)}>Fix my hours</button>
      </div>
      {!push && isIOS() && !isStandalone() && <p className="hint" style={{ textAlign: 'center', margin: '8px 0 0' }}>iPhone: tap Share → Add to Home Screen, then open SplitYourShift from your home screen to get reminders.</p>}
      {fix && <FixSheet b={b} empId={empId} onClose={() => setFix(false)} reload={reload} />}
    </section>
  );
}

const toLocalInput = (d: Date) => { const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

/** Worker asks the owner to add or correct clock times (forgot to clock in/out, phone died...). */
function FixSheet({ b, empId, onClose, reload }: { b: Bundle; empId: string; onClose: () => void; reload: () => void }) {
  const toast = useToast();
  const recent = keysOf(b, empId).filter((k) => { const d = parseCell(k).date; return d >= addDays(todayIso(), -14) && d <= todayIso(); }).reverse();
  const [cell, setCell] = useState(recent[0] ?? '');
  const w = cell ? shiftWindow(b, cell) : null;
  const [inT, setIn] = useState(w ? toLocalInput(w.start) : '');
  const [outT, setOut] = useState(w ? toLocalInput(w.end) : '');
  const [reason, setReason] = useState('');
  const pick = (k: string) => { setCell(k); const x = shiftWindow(b, k); const e = b.entries.find((t) => t.employee_id === empId && t.slot_id === parseCell(k).slot && t.work_date === parseCell(k).date);
    setIn(toLocalInput(e ? new Date(e.clock_in) : x.start)); setOut(toLocalInput(e?.clock_out ? new Date(e.clock_out) : x.end)); };
  const send = async () => {
    if (!cell) return toast('Pick the shift first.', 'error', 'Missing');
    const a = new Date(inT), z = new Date(outT);
    if (!(z > a)) return toast('Clock-out has to be after clock-in.', 'error', 'Check the times');
    const { error } = await supabase.rpc('request_time_fix', { p_slot: parseCell(cell).slot, p_date: parseCell(cell).date, p_in: a.toISOString(), p_out: z.toISOString(), p_reason: reason });
    if (error) return toast(errText(error), 'error', 'Not sent');
    toast('Sent to your manager. Your hours count once they approve.', 'ok', 'Sent'); onClose(); reload();
  };
  return (
    <Sheet eyebrow="Time clock" title="Fix my hours" onClose={onClose}>
      <div className="sec"><p>Forgot to clock in or out, or the times are wrong? Send the right times to your manager. Hours only count for pay after they approve.</p></div>
      <div className="field"><label htmlFor="fx-shift">Shift</label>
        <select id="fx-shift" value={cell} onChange={(e) => pick(e.target.value)}>
          {recent.length ? recent.map((k) => <option key={k} value={k}>{slotLabel(b, k)}</option>) : <option value="">No shifts in the last 2 weeks</option>}</select></div>
      <div className="twocol">
        <div className="field"><label htmlFor="fx-in">Clock in</label><input type="datetime-local" id="fx-in" value={inT} onChange={(e) => setIn(e.target.value)} /></div>
        <div className="field"><label htmlFor="fx-out">Clock out</label><input type="datetime-local" id="fx-out" value={outT} onChange={(e) => setOut(e.target.value)} /></div>
      </div>
      <div className="field"><label htmlFor="fx-why">Reason</label><input type="text" id="fx-why" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Phone died, forgot to clock out…" /></div>
      <div><button className="btn primary" onClick={send} disabled={!recent.length}>Send to manager</button></div>
    </Sheet>
  );
}

/** List of a worker's clocked hours and hour-fix requests for a pay period. */
export function HoursList({ b, empId, weeks, onCancel }: { b: Bundle; empId: string; weeks: string[]; onCancel?: (f: TimeFix) => void }) {
  const from = weeks[0], to = addDays(weeks[weeks.length - 1], 7);
  const es = b.entries.filter((e) => e.employee_id === empId && e.work_date >= from && e.work_date < to);
  const fx = b.fixes.filter((f) => f.employee_id === empId && f.work_date >= from && f.work_date < to && f.status !== 'approved');
  const label = (e: TimeEntry | TimeFix) => {
    const dow = DAY_SHORT[(new Date(e.work_date + 'T00:00:00Z').getUTCDay() + 6) % 7];
    const s = e.slot_id ? b.slots.find((x) => x.id === e.slot_id) : undefined;
    return `${dow} ${mmdd(e.work_date)}${s ? ` · ${locName(b, s.location_id)} ${shiftLong(s.start_hour, s.hours)}` : ''}`;
  };
  if (!es.length && !fx.length) return <p className="empty-note">No clocked hours in this pay period yet.</p>;
  return (
    <div className="table-wrap"><table className="data"><thead><tr><th>Shift</th><th>In</th><th>Out</th><th className="num">Hours</th><th /></tr></thead><tbody>
      {es.map((e) => <tr key={e.id}><td>{label(e)}</td><td>{clockTime(e.clock_in)}</td><td>{e.clock_out ? clockTime(e.clock_out) : <span className="tag warn">On the clock</span>}</td>
        <td className="num">{e.clock_out ? entryHours(e) : '—'}</td><td>{e.source !== 'clock' && <span className="tag plain">{e.source === 'owner' ? 'Added by manager' : 'Fixed'}</span>}</td></tr>)}
      {fx.map((f) => <tr key={f.id}><td>{label(f)}</td><td>{clockTime(f.clock_in)}</td><td>{clockTime(f.clock_out)}</td><td className="num">{entryHours(f)}</td>
        <td>{f.status === 'pending' ? <span className="actions"><span className="tag warn">Waiting</span>{onCancel && <button className="mini" onClick={() => onCancel(f)}>Cancel</button>}</span>
          : <span className="tag bad">{f.status === 'denied' ? 'Denied' : 'Cancelled'}</span>}</td></tr>)}
    </tbody></table></div>
  );
}
