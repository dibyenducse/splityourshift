import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase, errText } from '../lib/supabase';
import { DAY_LONG, addDays, mmdd, shiftLong, shiftShort, todayIso } from '../lib/time';
import { cellKey, empOf } from '../lib/rules';
import type { Bundle, Slot } from '../lib/types';
import { ConfirmButton, useToast } from './ui';
import { clockTime } from './Clock';

interface Report { id: string; location_id: string | null; slot_id: string | null; work_date: string; employee_id: string; body: string; created_at: string; updated_at: string | null }
interface Task { id: string; location_id: string; slot_id: string | null; title: string; notes: string | null; repeat: 'daily' | 'once'; on_date: string | null; active: boolean }
interface Check { task_id: string; work_date: string; employee_id: string; done_at: string }

// The hotel day starts in the morning: 7–3, then 3–11, then the 11 pm night audit (overnight shifts last).
const shiftOrder = (s: Slot) => (s.start_hour - 5 + 24) % 24;
const dayName = (d: string) => `${DAY_LONG[(new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7]} ${mmdd(d)}`;

/** A shift on a day: slot + date (overnight shifts belong to the day they start). */
interface Turn { slot: Slot; date: string; start: number }
const turnStart = (s: Slot, d: string) => new Date(d + 'T00:00:00Z').getTime() + s.start_hour * 36e5;

/**
 * Shift reports and tasks. Reports are written by the workers on each shift (never by the owner):
 *  - a worker sees the reports of the shifts before theirs at the same hotel (the handover), ticks their tasks
 *    and writes the report for their own shift;
 *  - the owner sees every hotel's shifts for a day side by side, with task progress, and only reads.
 */
export function ShiftLog({ b, empId, owner }: { b: Bundle; empId?: string; owner?: boolean }) {
  const toast = useToast();
  const [date, setDate] = useState(todayIso());
  const [reports, setReports] = useState<Report[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [checks, setChecks] = useState<Check[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const me = empId ? empOf(b, empId) : undefined;
  const writer = !owner && !!empId; // only workers (including an owner in their worker view) write reports
  const prev = addDays(date, -1);

  const load = useCallback(async () => {
    const [r, t, c] = await Promise.all([
      supabase.from('shift_reports').select('*').eq('org_id', b.org.id).in('work_date', [prev, date]).order('created_at'),
      supabase.from('shift_tasks').select('*').eq('org_id', b.org.id).eq('active', true).order('created_at'),
      supabase.from('task_checks').select('task_id, work_date, employee_id, done_at').eq('org_id', b.org.id).in('work_date', [prev, date]),
    ]);
    setReports((r.data ?? []) as Report[]); setTasks((t.data ?? []) as Task[]); setChecks((c.data ?? []) as Check[]);
  }, [b.org.id, date, prev]);
  useEffect(() => {
    load();
    const ch = supabase.channel(`log-${b.org.id}-${empId ?? 'owner'}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'shift_reports', filter: `org_id=eq.${b.org.id}` }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'task_checks', filter: `org_id=eq.${b.org.id}` }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [b.org.id, empId, load]);

  const tasksFor = (t: Turn) => tasks.filter((x) => x.location_id === t.slot.location_id && (x.slot_id === t.slot.id || !x.slot_id) && (x.repeat === 'daily' || x.on_date === t.date));
  const isMine = (t: Turn) => writer && b.assign[cellKey(t.slot.id, t.date)] === empId;
  const turnsAt = (locId: string, days: string[]) => days.flatMap((d) => b.slots.filter((s) => s.location_id === locId).map((s) => ({ slot: s, date: d, start: turnStart(s, d) })))
    .sort((x, y) => x.start - y.start);

  const post = async (t: Turn) => {
    const key = `${t.slot.id}|${t.date}`, body = (draft[key] ?? '').trim();
    if (!body || !empId) return toast('Write something first.', 'error', 'Empty report');
    setBusy(key);
    const { error } = await supabase.from('shift_reports').insert({ org_id: b.org.id, location_id: t.slot.location_id, slot_id: t.slot.id, work_date: t.date, employee_id: empId, body });
    setBusy('');
    if (error) return toast(errText(error), 'error', 'Not posted');
    setDraft({ ...draft, [key]: '' }); toast('Posted. Your manager and the next shift can read it.', 'ok', 'Shift report'); load();
  };
  const saveEdit = async (r: Report) => {
    const body = (draft[`edit|${r.id}`] ?? r.body).trim(); if (!body) return;
    const { error } = await supabase.from('shift_reports').update({ body, updated_at: new Date().toISOString() }).eq('id', r.id);
    if (error) return toast(errText(error), 'error', 'Not saved');
    setEditing(null); load();
  };
  const remove = async (r: Report) => {
    const { error } = await supabase.from('shift_reports').delete().eq('id', r.id);
    if (error) toast(errText(error), 'error', 'Not deleted'); else load();
  };
  const tick = async (task: Task, t: Turn, on: boolean) => {
    if (!empId) return;
    const { error } = on
      ? await supabase.from('task_checks').insert({ task_id: task.id, work_date: t.date, org_id: b.org.id, employee_id: empId })
      : await supabase.from('task_checks').delete().eq('task_id', task.id).eq('work_date', t.date);
    if (error) toast(errText(error), 'error', 'Not saved'); else load();
  };

  const card = (t: Turn, tag?: string) => {
    const k = cellKey(t.slot.id, t.date), who = empOf(b, b.assign[k]), mine = isMine(t), key = `${t.slot.id}|${t.date}`;
    const rs = reports.filter((r) => r.slot_id === t.slot.id && r.work_date === t.date), ts = tasksFor(t);
    const done = ts.filter((x) => checks.some((c) => c.task_id === x.id && c.work_date === t.date)).length;
    return (
      <div key={key} className={`log-shift${mine ? ' mine' : ''}`}>
        <div className="log-head"><b>{shiftShort(t.slot.start_hour, t.slot.hours)}</b>
          <span>{t.date !== date ? `${dayName(t.date)} · ` : ''}{shiftLong(t.slot.start_hour, t.slot.hours)} · {who ? who.name : 'open'}</span>
          {tag && <span className="tag plain">{tag}</span>}
          {ts.length > 0 && <span className={`tag ${done === ts.length ? 'ok' : 'warn'}`}>{done}/{ts.length} tasks</span>}</div>
        {ts.length > 0 && <ul className="tasks">{ts.map((x) => {
          const c = checks.find((y) => y.task_id === x.id && y.work_date === t.date);
          return (<li key={x.id}><label className={c ? 'done' : ''}>
            <input type="checkbox" checked={!!c} disabled={!mine} onChange={(e) => tick(x, t, e.target.checked)} />
            <span><span className="tt">{x.title}</span>{x.notes && <small>{x.notes}</small>}{c && <small>Done by {empOf(b, c.employee_id)?.name ?? '?'} at {clockTime(c.done_at)}</small>}</span></label></li>);
        })}</ul>}
        {rs.map((r) => (
          <div key={r.id} className="report">
            <div className="report-meta"><b>{empOf(b, r.employee_id)?.name ?? 'Someone'}</b> · {clockTime(r.created_at)}{r.updated_at && ' (edited)'}</div>
            {editing === r.id ? <>
              <textarea rows={3} value={draft[`edit|${r.id}`] ?? r.body} onChange={(e) => setDraft({ ...draft, [`edit|${r.id}`]: e.target.value })} />
              <div className="actions"><button className="btn small primary" onClick={() => saveEdit(r)}>Save</button><button className="btn small" onClick={() => setEditing(null)}>Cancel</button></div>
            </> : <p>{r.body}</p>}
            {editing !== r.id && r.employee_id === empId && writer && <div className="actions">
              <button className="mini" onClick={() => setEditing(r.id)}>Edit</button>
              <ConfirmButton className="mini danger-text" label="Delete" confirmLabel="Tap again" onConfirm={() => remove(r)} /></div>}
          </div>))}
        {mine && <div className="report-new">
          <textarea rows={3} placeholder="Your shift report: what happened, what the next shift and your manager should know…"
            value={draft[key] ?? ''} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} aria-label={`Shift report for ${shiftShort(t.slot.start_hour, t.slot.hours)}`} />
          <div><button className="btn small primary" disabled={busy === key || !(draft[key] ?? '').trim()} onClick={() => post(t)}>Post report</button></div>
        </div>}
        {!rs.length && !mine && <p className="empty-note">No report{who ? ` from ${who.name}` : ''} yet.</p>}
      </div>);
  };

  const datebar = (
    <div className="datepick">
      <button className="btn icon" onClick={() => setDate(addDays(date, -1))} aria-label="Previous day">‹</button>
      <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} aria-label="Day" />
      <button className="btn icon" onClick={() => setDate(addDays(date, 1))} aria-label="Next day">›</button>
      {date !== todayIso() && <button className="btn small" onClick={() => setDate(todayIso())}>Today</button>}
    </div>);

  if (owner) return (
    <section className="panel shiftlog" id="shift-log">
      <div className="panel-head"><h2>Shift reports</h2>{datebar}</div>
      <p className="hint">{dayName(date)}. Written by the workers on each shift, morning to night audit. You get a notification for every new report; task progress shows on each shift.</p>
      {b.locs.map((l) => (
        <div key={l.id} className="log-loc"><h3>{l.name}</h3>
          <div className="log-grid">{turnsAt(l.id, [date]).sort((x, y) => shiftOrder(x.slot) - shiftOrder(y.slot)).map((t) => card(t))}</div></div>))}
    </section>);

  // Worker: at each hotel, their shift on this day and the shifts just before it (the handover).
  const myLocs = b.locs.filter((l) => me?.locs.includes(l.id) || b.slots.some((s) => s.location_id === l.id && [prev, date].some((d) => b.assign[cellKey(s.id, d)] === empId)));
  return (
    <section className="panel shiftlog" id="shift-log">
      <div className="panel-head"><h2>Shift reports and tasks</h2>{datebar}</div>
      <p className="hint">{dayName(date)}. Read what the shifts before you wrote, do your shift's tasks, and leave your report for the next shift. Your manager gets a notification.</p>
      {myLocs.map((l) => {
        const all = turnsAt(l.id, [prev, date]);
        const at = all.findIndex((t) => t.date === date && isMine(t));
        const show = at >= 0 ? all.slice(Math.max(0, at - 3), at + 1) : all.filter((t) => t.date === date);
        return (
          <div key={l.id} className="log-loc">{myLocs.length > 1 && <h3>{l.name}</h3>}
            {at < 0 && <p className="hint" style={{ margin: 0 }}>You don't work at {l.name} on {dayName(date)}. Here are its shift reports.</p>}
            {show.map((t, i) => card(t, at >= 0 && i < show.length - 1 ? 'Before your shift' : undefined))}
          </div>);
      })}
    </section>
  );
}

/** Owner: the task lists for each shift (every day, or one date). */
export function TaskManager({ b }: { b: Bundle }) {
  const toast = useToast();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [f, setF] = useState({ loc: b.locs[0]?.id ?? '', slot: '', title: '', notes: '', repeat: 'daily' as 'daily' | 'once', on_date: todayIso() });
  const load = useCallback(async () => {
    const { data } = await supabase.from('shift_tasks').select('*').eq('org_id', b.org.id).eq('active', true).order('created_at');
    setTasks((data ?? []) as Task[]);
  }, [b.org.id]);
  useEffect(() => { load(); }, [load]);
  const slots = useMemo(() => b.slots.filter((s) => s.location_id === f.loc).sort((x, y) => shiftOrder(x) - shiftOrder(y)), [b.slots, f.loc]);
  const slotName = (t: Task) => { const s = b.slots.find((x) => x.id === t.slot_id); return s ? shiftShort(s.start_hour, s.hours) : 'Every shift'; };
  const add = async () => {
    if (!f.title.trim()) return toast('Write the task first.', 'error', 'Missing');
    const { error } = await supabase.from('shift_tasks').insert({ org_id: b.org.id, location_id: f.loc, slot_id: f.slot || null, title: f.title.trim(), notes: f.notes.trim() || null,
      repeat: f.repeat, on_date: f.repeat === 'once' ? f.on_date : null });
    if (error) return toast(errText(error), 'error', 'Not added');
    setF({ ...f, title: '', notes: '' }); toast('Task added. Whoever works that shift sees it.', 'ok', 'Task list'); load();
  };
  const del = async (t: Task) => {
    const { error } = await supabase.from('shift_tasks').update({ active: false }).eq('id', t.id);
    if (error) toast(errText(error), 'error', 'Not removed'); else load();
  };
  return (
    <section className="panel">
      <div className="panel-head"><h2>Task lists</h2></div>
      <p className="hint">Give each shift its to-do list. The worker on that shift ticks tasks off; you see who did what, and when, in the shift reports.</p>
      <div className="twocol">
        <div className="field"><label htmlFor="tk-loc">Business</label><select id="tk-loc" value={f.loc} onChange={(e) => setF({ ...f, loc: e.target.value, slot: '' })}>{b.locs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>
        <div className="field"><label htmlFor="tk-slot">Shift</label><select id="tk-slot" value={f.slot} onChange={(e) => setF({ ...f, slot: e.target.value })}>
          <option value="">Every shift</option>{slots.map((s) => <option key={s.id} value={s.id}>{shiftShort(s.start_hour, s.hours)} ({shiftLong(s.start_hour, s.hours)})</option>)}</select></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label htmlFor="tk-title">Task</label><input id="tk-title" type="text" maxLength={200} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="e.g. Count the cash drawer, run the night audit report" /></div>
        <div className="field"><label htmlFor="tk-notes">Details (optional)</label><input id="tk-notes" type="text" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></div>
        <div className="field"><label htmlFor="tk-rep">When</label>
          <div className="inline-field"><select id="tk-rep" value={f.repeat} onChange={(e) => setF({ ...f, repeat: e.target.value as 'daily' | 'once' })}><option value="daily">Every day</option><option value="once">One day only</option></select>
            {f.repeat === 'once' && <input type="date" value={f.on_date} onChange={(e) => e.target.value && setF({ ...f, on_date: e.target.value })} aria-label="Task date" />}</div></div>
      </div>
      <div className="actions"><button className="btn primary" onClick={add}>Add task</button></div>
      {b.locs.map((l) => { const ts = tasks.filter((t) => t.location_id === l.id); if (!ts.length) return null; return (
        <div key={l.id} className="log-loc"><h3>{l.name}</h3>
          <div className="stack">{ts.map((t) => (
            <div key={t.id} className="item"><div><b>{slotName(t)}</b> · {t.title}{t.notes && <span className="hint"> · {t.notes}</span>}</div>
              <small>{t.repeat === 'daily' ? 'Every day' : `Only ${dayName(t.on_date!)}`}</small>
              <div className="actions"><ConfirmButton className="mini danger-text" label="Remove" confirmLabel="Tap again to remove" onConfirm={() => del(t)} /></div></div>))}</div></div>); })}
      {!tasks.length && <p className="empty-note">No tasks yet.</p>}
    </section>
  );
}
