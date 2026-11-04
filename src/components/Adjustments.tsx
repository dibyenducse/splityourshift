import { useCallback, useEffect, useState } from 'react';
import { supabase, errText } from '../lib/supabase';
import { addDays, ago, shiftLong, todayIso } from '../lib/time';
import { empOf } from '../lib/rules';
import type { Adjustment, Bundle } from '../lib/types';
import { ConfirmButton, useToast } from './ui';
import { shiftNameOf } from './Logbook';
import { PaybackPicker } from './Cover';

const STATUS: Record<Adjustment['status'], [string, string]> = {
  pending: ['Waiting for answer', 'warn'], awaiting_owner: ['Waiting for manager', 'warn'], accepted: ['Agreed', 'ok'],
  declined: ['Declined', 'bad'], recorded: ['Recorded', 'plain'], completed: ['Done', 'ok'], cancelled: ['Cancelled', 'plain'],
};

/** One line describing an agreement, e.g. "Ben comes 24 min early for Ann (late on Mon 11/2 · Microtel 3–11)". */
export function adjText(b: Bundle, a: Adjustment) {
  const f = empOf(b, a.from_emp)?.name ?? 'Someone', t = a.to_emp ? empOf(b, a.to_emp)?.name ?? 'someone' : null, on = a.label ? ` · ${a.label}` : '';
  switch (a.kind) {
    case 'takeover': return `${f} took over ${t ? `${t}'s` : 'an open'} shift for good${on}`;
    case 'swap': return a.slot_id ? `${f} covered ${t}'s shift; ${t} covers one of ${f}'s shifts later${on}` : `${t} covers one shift for ${f}${a.note ? ` (${a.note})` : ''}`;
    case 'extra': return `${f} worked an extra paid shift${t ? ` (${t}'s shift)` : ''}${on}`;
    case 'late_ignore': return `${f} was ${a.minutes} min late and ${t} stayed on: call it even${on}`;
    case 'late_swap': if (a.ret_date) return `${f} works ${a.minutes} min of ${t}'s time${on}${a.note ? ` (${a.note})` : ''}`;
      return a.slot_id ? `${f} comes ${a.minutes} min early for ${t} another day (was late${on})` : `${f} and ${t}: ${a.minutes}-minute swap${a.note ? ` (${a.note})` : ''}`;
    case 'payback': return `${f} pays back ${t} by working ${t}'s shift${on}`;
    case 'future_swap': return `${f} asked ${t} to work ${f}'s shift${on}${a.note ? ` (${a.note})` : ''}`;
    case 'late_payroll': return `${f} was ${a.minutes} min late; paid by normal payroll${t ? ` (${t} stayed on)` : ''}${on}`;
    default: return `${f} and ${t ?? ''}: adjustment${on}`;
  }
}

/**
 * Time swap: minutes one worker gives back to another on a chosen future date and shift (scheduled or not).
 * New request (from the clock) or, with `counter`, another time proposed for a request that is waiting for me.
 */
export function TimeSwapPicker({ b, empId, other, minutes, iOwe, entryId, counter, onDone, onCancel }: {
  b: Bundle; empId: string; other?: string | null; minutes: number; iOwe?: boolean; entryId?: string; counter?: Adjustment; onDone: () => void; onCancel: () => void;
}) {
  const toast = useToast();
  const me = empOf(b, empId);
  const locs = b.locs.filter((l) => me?.locs.includes(l.id)).length ? b.locs.filter((l) => me?.locs.includes(l.id)) : b.locs;
  const first = counter?.ret_slot ? b.slots.find((x) => x.id === counter.ret_slot) : undefined;
  const [f, setF] = useState({ other: other ?? '', minutes, date: counter?.ret_date ?? addDays(todayIso(), 1), loc: first?.location_id ?? locs[0]?.id ?? '', slot: counter?.ret_slot ?? '' });
  const [busy, setBusy] = useState(false);
  const mates = b.emps.filter((e) => e.id !== empId && e.locs.some((l) => locs.some((x) => x.id === l)));
  const slots = b.slots.filter((x) => x.location_id === f.loc).sort((x, y) => x.start_hour - y.start_hour);
  const who = empOf(b, counter ? (counter.from_emp === empId ? counter.to_emp : counter.from_emp) : f.other)?.name ?? 'your coworker';
  const go = async () => {
    if (!counter && !f.other) return toast('Pick the coworker.', 'error', 'Missing');
    if (!f.slot || !f.date) return toast('Pick the date and the shift.', 'error', 'Missing');
    if (!(f.minutes >= 1 && f.minutes <= 600)) return toast('Enter the minutes (1 to 600).', 'error', 'Missing');
    setBusy(true);
    const { error } = counter
      ? await supabase.rpc('counter_time_swap', { p_id: counter.id, p_slot: f.slot, p_date: f.date, p_minutes: f.minutes })
      : await supabase.rpc('request_time_swap', { p_other: f.other, p_minutes: f.minutes, p_slot: f.slot, p_date: f.date, p_i_owe: !!iOwe, p_entry: entryId ?? null });
    setBusy(false);
    if (error) return toast(errText(error), 'error', 'Not sent');
    toast(`Sent to ${who}. They can accept, decline or propose another time.`, 'ok', 'Time swap'); onDone();
  };
  return (
    <div className="swapform">
      <div className="twocol">
        {!counter && <div className="field"><label htmlFor="ts-who">{iOwe ? 'Who stayed for you' : 'Who came late'}</label>
          <select id="ts-who" value={f.other} onChange={(e) => setF({ ...f, other: e.target.value })}><option value="">Pick…</option>{mates.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></div>}
        <div className="field"><label htmlFor="ts-min">Minutes</label><input id="ts-min" type="number" min={1} max={600} value={f.minutes} onChange={(e) => setF({ ...f, minutes: +e.target.value || 0 })} /></div>
        <div className="field"><label htmlFor="ts-date">Date to give the time back</label><input id="ts-date" type="date" min={todayIso()} value={f.date} onChange={(e) => e.target.value && setF({ ...f, date: e.target.value })} />
          <span className="hint">Any future date, even if that week isn't scheduled yet.</span></div>
        {locs.length > 1 && <div className="field"><label htmlFor="ts-loc">Location</label>
          <select id="ts-loc" value={f.loc} onChange={(e) => setF({ ...f, loc: e.target.value, slot: '' })}>{locs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>}
        <div className="field"><label htmlFor="ts-slot">Shift</label>
          <select id="ts-slot" value={f.slot} onChange={(e) => setF({ ...f, slot: e.target.value })}><option value="">Pick…</option>
            {slots.map((x) => <option key={x.id} value={x.id}>{shiftNameOf(x)} · {shiftLong(x.start_hour, x.hours)}</option>)}</select></div>
      </div>
      <p className="hint">{iOwe || (counter && counter.from_emp === empId) ? `You work ${f.minutes || '…'} minutes of ${who}'s time on that shift.` : `${who} works ${f.minutes || '…'} minutes of your time on that shift.`} Your pay isn't changed by the swap; each of you is paid for the time you actually work.</p>
      <div className="actions"><button className="btn primary" disabled={busy} onClick={go}>{busy ? 'Sending…' : counter ? 'Propose this time' : 'Send time swap request'}</button>
        <button className="btn" onClick={onCancel}>Cancel</button></div>
    </div>);
}

/**
 * Shift swaps, takeovers and late-arrival agreements. Workers answer requests for them and see their history;
 * the owner sees everything, approves when mutual approval is off, and can propose a swap.
 */
export function AdjustmentsPanel({ b, empId, owner }: { b: Bundle; empId?: string; owner?: boolean }) {
  const toast = useToast();
  const [rows, setRows] = useState<Adjustment[]>([]);
  const [busy, setBusy] = useState('');
  const [prop, setProp] = useState({ from: '', to: '', kind: 'future_swap', minutes: 30, note: '', loc: b.locs[0]?.id ?? '', slot: '', date: addDays(todayIso(), 1) });
  const [ask, setAsk] = useState(false);
  const [acc, setAcc] = useState<Adjustment | null>(null);
  const [payFor, setPayFor] = useState<string | null>(null);
  const [ctr, setCtr] = useState<Adjustment | null>(null);
  const owe = owner ? [] : b.ledger.filter((l) => l.status === 'open' && l.debtor_id === empId && !rows.some((a) => a.kind === 'payback' && a.status === 'pending' && (a as { ledger_id?: string }).ledger_id === l.id));
  const load = useCallback(async () => {
    const { data } = await supabase.from('shift_adjustments').select('*').eq('org_id', b.org.id).order('created_at', { ascending: false }).limit(150);
    setRows((data ?? []) as Adjustment[]);
  }, [b.org.id]);
  useEffect(() => {
    load();
    const ch = supabase.channel(`adj-${b.org.id}-${empId ?? 'owner'}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'shift_adjustments', filter: `org_id=eq.${b.org.id}` }, () => load()).subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [b.org.id, empId, load]);

  const act = async (id: string, fn: () => PromiseLike<{ error: unknown }>, ok: string) => {
    setBusy(id);
    const { error } = await fn();
    setBusy('');
    if (error) toast(errText(error), 'error', "Didn't work"); else { toast(ok, 'ok', 'Done'); load(); }
  };
  const respond = (a: Adjustment, yes: boolean) => act(a.id, () => supabase.rpc('respond_adjustment', { p_id: a.id, p_accept: yes }), yes ? 'Accepted. Everyone involved was told.' : 'Declined.');
  const update = (a: Adjustment, action: string, ok: string) => act(a.id, () => supabase.rpc('update_adjustment', { p_id: a.id, p_action: action }), ok);
  const propose = () => {
    const from = owner ? prop.from : empId!;
    if (!from || !prop.to || from === prop.to) return toast(owner ? 'Pick two different workers.' : 'Pick the coworker to ask.', 'error', 'Missing');
    if (prop.kind === 'future_swap' && (!prop.slot || !prop.date)) return toast('Pick the date and the shift.', 'error', 'Missing');
    act('new', () => prop.kind === 'future_swap'
      ? supabase.rpc('request_future_swap', { p_to: prop.to, p_slot: prop.slot, p_date: prop.date, p_note: prop.note, p_from: owner ? from : null })
      : supabase.rpc('propose_adjustment', { p_from: from, p_to: prop.to, p_kind: prop.kind, p_minutes: prop.minutes, p_note: prop.note }),
      `Sent to ${empOf(b, prop.to)?.name}. When they accept, they're on that shift.`);
    setProp({ ...prop, note: '' }); setAsk(false);
  };
  // The owner's shift slots at the chosen location, named Morning / Evening / Night.
  const slotsAt = b.slots.filter((x) => x.location_id === prop.loc).sort((x, y) => x.start_hour - y.start_hour);
  const myLocs = owner ? b.locs : b.locs.filter((l) => empOf(b, empId)?.locs.includes(l.id)).length ? b.locs.filter((l) => empOf(b, empId)?.locs.includes(l.id)) : b.locs;
  const swapForm = (
    <div className="swapform">
      <div className="twocol">
        {owner && <div className="field"><label htmlFor="pp-from">Worker who can't work it</label>
          <select id="pp-from" value={prop.from} onChange={(e) => setProp({ ...prop, from: e.target.value })}><option value="">Pick…</option>{b.emps.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></div>}
        <div className="field"><label htmlFor="pp-to">{owner ? 'Worker who is asked' : 'Ask this coworker'}</label>
          <select id="pp-to" value={prop.to} onChange={(e) => setProp({ ...prop, to: e.target.value })}><option value="">Pick…</option>{b.emps.filter((e) => e.id !== (owner ? prop.from : empId)).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></div>
        {owner && <div className="field"><label htmlFor="pp-kind">What</label>
          <select id="pp-kind" value={prop.kind} onChange={(e) => setProp({ ...prop, kind: e.target.value })}>
            <option value="future_swap">Work a specific shift (date and shift)</option><option value="swap">Cover one shift later (goes to Shifts owed)</option><option value="late_swap">A swap of minutes</option></select></div>}
        {prop.kind === 'future_swap' && <>
          <div className="field"><label htmlFor="pp-date">Date</label><input id="pp-date" type="date" min={todayIso()} value={prop.date} onChange={(e) => e.target.value && setProp({ ...prop, date: e.target.value })} />
            <span className="hint">Any future date, even if that week isn't scheduled yet.</span></div>
          {myLocs.length > 1 && <div className="field"><label htmlFor="pp-loc">Location</label>
            <select id="pp-loc" value={prop.loc} onChange={(e) => setProp({ ...prop, loc: e.target.value, slot: '' })}>{myLocs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>}
          <div className="field"><label htmlFor="pp-slot">Shift</label>
            <select id="pp-slot" value={prop.slot} onChange={(e) => setProp({ ...prop, slot: e.target.value })}><option value="">Pick…</option>
              {slotsAt.map((x) => <option key={x.id} value={x.id}>{shiftNameOf(x)} · {shiftLong(x.start_hour, x.hours)}</option>)}</select></div>
        </>}
        {prop.kind === 'late_swap' && <div className="field"><label htmlFor="pp-min">Minutes</label><input id="pp-min" type="number" min={1} max={600} value={prop.minutes} onChange={(e) => setProp({ ...prop, minutes: +e.target.value || 1 })} /></div>}
        <div className="field" style={{ gridColumn: '1 / -1' }}><label htmlFor="pp-note">Note (optional)</label><input id="pp-note" type="text" value={prop.note} onChange={(e) => setProp({ ...prop, note: e.target.value })} placeholder="e.g. doctor's appointment" /></div>
      </div>
      <div className="actions"><button className="btn primary" disabled={busy === 'new'} onClick={propose}>Send swap request</button>
        {!owner && <button className="btn" onClick={() => setAsk(false)}>Cancel</button>}</div>
    </div>);

  const forMe = rows.filter((a) => owner ? a.status === 'awaiting_owner' : a.status === 'pending' && (a.turn ?? a.to_emp) === empId);
  const mineWaiting = owner ? rows.filter((a) => a.status === 'pending') : rows.filter((a) => a.status === 'pending' && !forMe.includes(a) && (a.from_emp === empId || a.to_emp === empId));
  const upcoming = rows.filter((a) => a.kind === 'future_swap' && a.status === 'accepted' && (a.work_date ?? '') >= todayIso() && (owner || a.from_emp === empId || a.to_emp === empId));
  const todo = rows.filter((a) => a.status === 'accepted' && a.kind === 'late_swap' && (owner || a.from_emp === empId || a.to_emp === empId));
  const history = rows.filter((a) => !forMe.includes(a) && !mineWaiting.includes(a) && !todo.includes(a) && !upcoming.includes(a)).slice(0, 25);
  const tag = (a: Adjustment) => a.kind === 'future_swap' && a.status === 'accepted' && (a.work_date ?? '') < todayIso() ? <span className="tag ok">Done</span>
    : <span className={`tag ${STATUS[a.status][1]}`}>{a.kind === 'future_swap' && a.status === 'accepted' ? 'Accepted · on the schedule' : STATUS[a.status][0]}</span>;
  const item = (a: Adjustment, buttons?: React.ReactNode) => (
    <div key={a.id} className="item adj"><div>{adjText(b, a)}</div><small>{ago(a.created_at)} · {tag(a)}</small>{buttons && <div className="actions">{buttons}</div>}</div>);

  return (
    <section className="panel" id="swaps">
      <div className="panel-head"><h2>{owner ? 'Swaps and shift adjustments' : 'Swaps and agreements'}</h2>{forMe.length > 0 && <span className="badge">{forMe.length}</span>}</div>
      <p className="hint">{owner ? 'Takeovers, swaps, extra shifts and late arrivals that workers set up from the time clock. ' + (b.locs.some((l) => (l as { mutual_approval?: boolean }).mutual_approval === false) ? 'Where mutual approval is off, accepted swaps wait for you.' : 'When both workers agree it is final; you are told.')
        : 'Requests from coworkers, and what you agreed to. Your manager is told about each one.'}</p>
      {forMe.length > 0 && <><h4>{owner ? 'Waiting for your approval' : 'Waiting for your answer'}</h4><div className="stack">{forMe.map((a) => item(a, owner ? <>
        <button className="btn small primary" disabled={busy === a.id} onClick={() => update(a, 'approve', 'Approved.')}>Approve</button>
        <button className="btn small" disabled={busy === a.id} onClick={() => update(a, 'decline', 'Declined.')}>Decline</button></> : <>
        {a.kind === 'future_swap'
          ? (acc?.id === a.id ? <AcceptSwap b={b} a={a} busy={busy === a.id} onCancel={() => setAcc(null)}
              onGo={(mode, slot, date) => act(a.id, () => supabase.rpc('accept_future_swap', { p_id: a.id, p_mode: mode, p_ret_slot: slot, p_ret_date: date }),
                mode === 'cover' ? 'Accepted. The shift is yours; nothing is owed.' : slot ? 'Accepted. You swapped shifts; both are on the schedule.' : 'Accepted. They owe you a shift; it is on Shifts owed.').then(() => setAcc(null))} />
            : <button className="btn small primary" disabled={busy === a.id} onClick={() => setAcc(a)}>Accept…</button>)
          : a.kind === 'late_swap' && a.ret_date && ctr?.id === a.id ? <TimeSwapPicker b={b} empId={empId!} minutes={a.minutes ?? 15} counter={a} onDone={() => { setCtr(null); load(); }} onCancel={() => setCtr(null)} />
          : <button className="btn small primary" disabled={busy === a.id} onClick={() => respond(a, true)}>{a.kind === 'late_ignore' ? 'Approve' : 'Accept'}</button>}
        {ctr?.id !== a.id && <button className="btn small" disabled={busy === a.id} onClick={() => respond(a, false)}>Decline</button>}
        {a.kind === 'late_swap' && a.ret_date && ctr?.id !== a.id && <button className="btn small" disabled={busy === a.id} onClick={() => setCtr(a)}>Propose another time</button>}</>))}</div></>}
      {mineWaiting.length > 0 && <><h4>{owner ? 'Waiting for a worker to answer' : 'Your requests'}</h4><div className="stack">{mineWaiting.map((a) => item(a,
        <ConfirmButton className="btn small" label="Cancel request" confirmLabel="Tap again to cancel" onConfirm={() => update(a, 'cancel', 'Request cancelled.')} />))}</div></>}
      {!owner && owe.length > 0 && <><h4>Shifts you owe</h4><div className="stack">{owe.map((l) => (
        <div key={l.id} className="item"><div>You owe <b>{empOf(b, l.creditor_id)?.name ?? '?'}</b> a shift</div><small>{empOf(b, l.creditor_id)?.name} covered {l.label}</small>
          {payFor === l.id ? <PaybackPicker b={b} ledgerId={l.id} onDone={() => { setPayFor(null); load(); }} />
            : <div className="actions"><button className="btn small primary" onClick={() => setPayFor(l.id)}>Pay back: pick a date and shift</button></div>}</div>))}</div></>}
      {!owner && (ask ? <div className="option"><h4>Can't work a shift? Ask a coworker</h4>{swapForm}</div>
        : <div className="actions"><button className="btn primary" onClick={() => setAsk(true)}>⇄ Ask a coworker to work one of my shifts</button></div>)}
      {upcoming.length > 0 && <><h4>Accepted swaps coming up</h4><div className="stack">{upcoming.map((a) => item(a, owner ?
        <ConfirmButton className="btn small" label="Cancel swap" confirmLabel="Tap again to cancel" onConfirm={() => update(a, 'cancel', 'Swap cancelled. Set the schedule as you need.')} /> : undefined))}</div></>}
      {todo.length > 0 && <><h4>Agreed, not done yet</h4><div className="stack">{todo.map((a) => item(a,
        <button className="btn small" disabled={busy === a.id} onClick={() => update(a, 'complete', 'Marked done.')}>Mark done</button>))}</div></>}
      {history.length > 0 && <details className="adj-history"><summary>History ({history.length})</summary><div className="stack">{history.map((a) => item(a))}</div></details>}
      {owner && <details className="adj-history" open><summary>New swap request (any date and shift)</summary>{swapForm}</details>}
      {owner && !rows.length && <p className="empty-note">Nothing yet. When a worker clocks in late, covers someone or picks up an extra shift, it shows up here.</p>}
    </section>
  );
}

/** Accepting a coworker's swap request: just cover it, or swap (they work one of my shifts: pick now or later). */
function AcceptSwap({ b, a, busy, onGo, onCancel }: { b: Bundle; a: Adjustment; busy: boolean; onGo: (mode: 'cover' | 'swap', slot: string | null, date: string | null) => void; onCancel: () => void }) {
  const who = empOf(b, a.from_emp)?.name ?? 'They';
  const [mode, setMode] = useState<'cover' | 'swap'>('cover');
  const [later, setLater] = useState(true);
  const [loc, setLoc] = useState(b.slots.find((x) => x.id === a.slot_id)?.location_id ?? b.locs[0]?.id ?? '');
  const [slot, setSlot] = useState('');
  const [date, setDate] = useState(addDays(todayIso(), 7));
  const slots = b.slots.filter((x) => x.location_id === loc).sort((x, y) => x.start_hour - y.start_hour);
  return (
    <div className="accept-swap">
      <label className="inline"><input type="radio" name={`m-${a.id}`} checked={mode === 'cover'} onChange={() => setMode('cover')} /> Just cover it: {who} owes me nothing</label>
      <label className="inline"><input type="radio" name={`m-${a.id}`} checked={mode === 'swap'} onChange={() => setMode('swap')} /> Swap: {who} works one of my shifts in return</label>
      {mode === 'swap' && <div className="accept-ret">
        <label className="inline"><input type="radio" name={`r-${a.id}`} checked={!later} onChange={() => setLater(false)} /> Pick the date now</label>
        {!later && <div className="twocol">
          <div className="field"><label>Date</label><input type="date" min={todayIso()} value={date} onChange={(e) => e.target.value && setDate(e.target.value)} aria-label="Return shift date" /></div>
          {b.locs.length > 1 && <div className="field"><label>Location</label><select value={loc} onChange={(e) => { setLoc(e.target.value); setSlot(''); }} aria-label="Return shift location">{b.locs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>}
          <div className="field"><label>Shift</label><select value={slot} onChange={(e) => setSlot(e.target.value)} aria-label="Return shift"><option value="">Pick…</option>
            {slots.map((x) => <option key={x.id} value={x.id}>{shiftNameOf(x)} · {shiftLong(x.start_hour, x.hours)}</option>)}</select></div>
        </div>}
        <label className="inline"><input type="radio" name={`r-${a.id}`} checked={later} onChange={() => setLater(true)} /> Decide later (kept on Shifts owed)</label>
      </div>}
      <div className="actions">
        <button className="btn small primary" disabled={busy || (mode === 'swap' && !later && !slot)} onClick={() => onGo(mode, mode === 'swap' && !later ? slot : null, mode === 'swap' && !later ? date : null)}>Accept</button>
        <button className="btn small" onClick={onCancel}>Back</button></div>
    </div>
  );
}
