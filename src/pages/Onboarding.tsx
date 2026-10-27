import { useState } from 'react';
import { useAuth } from '../App';
import { supabase, errText } from '../lib/supabase';
import { sendInvite } from '../lib/api';
import { mondayOf, todayIso } from '../lib/time';
import { HUES, PRESETS, type Row } from '../lib/rules';
import type { Emp, LocType } from '../lib/types';
import { useToast } from '../components/ui';
import { ShiftEditor } from '../components/ShiftEditor';
import { SiteNav } from './Home';

/** New owner: business type → shifts → workers. Existing owner ("add"): same steps for another location. */
export default function Onboarding({ mode, orgId, existing = [], onDone, onCancel }: {
  mode: 'new' | 'add'; orgId?: string; existing?: Emp[]; onDone?: () => void; onCancel?: () => void;
}) {
  const { me, refresh, signOut } = useAuth();
  const toast = useToast();
  const [step, setStep] = useState(1);
  const [type, setType] = useState<LocType | null>(null);
  const [preset, setPreset] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [locName, setLocName] = useState('');
  const [names, setNames] = useState('');
  const [max, setMax] = useState(5);
  const [rate, setRate] = useState(15);
  const [also, setAlso] = useState<string[]>([]);
  const [invite, setInvite] = useState(true);
  const [busy, setBusy] = useState(false);

  const pickType = (t: LocType) => {
    setType(t);
    const p = PRESETS[t].find((x) => x.rec)!;
    setPreset(p.id); setRows(p.rows!.map(([start_hour, hours]) => ({ start_hour, hours })));
    if (!locName || /^My (Hotel|Gas Station)$/.test(locName)) setLocName(t === 'hotel' ? 'My Hotel' : 'My Gas Station');
  };

  const finish = async () => {
    if (!me || !type) return;
    setBusy(true);
    try {
      let org = orgId;
      if (mode === 'new') {
        const { data: { user } } = await supabase.auth.getUser();
        const meta = user?.user_metadata ?? {};
        const { data, error } = await supabase.from('organizations').insert({
          owner_id: me.userId, name: meta.business || 'My business', owner_name: meta.name || null, pay_anchor: mondayOf(todayIso()),
          time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago',
        }).select('id').single();
        if (error) throw error;
        org = data.id;
      }
      const { data: loc, error: e1 } = await supabase.from('locations').insert({ org_id: org, name: locName.trim() || (type === 'hotel' ? 'My Hotel' : 'My Gas Station'), type }).select('id').single();
      if (e1) throw e1;
      const { error: e2 } = await supabase.from('shift_slots').insert(rows.map((r, i) => ({ org_id: org, location_id: loc.id, start_hour: r.start_hour, hours: r.hours, sort: i })));
      if (e2) throw e2;
      if (also.length) await supabase.from('employee_locations').insert(also.map((employee_id) => ({ employee_id, location_id: loc.id })));
      const lines = names.split('\n').map((s) => s.trim()).filter(Boolean);
      if (lines.length) {
        const people = lines.map((line, i) => {
          const [name, contact = ''] = line.split(',').map((x) => x.trim());
          const isEmail = /@/.test(contact);
          return { org_id: org, name: name || 'Worker', email: isEmail ? contact : null, phone: !isEmail && contact ? contact : null, max_shifts: max, rate, hue: HUES[(existing.length + i) % HUES.length] };
        });
        const { data: made, error: e3 } = await supabase.from('employees').insert(people).select('id, email');
        if (e3) throw e3;
        await supabase.from('employee_locations').insert(made.map((m) => ({ employee_id: m.id, location_id: loc.id })));
        if (invite) {
          let sent = 0;
          for (const m of made.filter((x) => x.email)) { try { await sendInvite(m.id); sent++; } catch { /* shown in staff list as Not invited */ } }
          if (sent) toast(`Sent ${sent} login invite${sent > 1 ? 's' : ''} by email.`, 'ok', 'Invites sent');
        }
      }
      toast('Your schedule is ready. Drag names from the staff list into the shifts.', 'ok', 'All set');
      if (mode === 'new') await refresh(); else onDone?.();
    } catch (e) {
      toast(errText(e), 'error', "Couldn't save");
    } finally { setBusy(false); }
  };

  const total = 3;
  const bar = <div className="steps">{Array.from({ length: total }, (_, i) => <span key={i} className={i < step ? 'done' : ''} />)}</div>;
  const back = step > 1 ? <button className="btn" onClick={() => setStep(step - 1)}>Back</button>
    : mode === 'add' ? <button className="btn" onClick={onCancel}>Cancel</button> : <button className="btn" onClick={signOut}>Log out</button>;

  let body;
  if (step === 1) body = (<>
    <h2>What do you run?</h2><p className="lead">We'll suggest the usual shift pattern. You can change everything later.</p>
    <div className="choices">
      <button className="choice" aria-pressed={type === 'hotel'} onClick={() => pickType('hotel')}><b>Hotel or motel</b><span>Front desk, night audit, housekeeping.</span></button>
      <button className="choice" aria-pressed={type === 'gas'} onClick={() => pickType('gas')}><b>Gas station</b><span>Cashiers, often open 24 hours.</span></button>
    </div>
    <div className="wiz-foot">{back}<button className="btn primary" disabled={!type} onClick={() => setStep(2)}>Continue</button></div>
  </>);
  else if (step === 2 && type) body = (<>
    <h2>Set up your shifts</h2><p className="lead">Pick a pattern for this {type === 'hotel' ? 'hotel' : 'gas station'}. Each shift becomes one row on your weekly schedule.</p>
    <div className="field"><label htmlFor="wz-loc">{type === 'hotel' ? 'Hotel' : 'Gas station'} name</label><input type="text" id="wz-loc" value={locName} onChange={(e) => setLocName(e.target.value)} /></div>
    <div className="choices">{PRESETS[type].map((p) => (
      <button key={p.id} className="choice" aria-pressed={preset === p.id} onClick={() => { setPreset(p.id); if (p.rows) setRows(p.rows.map(([start_hour, hours]) => ({ start_hour, hours }))); }}>
        <b>{p.name}</b><span>{p.sub}</span>{p.rec && <span className="tag ok">Suggested</span>}</button>))}</div>
    <div className="sec"><h4>Your shifts</h4><p>Change any start time or length. The bar shows the 24 hours of a day.</p>
      <ShiftEditor idPrefix="wz" rows={rows} onChange={(r) => { setRows(r); setPreset('custom'); }} /></div>
    <div className="wiz-foot">{back}<button className="btn primary" disabled={!rows.length} onClick={() => setStep(3)}>Continue</button></div>
  </>);
  else body = (<>
    <h2>Add your workers</h2><p className="lead">One worker per line: name, then email or phone. Workers with an email get an invite to set their password. They don't sign up themselves.</p>
    {existing.length > 0 && <fieldset className="field"><legend>Workers you already have who also work at {locName}</legend><div className="checks">
      {existing.map((w) => <label key={w.id}><input type="checkbox" checked={also.includes(w.id)} onChange={(e) => setAlso(e.target.checked ? [...also, w.id] : also.filter((x) => x !== w.id))} /> {w.name}</label>)}</div></fieldset>}
    <div className="field"><label htmlFor="wz-names">New workers</label><textarea id="wz-names" value={names} onChange={(e) => setNames(e.target.value)} placeholder={'Maria, maria@email.com\nJuan, juan@email.com\nPriya, (555) 201-3344'} /></div>
    <div className="twocol">
      <div className="field"><label htmlFor="wz-max">Max shifts per week (each)</label><input type="number" id="wz-max" min={1} max={21} value={max} onChange={(e) => setMax(Math.max(1, Math.min(21, +e.target.value || 5)))} /></div>
      <div className="field"><label htmlFor="wz-rate">Hourly rate ($, each)</label><input type="number" id="wz-rate" min={0} step={0.25} value={rate} onChange={(e) => setRate(Math.max(0, +e.target.value || 0))} /></div>
    </div>
    <label className="checks"><span style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={invite} onChange={(e) => setInvite(e.target.checked)} /> Email login invites now</span></label>
    <p className="hint" style={{ margin: 0 }}>You can change limits, rates and invites per person later.</p>
    <div className="wiz-foot">{back}<button className="btn primary" disabled={busy} onClick={finish}>{busy ? 'Saving…' : mode === 'new' ? 'Create my schedule' : 'Add location'}</button></div>
  </>);

  const card = <div className="layout"><div className="wizard">{bar}{body}</div></div>;
  return mode === 'new' ? <><SiteNav /><div className="wrap">{card}</div></> : card;
}
