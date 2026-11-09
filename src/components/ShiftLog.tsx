import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase, errText } from '../lib/supabase';
import { DAY_LONG, addDays, mmdd, shiftLong, shiftShort, todayIso } from '../lib/time';
import { empOf, slotById } from '../lib/rules';
import type { Bundle, Slot } from '../lib/types';
import { ConfirmButton, useToast } from './ui';
import { clockTime } from './Clock';

interface Task { id: string; location_id: string; slot_id: string | null; title: string; notes: string | null; repeat: 'daily' | 'once'; on_date: string | null; active: boolean }
interface Check { task_id: string; work_date: string; employee_id: string; done_at: string }

// The hotel day starts in the morning: 7–3, then 3–11, then the 11 pm night audit (overnight shifts last).
const shiftOrder = (s: Slot) => (s.start_hour - 5 + 24) % 24;
const dayName = (d: string) => `${DAY_LONG[(new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7]} ${mmdd(d)}`;

/**
 * My Tasks: the owner's task lists for a day, shift by shift, at the worker's locations. Any worker there can tick a
 * task off (no schedule or clock-in needed); everyone sees who did it and when. The owner sees progress read-only.
 */
export function TasksBoard({ b, empId, owner }: { b: Bundle; empId?: string; owner?: boolean }) {
  const toast = useToast();
  const [date, setDate] = useState(todayIso());
  const [tasks, setTasks] = useState<Task[]>([]);
  const [checks, setChecks] = useState<Check[]>([]);
  const me = empId ? empOf(b, empId) : undefined;
  const load = useCallback(async () => {
    const [t, c] = await Promise.all([
      supabase.from('shift_tasks').select('*').eq('org_id', b.org.id).eq('active', true).order('created_at'),
      supabase.from('task_checks').select('task_id, work_date, employee_id, done_at').eq('org_id', b.org.id).eq('work_date', date),
    ]);
    setTasks((t.data ?? []) as Task[]); setChecks((c.data ?? []) as Check[]);
  }, [b.org.id, date]);
  useEffect(() => {
    load();
    const ch = supabase.channel(`tasks-${b.org.id}-${empId ?? 'owner'}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'task_checks', filter: `org_id=eq.${b.org.id}` }, () => load()).subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [b.org.id, empId, load]);
  const tick = async (t: Task, on: boolean) => {
    if (!empId) return;
    const { error } = on
      ? await supabase.from('task_checks').insert({ task_id: t.id, work_date: date, org_id: b.org.id, employee_id: empId })
      : await supabase.from('task_checks').delete().eq('task_id', t.id).eq('work_date', date);
    if (error) toast(errText(error), 'error', 'Not saved'); else load();
  };
  const today = (t: Task) => t.repeat === 'daily' || t.on_date === date;
  const locs = owner ? b.locs : b.locs.filter((l) => me?.locs.includes(l.id)).length ? b.locs.filter((l) => me?.locs.includes(l.id)) : b.locs;
  const all = tasks.filter(today).filter((t) => locs.some((l) => l.id === t.location_id));
  const doneN = all.filter((t) => checks.some((c) => c.task_id === t.id)).length;

  return (
    <section className="panel" id="my-tasks">
      <div className="panel-head"><h2>{owner ? 'Tasks today' : 'My tasks'}</h2>
        <div className="datepick">
          <button className="btn icon" onClick={() => setDate(addDays(date, -1))} aria-label="Previous day">‹</button>
          <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} aria-label="Day" />
          <button className="btn icon" onClick={() => setDate(addDays(date, 1))} aria-label="Next day">›</button>
          {date !== todayIso() && <button className="btn small" onClick={() => setDate(todayIso())}>Today</button>}
        </div></div>
      <p className="hint">{dayName(date)} · {doneN} of {all.length} done. {owner ? 'Workers tick tasks off from their phone.' : 'Tick a task when it is done; your manager sees who did it and when.'}</p>
      {locs.map((l) => {
        const groups = [...b.slots.filter((s) => s.location_id === l.id).sort((x, y) => shiftOrder(x) - shiftOrder(y)).map((s) => ({ s, ts: all.filter((t) => t.location_id === l.id && t.slot_id === s.id) })),
          { s: null as Slot | null, ts: all.filter((t) => t.location_id === l.id && !t.slot_id) }].filter((g) => g.ts.length);
        if (!groups.length) return null;
        return (
          <div key={l.id} className="log-loc">{locs.length > 1 && <h3>{l.name}</h3>}
            <div className="log-grid">{groups.map(({ s, ts }) => {
              const d = ts.filter((t) => checks.some((c) => c.task_id === t.id)).length;
              return (
                <div key={s?.id ?? 'any'} className="log-shift">
                  <div className="log-head"><b>{s ? `${shiftShort(s.start_hour, s.hours)} shift` : 'Every shift'}</b>{s && <span>{shiftLong(s.start_hour, s.hours)}</span>}
                    <span className={`tag ${d === ts.length ? 'ok' : 'warn'}`}>{d}/{ts.length}</span></div>
                  <ul className="tasks">{ts.map((t) => {
                    const c = checks.find((x) => x.task_id === t.id);
                    return (<li key={t.id}><label className={c ? 'done' : ''}>
                      <input type="checkbox" checked={!!c} disabled={owner || !empId} onChange={(e) => tick(t, e.target.checked)} />
                      <span><span className="tt">{t.title}</span>{t.notes && <small>{t.notes}</small>}{c && <small>Done by {empOf(b, c.employee_id)?.name ?? '?'} at {clockTime(c.done_at)}</small>}</span></label></li>);
                  })}</ul>
                </div>);
            })}</div>
          </div>);
      })}
      {!all.length && <p className="empty-note">No tasks for {dayName(date)}.{owner ? ' Add them below.' : ''}</p>}
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
  const slotName = (t: Task) => { const s = slotById(b, t.slot_id); return s ? shiftShort(s.start_hour, s.hours) : 'Every shift'; };
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
