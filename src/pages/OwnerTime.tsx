import { useState } from 'react';
import { supabase, errText } from '../lib/supabase';
import { DAY_SHORT, addDays, mmdd, rangeTitle, shiftLong, todayIso } from '../lib/time';
import { cellKey, empOf, entryHours, keysOf, locName, parseCell, slotLabel, round2 } from '../lib/rules';
import type { Bundle, TimeEntry } from '../lib/types';
import { ConfirmButton, Sheet, useToast } from '../components/ui';
import { clockTime, shiftWindow } from '../components/Clock';

const toLocalInput = (d: Date) => { const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
type Edit = { entry?: TimeEntry; empId?: string; cell?: string } | null;

/** Owner's Time clock tab: who is on the clock, hour-fix requests, and every clocked shift of the week. */
export default function TimeClock({ b, week, tabs, reload }: { b: Bundle; week: string; tabs: React.ReactNode; reload: () => void }) {
  const toast = useToast();
  const [edit, setEdit] = useState<Edit>(null);
  const open = b.entries.filter((e) => !e.clock_out);
  const fixes = b.fixes.filter((f) => f.status === 'pending');
  const claims = b.entries.filter((e) => e.claimed_in);
  const weekEntries = b.entries.filter((e) => e.work_date >= week && e.work_date < addDays(week, 7)).sort((x, y) => x.clock_in.localeCompare(y.clock_in));
  const now = Date.now();
  // Scheduled shifts this week that have ended with nobody clocked in.
  const missing = b.slots.flatMap((s) => Array.from({ length: 7 }, (_, d) => cellKey(s.id, addDays(week, d))))
    .filter((k) => b.assign[k] && shiftWindow(b, k).end.getTime() < now && !b.entries.some((e) => e.employee_id === b.assign[k] && e.slot_id === parseCell(k).slot && e.work_date === parseCell(k).date)
      && !b.reqs.some((r) => r.status === 'approved' && r.slot_id === parseCell(k).slot && r.work_date === parseCell(k).date))
    .sort();
  const shiftOf = (e: { slot_id: string | null; work_date: string }) => {
    const s = e.slot_id ? b.slots.find((x) => x.id === e.slot_id) : undefined;
    const dow = DAY_SHORT[(new Date(e.work_date + 'T00:00:00Z').getUTCDay() + 6) % 7];
    return `${dow} ${mmdd(e.work_date)}${s ? ` · ${locName(b, s.location_id)} ${shiftLong(s.start_hour, s.hours)}` : ''}`;
  };
  const decide = async (id: string, approve: boolean) => {
    const { error } = await supabase.rpc('decide_time_fix', { p_id: id, p_approve: approve });
    if (error) toast(errText(error), 'error', 'Not saved'); else toast(approve ? 'Approved. The hours now count for pay.' : 'Denied.', approve ? 'ok' : 'warn', approve ? 'Approved' : 'Denied');
    reload();
  };
  const clockOutNow = async (e: TimeEntry) => {
    const { error } = await supabase.from('time_entries').update({ clock_out: new Date().toISOString(), source: 'owner' }).eq('id', e.id);
    if (error) toast(errText(error), 'error', 'Not saved'); else toast(`${empOf(b, e.employee_id)?.name} clocked out.`, 'ok', 'Done');
    reload();
  };
  const total = round2(weekEntries.reduce((n, e) => n + entryHours(e), 0));

  return (
    <div className="layout">{tabs}
      <section className="panel"><div className="panel-head"><h2>On the clock now</h2><span className={`lamp${open.length ? ' on' : ''}`} /></div>
        <p className="hint">Workers clock in from their phone. A reminder goes to their phone when the shift starts and ends.</p>
        <div className="stack">{open.length ? open.map((e) => { const w = empOf(b, e.employee_id); const hrs = (now - new Date(e.clock_in).getTime()) / 36e5; return (
          <div key={e.id} className="oncard"><span className="lamp on" /><span className="main"><b>{w?.name ?? '?'}</b><span>Since {clockTime(e.clock_in)} · {shiftOf(e)}</span></span>
            {hrs > 14 && <span className="tag bad">Forgot to clock out?</span>}
            <button className="btn small" onClick={() => clockOutNow(e)}>Clock out now</button></div>); })
          : <p className="empty-note">Nobody is clocked in right now.</p>}</div></section>

      {fixes.length > 0 && <section className="panel"><div className="panel-head"><h2>Hour fixes to approve<span className="badge">{fixes.length}</span></h2></div>
        <p className="hint">Workers send these when they forgot to clock in or out. Approved hours count for pay.</p>
        <div className="stack">{fixes.map((f) => (
          <div key={f.id} className="item"><div><b>{empOf(b, f.employee_id)?.name ?? '?'}</b> · {shiftOf(f)}</div>
            <small>{clockTime(f.clock_in)} – {clockTime(f.clock_out)} · {entryHours(f)} h</small>{f.reason && <q>{f.reason}</q>}
            <div className="actions"><button className="btn small primary" onClick={() => decide(f.id, true)}>Approve</button><button className="btn small" onClick={() => decide(f.id, false)}>Deny</button></div></div>))}</div></section>}

      {claims.length > 0 && <section className="panel"><div className="panel-head"><h2>Late clock-ins to confirm<span className="badge">{claims.length}</span></h2></div>
        <p className="hint">These workers clocked in late but say they started on time. Until you approve, they're paid from when they actually clocked in.</p>
        <div className="stack">{claims.map((e) => (
          <div key={e.id} className="item"><div><b>{empOf(b, e.employee_id)?.name ?? '?'}</b> · {shiftOf(e)}</div>
            <small>Clocked in {clockTime(e.clock_in)} · says started {clockTime(e.claimed_in!)} ({Math.round((new Date(e.clock_in).getTime() - new Date(e.claimed_in!).getTime()) / 60000)} min earlier)</small>
            {e.note && <q>{e.note}</q>}
            <div className="actions">
              <button className="btn small primary" onClick={async () => { const { error } = await supabase.rpc('decide_claimed_start', { p_entry: e.id, p_approve: true }); if (error) toast(errText(error), 'error', 'Not saved'); else toast(`Approved: paid from ${clockTime(e.claimed_in!)}.`, 'ok', 'Approved'); reload(); }}>Approve {clockTime(e.claimed_in!)}</button>
              <button className="btn small" onClick={async () => { const { error } = await supabase.rpc('decide_claimed_start', { p_entry: e.id, p_approve: false }); if (error) toast(errText(error), 'error', 'Not saved'); else toast(`Kept the real clock-in, ${clockTime(e.clock_in)}.`, 'ok', 'Saved'); reload(); }}>Keep {clockTime(e.clock_in)}</button>
            </div></div>))}</div></section>}

      {missing.length > 0 && <section className="panel"><div className="panel-head"><h2>No clock-in</h2></div>
        <p className="hint">These shifts are over but nobody clocked in, so they aren't paid. Add the hours if the person worked.</p>
        <div className="stack">{missing.map((k) => (
          <div key={k} className="oncard"><span className="lamp" /><span className="main"><b>{empOf(b, b.assign[k])?.name}</b><span>{slotLabel(b, k)}</span></span>
            <button className="btn small" onClick={() => setEdit({ empId: b.assign[k], cell: k })}>Add hours</button></div>))}</div></section>}

      <section className="panel"><div className="panel-head"><h2>Clocked hours · {rangeTitle(week, addDays(week, 6))}</h2>
        <button className="btn small primary" onClick={() => setEdit({})}>+ Add hours</button></div>
        <p className="hint">{total} hours this week. Edit any row if the times are wrong; every change shows in the worker's hours.</p>
        <div className="table-wrap"><table className="data"><thead><tr><th>Worker</th><th>Shift</th><th>In</th><th>Out</th><th className="num">Hours</th><th>Source</th><th /></tr></thead><tbody>
          {weekEntries.map((e) => <tr key={e.id}><td>{empOf(b, e.employee_id)?.name ?? '?'}</td><td>{shiftOf(e)}{e.note && <div className="hint" style={{ margin: 0 }}>{e.note}</div>}</td><td>{clockTime(e.clock_in)}</td>
            <td>{e.clock_out ? clockTime(e.clock_out) : <span className="tag ok">On the clock</span>}</td><td className="num">{e.clock_out ? entryHours(e) : '—'}</td>
            <td>{e.source === 'clock' ? 'Phone' : e.source === 'owner' ? 'You' : 'Fix request'}</td>
            <td><button className="mini" onClick={() => setEdit({ entry: e })}>Edit</button></td></tr>)}
          {!weekEntries.length && <tr><td colSpan={7}>No clocked hours this week yet.</td></tr>}</tbody></table></div></section>

      {edit && <EntrySheet b={b} week={week} edit={edit} onClose={() => setEdit(null)} reload={reload} />}
    </div>
  );
}

function EntrySheet({ b, week, edit, onClose, reload }: { b: Bundle; week: string; edit: NonNullable<Edit>; onClose: () => void; reload: () => void }) {
  const toast = useToast();
  const e = edit.entry;
  const [empId, setEmp] = useState(e?.employee_id ?? edit.empId ?? b.emps[0]?.id ?? '');
  const cells = keysOf(b, empId).filter((k) => parseCell(k).date >= addDays(week, -7) && parseCell(k).date <= todayIso());
  const initCell = e?.slot_id ? cellKey(e.slot_id, e.work_date) : edit.cell ?? '';
  const [cell, setCell] = useState(initCell);
  const win = cell && b.slots.some((s) => s.id === parseCell(cell).slot) ? shiftWindow(b, cell) : null;
  const [inT, setIn] = useState(e ? toLocalInput(new Date(e.clock_in)) : win ? toLocalInput(win.start) : '');
  const [outT, setOut] = useState(e?.clock_out ? toLocalInput(new Date(e.clock_out)) : win ? toLocalInput(win.end) : '');
  const [note, setNote] = useState(e?.note ?? '');
  const pickCell = (k: string) => { setCell(k); if (k) { const w = shiftWindow(b, k); setIn(toLocalInput(w.start)); setOut(toLocalInput(w.end)); } };

  const save = async () => {
    const a = new Date(inT), z = outT ? new Date(outT) : null;
    if (!empId || isNaN(a.getTime())) return toast('Pick the worker and the clock-in time.', 'error', 'Missing');
    if (z && !(z > a)) return toast('Clock-out has to be after clock-in.', 'error', 'Check the times');
    const work_date = cell ? parseCell(cell).date : toLocalInput(a).slice(0, 10);
    const row = { org_id: b.org.id, employee_id: empId, slot_id: cell ? parseCell(cell).slot : null, work_date, clock_in: a.toISOString(), clock_out: z ? z.toISOString() : null, source: 'owner', note: note.trim() || null };
    const { error } = e ? await supabase.from('time_entries').update(row).eq('id', e.id) : await supabase.from('time_entries').insert(row);
    if (error) return toast(/time_entries_one_open/.test(error.message) ? 'This worker is already clocked in. Add a clock-out time.' : errText(error), 'error', 'Not saved');
    toast('Hours saved.', 'ok', 'Saved'); onClose(); reload();
  };
  return (
    <Sheet eyebrow="Time clock" title={e ? 'Edit hours' : 'Add hours'} onClose={onClose}>
      <div className="field"><label htmlFor="te-emp">Worker</label>
        <select id="te-emp" value={empId} disabled={!!e} onChange={(ev) => { setEmp(ev.target.value); setCell(''); }}>{b.emps.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></div>
      <div className="field"><label htmlFor="te-shift">Shift</label>
        <select id="te-shift" value={cell} onChange={(ev) => pickCell(ev.target.value)}>
          <option value="">Not a scheduled shift</option>
          {[...new Set([initCell, ...cells].filter(Boolean))].map((k) => <option key={k} value={k}>{b.slots.some((s) => s.id === parseCell(k).slot) ? slotLabel(b, k) : k}</option>)}</select></div>
      <div className="twocol">
        <div className="field"><label htmlFor="te-in">Clock in</label><input type="datetime-local" id="te-in" value={inT} onChange={(ev) => setIn(ev.target.value)} /></div>
        <div className="field"><label htmlFor="te-out">Clock out</label><input type="datetime-local" id="te-out" value={outT} onChange={(ev) => setOut(ev.target.value)} /></div>
      </div>
      <div className="field"><label htmlFor="te-note">Note (optional)</label><input type="text" id="te-note" value={note} onChange={(ev) => setNote(ev.target.value)} placeholder="Forgot to clock out" /></div>
      <div className="actions"><button className="btn primary" onClick={save}>Save hours</button>
        {e && <ConfirmButton label="Delete" confirmLabel="Click again to delete" onConfirm={async () => {
          const { error } = await supabase.from('time_entries').delete().eq('id', e.id);
          if (error) return toast(errText(error), 'error', "Couldn't delete");
          toast('Hours deleted.', 'warn', 'Deleted'); onClose(); reload();
        }} />}</div>
    </Sheet>
  );
}
