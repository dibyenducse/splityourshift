import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase, errText } from '../lib/supabase';
import { DAY_LONG, addDays, ago, mmdd, shiftLong, shiftShort, todayIso } from '../lib/time';
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

/**
 * Shift reports and tasks for one day, shift by shift. Workers write a report for their own shift and tick off its
 * tasks; everyone at the business reads the reports. The owner also sets up the task lists.
 */
export function ShiftLog({ b, empId, owner, compact }: { b: Bundle; empId?: string; owner?: boolean; compact?: boolean }) {
  const toast = useToast();
  const [date, setDate] = useState(todayIso());
  const [reports, setReports] = useState<Report[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [checks, setChecks] = useState<Check[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const me = empId ? empOf(b, empId) : undefined;

  const load = useCallback(async () => {
    const [r, t, c] = await Promise.all([
      supabase.from('shift_reports').select('*').eq('org_id', b.org.id).eq('work_date', date).order('created_at'),
      supabase.from('shift_tasks').select('*').eq('org_id', b.org.id).eq('active', true).order('created_at'),
      supabase.from('task_checks').select('task_id, work_date, employee_id, done_at').eq('org_id', b.org.id).eq('work_date', date),
    ]);
    setReports((r.data ?? []) as Report[]); setTasks((t.data ?? []) as Task[]); setChecks((c.data ?? []) as Check[]);
  }, [b.org.id, date]);
  useEffect(() => {
    load();
    const ch = supabase.channel(`log-${b.org.id}-${empId ?? 'owner'}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'shift_reports', filter: `org_id=eq.${b.org.id}` }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'task_checks', filter: `org_id=eq.${b.org.id}` }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [b.org.id, empId, load]);

  const locs = owner ? b.locs : b.locs.filter((l) => me?.locs.includes(l.id) || b.slots.some((s) => s.location_id === l.id && b.assign[cellKey(s.id, date)] === empId));
  const tasksFor = (locId: string, slotId: string) => tasks.filter((t) => t.location_id === locId && (t.slot_id === slotId || !t.slot_id) && (t.repeat === 'daily' || t.on_date === date));
  const canWrite = (slotId: string) => owner || (!!empId && b.assign[cellKey(slotId, date)] === empId);

  const post = async (locId: string, slotId: string) => {
    const key = `${locId}|${slotId}`, body = (draft[key] ?? '').trim();
    if (!body) return toast('Write something first.', 'error', 'Empty report');
    const author = empId ?? b.emps.find((e) => e.user_id && e.user_id === b.org.owner_id)?.id;
    if (!author) return toast('You need a worker profile to write reports.', 'error', "Can't post");
    setBusy(key);
    const { error } = await supabase.from('shift_reports').insert({ org_id: b.org.id, location_id: locId, slot_id: slotId, work_date: date, employee_id: author, body });
    setBusy('');
    if (error) return toast(errText(error), 'error', 'Not posted');
    setDraft({ ...draft, [key]: '' }); toast(owner ? 'Posted.' : 'Posted. Your manager is notified.', 'ok', 'Shift report'); load();
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
  const tick = async (t: Task, slotId: string, on: boolean) => {
    const who = empId ?? b.emps.find((e) => e.user_id === b.org.owner_id)?.id;
    if (on) {
      if (!who) return toast('You need a worker profile to tick tasks.', 'error', "Can't tick");
      const { error } = await supabase.from('task_checks').insert({ task_id: t.id, work_date: date, org_id: b.org.id, employee_id: who });
      if (error) return toast(errText(error), 'error', 'Not saved');
    } else {
      const { error } = await supabase.from('task_checks').delete().eq('task_id', t.id).eq('work_date', date);
      if (error) return toast(errText(error), 'error', 'Not saved');
    }
    void slotId; load();
  };

  const general = reports.filter((r) => !r.slot_id);
  return (
    <section className="panel shiftlog" id="shift-log">
      <div className="panel-head"><h2>Shift reports{compact ? ' and tasks' : ''}</h2>
        <div className="datepick">
          <button className="btn icon" onClick={() => setDate(addDays(date, -1))} aria-label="Previous day">‹</button>
          <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} aria-label="Day" />
          <button className="btn icon" onClick={() => setDate(addDays(date, 1))} aria-label="Next day">›</button>
          {date !== todayIso() && <button className="btn small" onClick={() => setDate(todayIso())}>Today</button>}
        </div></div>
      <p className="hint">{dayName(date)}. {owner ? 'What each shift wrote for the next shift and for you, and how their tasks went. You get a notification for every new report.'
        : 'Write what the next shift and your manager should know. Everyone here can read the reports; your manager gets a notification.'}</p>
      {locs.map((l) => {
        const slots = b.slots.filter((s) => s.location_id === l.id).sort((x, y) => shiftOrder(x) - shiftOrder(y));
        return (
          <div key={l.id} className="log-loc">
            {(owner ? b.locs.length > 1 : locs.length > 1) && <h3>{l.name}</h3>}
            {slots.map((s) => {
              const k = cellKey(s.id, date), who = empOf(b, b.assign[k]), mine = canWrite(s.id), key = `${l.id}|${s.id}`;
              const rs = reports.filter((r) => r.slot_id === s.id), ts = tasksFor(l.id, s.id);
              if (!owner && !mine && !rs.length) return null;
              const done = ts.filter((t) => checks.some((c) => c.task_id === t.id)).length;
              return (
                <div key={s.id} className={`log-shift${mine && !owner ? ' mine' : ''}`}>
                  <div className="log-head"><b>{l.name} {shiftShort(s.start_hour, s.hours)}</b><span>{shiftLong(s.start_hour, s.hours)}{who ? ` · ${who.name}` : ' · open'}</span>
                    {ts.length > 0 && <span className={`tag ${done === ts.length ? 'ok' : 'plain'}`}>{done}/{ts.length} tasks</span>}</div>
                  {ts.length > 0 && <ul className="tasks">{ts.map((t) => {
                    const c = checks.find((x) => x.task_id === t.id);
                    return (<li key={t.id}><label className={c ? 'done' : ''}>
                      <input type="checkbox" checked={!!c} disabled={!mine && !owner} onChange={(e) => tick(t, s.id, e.target.checked)} />
                      <span>{t.title}{t.notes && <small>{t.notes}</small>}{c && <small>Done by {empOf(b, c.employee_id)?.name ?? '?'} at {clockTime(c.done_at)}</small>}</span></label></li>);
                  })}</ul>}
                  {rs.map((r) => (
                    <div key={r.id} className="report">
                      <div className="report-meta"><b>{empOf(b, r.employee_id)?.name ?? 'Someone'}</b> · {clockTime(r.created_at)}{r.updated_at && ' (edited)'}</div>
                      {editing === r.id ? <>
                        <textarea rows={3} value={draft[`edit|${r.id}`] ?? r.body} onChange={(e) => setDraft({ ...draft, [`edit|${r.id}`]: e.target.value })} />
                        <div className="actions"><button className="btn small primary" onClick={() => saveEdit(r)}>Save</button><button className="btn small" onClick={() => setEditing(null)}>Cancel</button></div>
                      </> : <p>{r.body}</p>}
                      {editing !== r.id && (r.employee_id === empId || owner) && <div className="actions">
                        {r.employee_id === empId && <button className="mini" onClick={() => setEditing(r.id)}>Edit</button>}
                        <ConfirmButton className="mini danger-text" label="Delete" confirmLabel="Tap again" onConfirm={() => remove(r)} /></div>}
                    </div>))}
                  {mine && <div className="report-new">
                    <textarea rows={2} placeholder={`Report for ${shiftShort(s.start_hour, s.hours)}: what happened, what the next shift should know…`}
                      value={draft[key] ?? ''} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} aria-label={`Shift report for ${l.name} ${shiftShort(s.start_hour, s.hours)}`} />
                    <div><button className="btn small primary" disabled={busy === key || !(draft[key] ?? '').trim()} onClick={() => post(l.id, s.id)}>Post report</button></div>
                  </div>}
                  {!rs.length && !mine && <p className="empty-note">No report.</p>}
                </div>);
            })}
          </div>);
      })}
      {general.length > 0 && <div className="log-shift"><div className="log-head"><b>Other notes</b></div>{general.map((r) => <div key={r.id} className="report"><div className="report-meta"><b>{empOf(b, r.employee_id)?.name}</b> · {ago(r.created_at)}</div><p>{r.body}</p></div>)}</div>}
      {!owner && !locs.some((l) => b.slots.some((s) => s.location_id === l.id && (canWrite(s.id) || reports.some((r) => r.slot_id === s.id)))) &&
        <p className="empty-note">No shift for you on {dayName(date)} and no reports yet. You can write a report on a day you work.</p>}
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
