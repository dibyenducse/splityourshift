import { useState } from 'react';
import { supabase, errText } from '../lib/supabase';
import type { Bundle, Loc } from '../lib/types';
import { useToast } from './ui';

type PayMethod = 'actual' | 'grace' | 'schedule';
const METHOD: Record<PayMethod, { t: string; s: string }> = {
  actual: { t: 'Clocked time', s: 'Pay from clock-in to clock-out' },
  grace: { t: 'Shift hours + grace', s: 'Pay the scheduled shift; a few late minutes are still paid' },
  schedule: { t: 'By the schedule', s: 'Keep the clock for records; pay the assigned shifts' },
};

/** Time clock settings for each location, on the Time clock page (the same settings as in Payroll settings). */
export function ClockSettings({ b, onSaved }: { b: Bundle; onSaved: () => void }) {
  const [openId, setOpenId] = useState<string | null>(b.locs.length === 1 ? b.locs[0].id : null);
  return (
    <section className="panel clockset">
      <div className="panel-head"><h2>Time clock settings</h2></div>
      <p className="hint">Turn the clock on or off, set the grace period and how clocked hours are paid. The same settings are in Payroll settings; changing one changes both.</p>
      <div className="cks-list">{b.locs.map((l) => <LocClock key={`${l.id}-${l.time_clock}-${l.grace_minutes}-${l.pay_method}-${l.mutual_approval}`} loc={l} open={openId === l.id} onToggle={() => setOpenId(openId === l.id ? null : l.id)} onSaved={onSaved} />)}</div>
    </section>);
}

function LocClock({ loc, open, onToggle, onSaved }: { loc: Loc; open: boolean; onToggle: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ time_clock: loc.time_clock !== false, grace_minutes: Number(loc.grace_minutes ?? 10), pay_method: (loc.pay_method ?? 'actual') as PayMethod, mutual_approval: loc.mutual_approval ?? true });
  const [busy, setBusy] = useState(false);
  const dirty = f.time_clock !== (loc.time_clock !== false) || f.grace_minutes !== Number(loc.grace_minutes ?? 10) || f.pay_method !== (loc.pay_method ?? 'actual') || f.mutual_approval !== (loc.mutual_approval ?? true);
  const save = async () => {
    setBusy(true);
    const { error } = await supabase.from('locations').update({ ...f, pay_grace_minutes: f.pay_method === 'grace' ? f.grace_minutes : 0 }).eq('id', loc.id);
    setBusy(false);
    if (error) return toast(errText(error), 'error', 'Not saved');
    toast(f.time_clock ? `${loc.name}: clock on, ${f.grace_minutes}-minute grace, paid by ${METHOD[f.pay_method].t.toLowerCase()}.` : `${loc.name}: clock off. Payroll pays the scheduled shifts.`, 'ok', 'Saved'); onSaved();
  };
  const summary = !f.time_clock ? 'Off · pays scheduled hours' : `On · ${f.grace_minutes} min grace · ${METHOD[f.pay_method].t}`;
  return (
    <div className={`cks${open ? ' open' : ''}`}>
      <button type="button" className="cks-head" onClick={onToggle} aria-expanded={open}>
        <span className={`lamp${f.time_clock ? ' on' : ''}`} /><b>{loc.name}</b><span className={`tag ${f.time_clock ? 'ok' : 'warn'}`}>{summary}</span><span className="cks-chev" aria-hidden="true">›</span></button>
      {open && <div className="cks-body">
        <label className="switch"><input type="checkbox" role="switch" checked={f.time_clock} onChange={(e) => setF({ ...f, time_clock: e.target.checked })} /><span className="track" aria-hidden="true" />
          <span><b>Time clock {f.time_clock ? 'on' : 'off'}</b> at {loc.name}</span></label>
        {!f.time_clock ? <p className="hint" style={{ margin: 0 }}>Workers here see no time clock. Payroll pays each assigned shift and follows schedule changes; you can still edit anyone's hours. Nothing is deleted when you switch.</p> : <>
          <div className="cks-row"><span className="cks-l">Grace period</span>
            <div className="cks-pills">{[5, 10, 15, 30].map((m) => <button key={m} type="button" className={`cks-pill${f.grace_minutes === m ? ' on' : ''}`} onClick={() => setF({ ...f, grace_minutes: m })}>{m} min</button>)}
              <label className="cks-custom"><input type="number" min={0} max={120} value={f.grace_minutes} onChange={(e) => setF({ ...f, grace_minutes: Math.max(0, Math.min(120, +e.target.value || 0)) })} aria-label="Grace minutes" /> min</label></div></div>
          <p className="hint" style={{ margin: 0 }}>Clocking in up to {f.grace_minutes} minutes late gets no late notice.</p>
          <div className="cks-row"><span className="cks-l">How hours are paid</span>
            <div className="cks-methods">{(Object.keys(METHOD) as PayMethod[]).map((m) => <button key={m} type="button" className={`cks-method${f.pay_method === m ? ' on' : ''}`} aria-pressed={f.pay_method === m} onClick={() => setF({ ...f, pay_method: m })}><b>{METHOD[m].t}</b><small>{METHOD[m].s}</small></button>)}</div></div>
        </>}
        <label className="inline"><input type="checkbox" checked={f.mutual_approval} onChange={(e) => setF({ ...f, mutual_approval: e.target.checked })} /> When two workers agree on a swap, it's final (you're just told)</label>
        {dirty && <div className="actions" style={{ margin: 0 }}><button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : `Save ${loc.name}`}</button>
          <button className="btn" onClick={() => setF({ time_clock: loc.time_clock !== false, grace_minutes: Number(loc.grace_minutes ?? 10), pay_method: (loc.pay_method ?? 'actual') as PayMethod, mutual_approval: loc.mutual_approval ?? true })}>Undo</button></div>}
      </div>}
    </div>);
}
