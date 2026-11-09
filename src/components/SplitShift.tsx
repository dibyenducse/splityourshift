import { useState } from 'react';
import { supabase, errText } from '../lib/supabase';
import { shiftLong } from '../lib/time';
import { cellKey, countWeek, empOf, parseCell, partsOf, slotById, slotOf } from '../lib/rules';
import type { Bundle } from '../lib/types';
import { useToast } from './ui';
import { HowToButton } from './HowTo';

const hourText = (h: number) => { const x = h % 24; return `${x % 12 || 12} ${x < 12 ? 'am' : 'pm'}`; };

/**
 * Split one day of a shift into parts with their own times and people (e.g. 9–2 for Ann, 2–9 for Ben).
 * Only this day changes; the regular shift pattern stays. Cuts are on the hour, before midnight.
 */
export function SplitShift({ b, k, week, onDone }: { b: Bundle; k: string; week: string; onDone: () => void }) {
  const toast = useToast();
  const s = slotOf(b, k)!, { slot, date } = parseCell(k);
  const start = s.start_hour, end = s.start_hour + s.hours, lastCut = Math.min(end, 24) - 1;
  const choices = Array.from({ length: Math.max(0, lastCut - start) }, (_, i) => start + 1 + i);
  const [open, setOpen] = useState(false);
  const [cuts, setCuts] = useState<number[]>(() => [Math.min(lastCut, start + Math.max(1, Math.round(s.hours / 2)))]);
  const sorted = [...new Set(cuts)].sort((x, y) => x - y);
  const bounds = [start, ...sorted, end];
  const [emps, setEmps] = useState<string[]>(() => [b.assign[k] ?? '', '']);
  const [busy, setBusy] = useState(false);
  if (!choices.length) return null;
  const parts = bounds.slice(0, -1).map((a, i) => ({ a, z: bounds[i + 1], emp: emps[i] ?? '' }));
  const setEmp = (i: number, v: string) => { const n = [...emps]; while (n.length < parts.length) n.push(''); n[i] = v; setEmps(n); };
  const addCut = () => { const free = choices.find((c) => !sorted.includes(c) && c > (sorted[sorted.length - 1] ?? start)); if (free) { setCuts([...sorted, free]); setEmps([...emps.slice(0, parts.length), '']); } };
  const go = async () => {
    setBusy(true);
    const { error } = await supabase.rpc('split_shift', { p_slot: slot, p_date: date, p_cuts: sorted, p_emps: parts.map((p) => p.emp || null) });
    setBusy(false);
    if (error) return toast(errText(error), 'error', "Couldn't split");
    toast(`Split into ${parts.length} parts for this day: ${parts.map((p) => `${hourText(p.a)}–${hourText(p.z)} ${empOf(b, p.emp)?.name ?? 'open'}`).join(', ')}.`, 'ok', 'Shift split'); onDone();
  };
  if (!open) return (
    <div className="sec"><h4 className="split-h">Different hours this day? <HowToButton topic="split" /></h4><p>Split this shift for {new Date(date + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long' })} only, e.g. one person until 2 pm and another after. Your regular shifts stay the same.</p>
      <div className="actions"><button className="btn" onClick={() => setOpen(true)}>✂ Split this shift</button></div></div>);
  const span = end - start;
  return (
    <div className="sec split-form"><h4>✂ Split {shiftLong(s.start_hour, s.hours)} for this day</h4>
      <div className="split-bar" aria-hidden="true">{parts.map((p, i) => <span key={i} style={{ flex: p.z - p.a, ['--h' as string]: empOf(b, p.emp)?.hue ?? 210 }} className={p.emp ? 'on' : ''}>{hourText(p.a)}</span>)}</div>
      <div className="split-cuts">{sorted.map((c, i) => (
        <label key={i} className="split-cut">Split at
          <select value={c} onChange={(e) => { const n = [...sorted]; n[i] = +e.target.value; setCuts(n); }} aria-label={`Cut ${i + 1}`}>
            {choices.map((h) => <option key={h} value={h}>{hourText(h)}</option>)}</select>
          {sorted.length > 1 && <button type="button" className="btn icon" aria-label="Remove this cut" onClick={() => { setCuts(sorted.filter((_, j) => j !== i)); setEmps(emps.filter((_, j) => j !== i + 1)); }}>×</button>}
        </label>))}
        {sorted.length < 3 && sorted.length < choices.length && <button type="button" className="btn small" onClick={addCut}>+ Another cut</button>}
      </div>
      <div className="split-parts">{parts.map((p, i) => (
        <div key={i} className="split-part"><span className="when"><b>{hourText(p.a)} – {hourText(p.z)}</b><small>{p.z - p.a} hour{p.z - p.a === 1 ? '' : 's'}</small></span>
          <select value={p.emp} onChange={(e) => setEmp(i, e.target.value)} aria-label={`Who works ${hourText(p.a)} to ${hourText(p.z)}`}>
            <option value="">Open (nobody yet)</option>
            {b.emps.map((e) => <option key={e.id} value={e.id}>{e.name} · {countWeek(b, e.id, week)}/{e.max_shifts} this week</option>)}</select></div>))}</div>
      <p className="hint" style={{ margin: 0 }}>{span}-hour shift → {parts.map((p) => `${p.z - p.a}h`).join(' + ')}. Each part works like its own shift: clock in and out, swaps and payroll.</p>
      <div className="actions"><button className="btn primary" disabled={busy} onClick={go}>{busy ? 'Splitting…' : `Split into ${parts.length} parts`}</button>
        <button className="btn" onClick={() => setOpen(false)}>Cancel</button></div>
    </div>);
}

/** For a part of a split shift: what it belongs to, the other parts, and joining the day back into one shift. */
export function PartInfo({ b, k, onDone, onOpen }: { b: Bundle; k: string; onDone: () => void; onOpen: (k: string) => void }) {
  const toast = useToast();
  const p = slotOf(b, k)!, parent = slotById(b, p.parent_slot), date = p.only_date!;
  const all = parent ? partsOf(b, parent.id, date) : [];
  const [busy, setBusy] = useState(false);
  const join = async () => {
    setBusy(true);
    const { error } = await supabase.rpc('join_shift', { p_slot: p.parent_slot, p_date: date });
    setBusy(false);
    if (error) return toast(errText(error), 'error', "Couldn't join");
    toast('Back to one shift for this day. Whoever had the first part keeps it.', 'ok', 'Joined'); onDone();
  };
  return (
    <div className="sec split-form"><h4>✂ Part of a split shift</h4>
      <p>{parent ? <>The {shiftLong(parent.start_hour, parent.hours)} shift is split into {all.length} parts this day:</> : 'This shift is split this day.'}</p>
      <div className="split-parts">{all.map((x) => { const xk = cellKey(x.id, date), w = empOf(b, b.assign[xk]); return (
        <button key={x.id} className={`split-part link${xk === k ? ' me' : ''}`} onClick={() => xk !== k && onOpen(xk)}>
          <span className="when"><b>{hourText(x.start_hour)} – {hourText(x.start_hour + x.hours)}</b><small>{x.hours}h</small></span>
          <span>{w ? w.name : <span className="tag bad">Open</span>}</span></button>); })}</div>
      <div className="actions"><button className="btn" disabled={busy} onClick={join}>{busy ? 'Joining…' : 'Join back into one shift'}</button></div>
    </div>);
}
