import { useEffect, useState } from 'react';
import { supabase, errText } from '../lib/supabase';
import { enablePush, isIOS, isStandalone, pushIsOn, pushSupported } from '../lib/push';
import { DAY_SHORT, addDays, mmdd, shiftLong, todayIso } from '../lib/time';
import { cellKey, empOf, entryHours, keysOf, locName, parseCell, slotLabel, slotOf } from '../lib/rules';
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

/** What clock_in_now() answered: which follow-up question to ask. */
type ClockResult =
  | { mode: 'scheduled'; entry_id: string; label: string; late_minutes: number }
  | { mode: 'late'; entry_id: string; label: string; late_minutes: number; grace: number; covered_by: string | null; covered_name: string | null; covered_minutes: number }
  | { mode: 'unscheduled'; entry_id: string };

const BellIcon = ({ on }: { on: boolean }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />{!on && <path d="M3 3l18 18" />}</svg>
);

/**
 * Worker's big round clock button. Tapping anywhere on the circle clocks in at once; then, depending on the
 * schedule, it asks a follow-up: late beyond the grace period (and who stayed on), or no shift right now
 * (covering someone? takeover / swap / extra shift).
 */
export function ClockPanel({ b, empId, userId, reload }: { b: Bundle; empId: string; userId: string; reload: () => void }) {
  const toast = useToast();
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [push, setPush] = useState(pushIsOn());
  const [missed, setMissed] = useState(false);
  const [ask, setAsk] = useState<ClockResult | null>(null);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 20000); return () => clearInterval(t); }, []);

  const mine = keysOf(b, empId).filter((k) => { const d = parseCell(k).date; return d >= addDays(todayIso(), -1) && d <= addDays(todayIso(), 14); });
  const entryFor = (k: string) => b.entries.find((e) => e.employee_id === empId && e.slot_id === parseCell(k).slot && e.work_date === parseCell(k).date);
  const open = b.entries.find((e) => e.employee_id === empId && !e.clock_out);
  const current = mine.find((k) => { const w = shiftWindow(b, k); return now >= w.start.getTime() - 30 * 60000 && now <= w.end.getTime() && !entryFor(k); });
  const next = mine.find((k) => shiftWindow(b, k).start.getTime() > now && !entryFor(k));
  const openKey = open?.slot_id ? cellKey(open.slot_id, open.work_date) : null;

  const clockIn = async () => {
    setBusy(true);
    const { data, error } = await supabase.rpc('clock_in_now', {});
    setBusy(false);
    if (error) return toast(errText(error), 'error', "Didn't clock in");
    const r = data as ClockResult;
    reload();
    if (r.mode === 'scheduled') toast(`Clocked in for ${r.label}. Have a good shift!`, 'ok', 'Clocked in');
    else setAsk(r);
  };
  const clockOut = async () => {
    setBusy(true);
    const { error } = await supabase.rpc('clock_out');
    setBusy(false);
    if (error) toast(errText(error), 'error', "Didn't clock out"); else { toast('Clocked out. Your hours are saved.', 'ok', 'Done'); reload(); }
  };
  const turnOn = async () => {
    if (push) return toast("Shift reminders are on for this phone. To turn them off, block notifications for this site in your phone's settings.", 'ok', 'Reminders on');
    try { await enablePush(userId); setPush(true); toast("Reminders are on. You'll get a notification when it's time to clock in and out.", 'ok', 'Reminders on'); }
    catch (e) { toast(errText(e), 'error', "Couldn't turn on"); }
  };

  let face;
  if (open) {
    face = (<>
      <div className="clock-btn on" role="status" aria-live="polite"><span>On the clock<b>{elapsed(open.clock_in, now)}</b></span></div>
      <p className="clock-sub">Since {clockTime(open.clock_in)}{openKey && slotOf(b, openKey) ? ` · ${slotLabel(b, openKey)}` : open.note ? ` · ${open.note}` : ''}</p>
      {!open.slot_id && open.note === 'No scheduled shift' && <button className="btn small" onClick={() => setAsk({ mode: 'unscheduled', entry_id: open.id })}>Covering someone? Tell us</button>}
      <button className="btn big danger clock-out" disabled={busy} onClick={clockOut}>Clock out</button>
    </>);
  } else {
    const w = current ? shiftWindow(b, current) : null;
    face = (<>
      <button className="clock-btn" disabled={busy} onClick={clockIn} aria-label="Clock in now">
        <span>{busy ? '…' : 'Clock in'}<small>{w ? `${clockTime(w.start)} shift` : 'tap to start'}</small></span></button>
      <p className="clock-sub">{current ? `${slotLabel(b, current)}${now > w!.start.getTime() + 5 * 60000 ? ` · started ${Math.round((now - w!.start.getTime()) / 60000)} min ago` : ''}`
        : next ? `No shift right now. Next: ${slotLabel(b, next)}. You can still clock in to cover someone or work an extra shift.`
        : 'No shift right now. You can still clock in to cover someone or work an extra shift.'}</p>
    </>);
  }

  return (
    <section className="panel">
      <div className="panel-head"><h2>Time clock</h2>
        <span className="clock-tools">
          {(pushSupported() || isIOS()) && <button className={`btn icon bellbtn${push ? ' on' : ''}`} onClick={turnOn}
            title={push ? 'Shift reminders are on' : 'Turn on shift reminders'} aria-label={push ? 'Shift reminders are on' : 'Turn on shift reminders'}><BellIcon on={push} /></button>}
          <span className={`lamp${open ? ' on' : ''}`} title={open ? 'On the clock' : 'Not clocked in'} /></span></div>
      <div className="clock">{face}</div>
      <div className="actions" style={{ justifyContent: 'center' }}>
        <button className="linkish" onClick={() => setMissed(true)}>Forgot to clock in or out?</button>
      </div>
      {!push && isIOS() && !isStandalone() && <p className="hint" style={{ textAlign: 'center', margin: '8px 0 0' }}>iPhone: tap Share → Add to Home Screen, then open SplitYourShift from your home screen to get reminders.</p>}
      {missed && <MissedPunchSheet b={b} empId={empId} onClose={() => setMissed(false)} reload={reload} />}
      {ask?.mode === 'late' && <LateSheet r={ask} onClose={() => setAsk(null)} reload={reload} />}
      {ask?.mode === 'unscheduled' && <CoverAsk b={b} empId={empId} entryId={ask.entry_id} onClose={() => setAsk(null)} reload={reload} />}
    </section>
  );
}

/** Late beyond the grace period. If the previous worker stayed on: ignore (they approve), swap later (they accept) or payroll. */
function LateSheet({ r, onClose, reload }: { r: Extract<ClockResult, { mode: 'late' }>; onClose: () => void; reload: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const choose = async (c: 'ignore' | 'swap' | 'payroll') => {
    setBusy(true);
    const { error } = await supabase.rpc('late_choice', { p_entry: r.entry_id, p_choice: c });
    setBusy(false);
    if (error) return toast(errText(error), 'error', 'Not saved');
    toast(c === 'payroll' ? 'Saved. Your real clock-in time is used for pay.' : `Sent to ${r.covered_name}. You'll get a notification when they answer.`, 'ok', 'Saved');
    onClose(); reload();
  };
  const who = r.covered_name, m = r.covered_minutes;
  return (
    <Sheet eyebrow="Clocked in" title={`You clocked in ${r.late_minutes} minutes late`} onClose={onClose}>
      <div className="sec"><p>{r.label}. Your real clock-in time ({clockTime(new Date())}) is saved. {who ? <><b>{who}</b> stayed {m} minutes to cover your shift. How would you like to handle this?</> : `Nobody needed to stay for you, so there is nothing to agree on.`}</p></div>
      {who ? <>
        <div className="option"><h4>Ignore</h4><p>Ask {who} to call it even. When they approve, it's recorded that you both agreed to ignore it.</p>
          <div><button className="btn" disabled={busy} onClick={() => choose('ignore')}>Ask {who} to ignore it</button></div></div>
        <div className="option best"><h4>Request a swap</h4><p>Another day you come {m} minutes early so {who} can leave {m} minutes early. {who} accepts or declines.</p>
          <div><button className="btn primary" disabled={busy} onClick={() => choose('swap')}>Offer {m} minutes back</button></div></div>
        <div className="option"><h4>Use normal payroll</h4><p>No swap. {who}'s extra minutes and your shorter shift are paid as your manager's payroll settings say.</p>
          <div><button className="btn" disabled={busy} onClick={() => choose('payroll')}>Use normal payroll</button></div></div>
      </> : <div className="actions"><button className="btn primary" onClick={() => { choose('payroll'); }}>OK</button></div>}
    </Sheet>
  );
}

/** Clocked in with no shift on now: covering someone? takeover / swap / extra paid shift. */
function CoverAsk({ b, empId, entryId, onClose, reload }: { b: Bundle; empId: string; entryId: string; onClose: () => void; reload: () => void }) {
  const toast = useToast();
  const now = Date.now();
  const [pick, setPick] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const me = empOf(b, empId);
  const myLocs = b.locs.filter((l) => me?.locs.includes(l.id));
  const [loc, setLoc] = useState(myLocs[0]?.id ?? b.locs[0]?.id ?? '');
  const days = [addDays(todayIso(), -1), todayIso()];
  const cells = b.slots.flatMap((s) => days.map((d) => cellKey(s.id, d)))
    .filter((k) => { const w = shiftWindow(b, k); return now >= w.start.getTime() - 30 * 60000 && now <= w.end.getTime() && b.assign[k] !== empId; })
    .sort((x, y) => shiftWindow(b, x).start.getTime() - shiftWindow(b, y).start.getTime());
  const taken = (k: string) => b.entries.find((e) => e.slot_id === parseCell(k).slot && e.work_date === parseCell(k).date);
  const go = async (kind: 'takeover' | 'swap' | 'extra', k: string | null) => {
    setBusy(true);
    const args = k ? { p_entry: entryId, p_kind: kind, p_slot: parseCell(k).slot, p_date: parseCell(k).date } : { p_entry: entryId, p_kind: 'extra', p_loc: loc || null };
    const { error } = await supabase.rpc('resolve_unscheduled', args);
    setBusy(false);
    if (error) return toast(errText(error), 'error', 'Not saved');
    const other = k ? empOf(b, b.assign[k])?.name : null;
    toast(kind === 'swap' ? `Saved. ${other} gets a swap request; your manager is told.` : kind === 'takeover' ? `Saved. The shift is yours now; nothing is owed.` : 'Saved as an extra paid shift. Your manager is told.', 'ok', 'Saved');
    onClose(); reload();
  };
  if (pick) {
    const other = empOf(b, b.assign[pick]);
    return (
      <Sheet eyebrow="Covering a shift" title={slotLabel(b, pick)} onClose={onClose}>
        <div className="sec"><p>{other ? <>You're working <b>{other.name}</b>'s shift. How was it arranged?</> : 'This shift is open. It moves to you.'}</p></div>
        {other && <div className="option"><h4>Shift takeover</h4><p>{other.name} gave you the whole shift. Nobody owes anything later.</p>
          <div><button className="btn" disabled={busy} onClick={() => go('takeover', pick)}>{other.name} gave it to me</button></div></div>}
        {other && <div className="option best"><h4>Shift swap</h4><p>You cover today; {other.name} covers one of your shifts later. {other.name} gets a request to accept.</p>
          <div><button className="btn primary" disabled={busy} onClick={() => go('swap', pick)}>Ask {other.name} for a swap</button></div></div>}
        <div className="option"><h4>Extra paid shift</h4><p>You're working an extra shift. No swap later; your real hours are paid.</p>
          <div><button className="btn" disabled={busy} onClick={() => go('extra', pick)}>It's an extra shift</button></div></div>
        <div><button className="btn" onClick={() => setPick(null)}>‹ Pick another shift</button></div>
      </Sheet>);
  }
  return (
    <Sheet eyebrow="Clocked in" title="You don't have a scheduled shift right now" onClose={onClose}>
      <div className="sec"><p>You're clocked in from {clockTime(new Date())}. <b>Are you covering someone else's shift?</b> Pick it below.</p></div>
      <div className="list">{cells.length ? cells.map((k) => {
        const o = empOf(b, b.assign[k]); const t = taken(k);
        return (<button key={k} className="row" disabled={!!t} onClick={() => setPick(k)}>
          <span className="main"><b>{slotLabel(b, k)}</b><span>{t ? `${empOf(b, t.employee_id)?.name ?? 'Someone'} already clocked in` : o ? `${o.name}'s shift` : 'Open shift'}</span></span>
          {t ? <span className="tag plain">Taken</span> : <span className="tag ok">I'm covering</span>}</button>);
      }) : <p className="empty-note">No other shifts are happening right now.</p>}</div>
      <div className="option"><h4>No, I'm working an extra shift</h4><p>Not covering anyone. Your real hours are paid as an extra shift.</p>
        {b.locs.length > 1 && <div className="field" style={{ maxWidth: 320 }}><label htmlFor="cv-loc">Where</label>
          <select id="cv-loc" value={loc} onChange={(e) => setLoc(e.target.value)}>{(myLocs.length ? myLocs : b.locs).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>}
        <div><button className="btn" disabled={busy} onClick={() => go('extra', null)}>Extra shift{b.locs.length > 1 ? ` at ${b.locs.find((l) => l.id === loc)?.name ?? ''}` : ''}</button></div></div>
    </Sheet>
  );
}

const toLocalInput = (d: Date) => { const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

/** Missed punch: a shift the worker forgot to clock in or out of. The manager approves the times. */
function MissedPunchSheet({ b, empId, onClose, reload }: { b: Bundle; empId: string; onClose: () => void; reload: () => void }) {
  const toast = useToast();
  const now = Date.now();
  const entryOf = (k: string) => b.entries.find((t) => t.employee_id === empId && t.slot_id === parseCell(k).slot && t.work_date === parseCell(k).date);
  const pendingFix = (k: string) => b.fixes.some((f) => f.employee_id === empId && f.slot_id === parseCell(k).slot && f.work_date === parseCell(k).date && f.status === 'pending');
  // Shifts that are over and have no clock-in, or a clock-in still open long after the shift ended.
  const missed = keysOf(b, empId).filter((k) => {
    const d = parseCell(k).date; if (d < addDays(todayIso(), -14) || d > todayIso()) return false;
    const w = shiftWindow(b, k), e = entryOf(k);
    return w.end.getTime() < now && !pendingFix(k) && (!e || (!e.clock_out && now > w.end.getTime() + 2 * 36e5));
  }).reverse();
  const [cell, setCell] = useState(missed[0] ?? '');
  const init = (k: string) => { const x = shiftWindow(b, k), e = entryOf(k); return { a: toLocalInput(e ? new Date(e.clock_in) : x.start), z: toLocalInput(x.end) }; };
  const [t, setT] = useState(cell ? init(cell) : { a: '', z: '' });
  const [reason, setReason] = useState('');
  const send = async () => {
    if (!cell) return;
    const a = new Date(t.a), z = new Date(t.z);
    if (!(z > a)) return toast('Clock-out has to be after clock-in.', 'error', 'Check the times');
    const { error } = await supabase.rpc('request_time_fix', { p_slot: parseCell(cell).slot, p_date: parseCell(cell).date, p_in: a.toISOString(), p_out: z.toISOString(), p_reason: reason });
    if (error) return toast(errText(error), 'error', 'Not sent');
    toast('Sent to your manager. Those hours count once they approve.', 'ok', 'Sent'); onClose(); reload();
  };
  return (
    <Sheet eyebrow="Time clock" title="Missed punch" onClose={onClose}>
      {missed.length ? <>
        <div className="sec"><p>Forgot to clock in or out? Pick the shift and send the times you really worked. Your manager approves them.</p></div>
        <div className="field"><label htmlFor="mp-shift">Shift</label>
          <select id="mp-shift" value={cell} onChange={(e) => { setCell(e.target.value); setT(init(e.target.value)); }}>
            {missed.map((k) => <option key={k} value={k}>{slotLabel(b, k)} · {entryOf(k) ? 'no clock-out' : 'no clock-in'}</option>)}</select></div>
        <div className="twocol">
          <div className="field"><label htmlFor="mp-in">Started</label><input type="datetime-local" id="mp-in" value={t.a} onChange={(e) => setT({ ...t, a: e.target.value })} /></div>
          <div className="field"><label htmlFor="mp-out">Finished</label><input type="datetime-local" id="mp-out" value={t.z} onChange={(e) => setT({ ...t, z: e.target.value })} /></div>
        </div>
        <div className="field"><label htmlFor="mp-why">Reason (optional)</label><input type="text" id="mp-why" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Phone died, forgot to clock out…" /></div>
        <div><button className="btn primary" onClick={send}>Send to manager</button></div>
      </> : <div className="sec"><p>No missed punches in the last two weeks: every finished shift has a clock-in and a clock-out. If a time is wrong, ask your manager to fix it.</p></div>}
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
      {es.map((e) => <tr key={e.id}><td>{label(e)}{e.note && <div className="hint" style={{ margin: 0 }}>{e.note}</div>}</td><td>{clockTime(e.clock_in)}{e.claimed_in && <div><span className="tag warn">Asked for {clockTime(e.claimed_in)}</span></div>}</td><td>{e.clock_out ? clockTime(e.clock_out) : <span className="tag warn">On the clock</span>}</td>
        <td className="num">{e.clock_out ? entryHours(e) : '—'}</td><td>{e.source !== 'clock' && <span className="tag plain">{e.source === 'owner' ? 'Added by manager' : 'Fixed'}</span>}</td></tr>)}
      {fx.map((f) => <tr key={f.id}><td>{label(f)}</td><td>{clockTime(f.clock_in)}</td><td>{clockTime(f.clock_out)}</td><td className="num">{entryHours(f)}</td>
        <td>{f.status === 'pending' ? <span className="actions"><span className="tag warn">Waiting</span>{onCancel && <button className="mini" onClick={() => onCancel(f)}>Cancel</button>}</span>
          : <span className="tag bad">{f.status === 'denied' ? 'Denied' : 'Cancelled'}</span>}</td></tr>)}
    </tbody></table></div>
  );
}
