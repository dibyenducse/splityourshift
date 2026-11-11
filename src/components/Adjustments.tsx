import { useCallback, useEffect, useState } from 'react';
import { supabase, errText } from '../lib/supabase';
import { addDays, ago, shiftLong, todayIso } from '../lib/time';
import { availFor, cellKey, empOf, keysOf, parseCell, slotOf, slotById } from '../lib/rules';
import type { Adjustment, Bundle } from '../lib/types';
import { ConfirmButton, Sheet, useToast } from './ui';
import { shiftNameOf } from './Logbook';
import { PaybackPicker } from './Cover';
import { HowToButton } from './HowTo';

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
  const first = counter?.ret_slot ? slotById(b, counter.ret_slot) : undefined;
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
      <div className="panel-head"><h2>{owner ? 'Swaps and shift adjustments' : 'Swaps and agreements'}{forMe.length > 0 && <span className="badge">{forMe.length}</span>}</h2><HowToButton topic={owner ? 'swapowner' : 'swap'} /></div>
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
      <div className="option swapbox" id="swap-new"><h4>{owner ? '⇄ New swap: ask a worker to take a shift' : "⇄ Can't work a shift? Ask a coworker"}</h4><SwapRequest b={b} empId={empId} owner={owner} pending={rows} onSent={load} /></div>
      {upcoming.length > 0 && <><h4>Accepted swaps coming up</h4><div className="stack">{upcoming.map((a) => item(a, owner ?
        <ConfirmButton className="btn small" label="Cancel swap" confirmLabel="Tap again to cancel" onConfirm={() => update(a, 'cancel', 'Swap cancelled. Set the schedule as you need.')} /> : undefined))}</div></>}
      {todo.length > 0 && <><h4>Agreed, not done yet</h4><div className="stack">{todo.map((a) => item(a,
        <button className="btn small" disabled={busy === a.id} onClick={() => update(a, 'complete', 'Marked done.')}>Mark done</button>))}</div></>}
      {history.length > 0 && <details className="adj-history"><summary>History ({history.length})</summary><div className="stack">{history.map((a) => item(a))}</div></details>}
      {owner && !rows.length && <p className="empty-note">Nothing yet. When a worker clocks in late, covers someone or picks up an extra shift, it shows up here.</p>}
    </section>
  );
}

/** Accepting a coworker's swap request: just cover it, or swap (they work one of my shifts: pick now or later). */
function AcceptSwap({ b, a, busy, onGo, onCancel }: { b: Bundle; a: Adjustment; busy: boolean; onGo: (mode: 'cover' | 'swap', slot: string | null, date: string | null) => void; onCancel: () => void }) {
  const who = empOf(b, a.from_emp)?.name ?? 'They';
  const [mode, setMode] = useState<'cover' | 'swap'>('cover');
  const [later, setLater] = useState(true);
  const [loc, setLoc] = useState(slotById(b, a.slot_id)?.location_id ?? b.locs[0]?.id ?? '');
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

/**
 * Swap request in a few taps, always open. Worker: 1) one of my upcoming shifts (or any date and shift),
 * 2) a coworker (free / working that day / unavailable is shown), 3) the summary and Send.
 * Owner: the same, with a first step for whose shift it is.
 */
function SwapRequest({ b, empId, owner, pending, onSent, initialCell }: { b: Bundle; empId?: string; owner?: boolean; pending: Adjustment[]; onSent: () => void; initialCell?: string }) {
  const toast = useToast();
  const today = todayIso();
  const [from, setFrom] = useState(owner ? '' : empId ?? '');
  const me = empOf(b, from);
  const myLocs = me && b.locs.filter((l) => me.locs.includes(l.id)).length ? b.locs.filter((l) => me.locs.includes(l.id)) : b.locs;
  const mine = from ? keysOf(b, from).filter((k) => parseCell(k).date >= today).sort((x, y) => parseCell(x).date.localeCompare(parseCell(y).date) || (slotOf(b, x)!.start_hour - slotOf(b, y)!.start_hour)).slice(0, 12) : [];
  const [cell, setCell] = useState<string | null>(initialCell ?? null);
  const [other, setOther] = useState(false);
  const [o, setO] = useState({ date: addDays(today, 7), loc: myLocs[0]?.id ?? '', slot: '' });
  const [to, setTo] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [q1, setQ1] = useState(''); const [q2, setQ2] = useState('');
  const hit = (name: string, q: string) => !q.trim() || name.toLowerCase().includes(q.trim().toLowerCase());
  const search = (n: number, q: string, set: (v: string) => void, id: string) => n > 8 && <input id={id} className="sr-search" type="search" value={q} onChange={(e) => set(e.target.value)} placeholder={`Search ${n} workers…`} aria-label="Search workers" />;
  const reset = (keepFrom = true) => { if (!keepFrom) setFrom(owner ? '' : empId ?? ''); setCell(null); setOther(false); setTo(''); setNote(''); };
  const k = from ? (other ? (o.slot && o.date ? cellKey(o.slot, o.date) : null) : cell) : null;
  const asked = (key: string) => pending.some((a) => a.kind === 'future_swap' && a.status === 'pending' && a.from_emp === from && a.slot_id === parseCell(key).slot && a.work_date === parseCell(key).date);
  const loc = k ? slotOf(b, k)?.location_id : null;
  const mates = b.emps.filter((e) => e.id !== from && (!loc || e.locs.includes(loc))).map((e) => {
    if (!k) return { e, state: 'ok' as const, why: '' };
    const d = parseCell(k).date, busyThatDay = keysOf(b, e.id).find((x) => parseCell(x).date === d);
    if (!availFor(b, e, k)) return { e, state: 'no' as const, why: "Said they can't work then" };
    if (busyThatDay) return { e, state: 'busy' as const, why: `Working ${slotOf(b, busyThatDay) ? shiftLong(slotOf(b, busyThatDay)!.start_hour, slotOf(b, busyThatDay)!.hours) : ''} that day` };
    return { e, state: 'ok' as const, why: 'Free then' };
  }).sort((x, y) => ['ok', 'busy', 'no'].indexOf(x.state) - ['ok', 'busy', 'no'].indexOf(y.state) || x.e.name.localeCompare(y.e.name));
  const label = (key: string) => { const s = slotOf(b, key)!, d = parseCell(key).date;
    return { day: new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short' }), date: new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }),
      time: shiftLong(s.start_hour, s.hours), where: b.locs.find((l) => l.id === s.location_id)?.name ?? '' }; };
  const send = async () => {
    if (!k || !to || !from) return;
    setBusy(true);
    const { error } = await supabase.rpc('request_future_swap', { p_to: to, p_slot: parseCell(k).slot, p_date: parseCell(k).date, p_note: note, p_from: owner ? from : null });
    setBusy(false);
    if (error) return toast(errText(error), 'error', 'Not sent');
    toast(`Sent to ${empOf(b, to)?.name}. When they accept, they're on that shift${owner ? '' : ' and your manager is told'}.`, 'ok', 'Swap request sent'); reset(!owner); onSent();
  };
  const slotsAt = b.slots.filter((x) => x.location_id === o.loc).sort((x, y) => x.start_hour - y.start_hour);
  const L = k ? label(k) : null;
  const n0 = owner ? 1 : 0, whose = owner ? `${me?.name ?? 'their'}'s` : 'your';
  return (
    <div className="swapreq">
      {owner && <div className="sr-step"><span className="sr-n">1</span><div className="sr-body"><h4>Whose shift?</h4>
        {search(b.emps.length, q1, setQ1, 'sr-q1')}
        <div className="sr-mates">{b.emps.filter((e) => hit(e.name, q1) || e.id === from).map((e) => { const n = keysOf(b, e.id).filter((x) => parseCell(x).date >= today).length; return (
          <button key={e.id} type="button" className={`sr-mate ok${from === e.id ? ' on' : ''}`} onClick={() => { setFrom(e.id); setCell(null); setOther(false); setTo(''); }} aria-pressed={from === e.id} style={{ ['--h' as string]: e.hue }}>
            <span className="dot" /><span className="nm">{e.name}</span><span className="st" style={{ color: 'var(--muted)', fontWeight: 500 }}>{n} upcoming shift{n === 1 ? '' : 's'}</span></button>); })}</div>
      </div></div>}

      <div className={`sr-step${from ? '' : ' dim'}`}><span className="sr-n">{n0 + 1}</span><div className="sr-body"><h4>{owner ? 'Which shift?' : "Which shift can't you work?"}</h4>
        {!from ? <p className="hint" style={{ margin: 0 }}>Pick whose shift first.</p> : <>
        <div className="sr-shifts">
          {mine.map((key) => { const x = label(key), was = asked(key); return (
            <button key={key} type="button" className={`sr-shift${!other && cell === key ? ' on' : ''}`} disabled={was} onClick={() => { setOther(false); setCell(key); }} aria-pressed={!other && cell === key}>
              <span className="d">{x.day}</span><b>{x.date}</b><span className="t">{x.time}</span><span className="w">{x.where}</span>{was && <span className="tag warn">Asked</span>}</button>); })}
          <button type="button" className={`sr-shift other${other ? ' on' : ''}`} onClick={() => { setOther(true); setCell(null); }} aria-pressed={other}>
            <span className="d">Any</span><b>Another date</b><span className="t">even if not scheduled yet</span></button>
        </div>
        {!mine.length && !other && <p className="hint" style={{ margin: '6px 0 0' }}>{owner ? `${me?.name} has` : 'You have'} no upcoming shifts on the schedule. Pick “Another date”.</p>}
        {other && <div className="sr-other">
          <div className="field"><label htmlFor="sr-date">Date</label><input id="sr-date" type="date" min={today} value={o.date} onChange={(e) => e.target.value && setO({ ...o, date: e.target.value })} /></div>
          {myLocs.length > 1 && <div className="field"><label htmlFor="sr-loc">Location</label><select id="sr-loc" value={o.loc} onChange={(e) => setO({ ...o, loc: e.target.value, slot: '' })}>{myLocs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>}
          <div className="field"><label htmlFor="sr-slot">Shift</label><select id="sr-slot" value={o.slot} onChange={(e) => setO({ ...o, slot: e.target.value })}><option value="">Pick…</option>
            {slotsAt.map((x) => <option key={x.id} value={x.id}>{shiftNameOf(x)} · {shiftLong(x.start_hour, x.hours)}</option>)}</select></div>
        </div>}</>}
      </div></div>

      <div className={`sr-step${k ? '' : ' dim'}`}><span className="sr-n">{n0 + 2}</span><div className="sr-body"><h4>Who should work it?</h4>
        {!k ? <p className="hint" style={{ margin: 0 }}>Pick the shift first; then you see who is free.</p>
          : <>{search(mates.length, q2, setQ2, 'sr-q2')}<div className="sr-mates">{mates.length ? mates.filter(({ e }) => hit(e.name, q2) || e.id === to).map(({ e, state, why }) => (
            <button key={e.id} type="button" className={`sr-mate ${state}${to === e.id ? ' on' : ''}`} onClick={() => setTo(e.id)} aria-pressed={to === e.id} style={{ ['--h' as string]: e.hue }}>
              <span className="dot" /><span className="nm">{e.name}</span><span className="st">{why}</span></button>))
            : <p className="hint" style={{ margin: 0 }}>Nobody else works at this location yet.</p>}</div></>}
      </div></div>

      <div className={`sr-step${k && to ? '' : ' dim'}`}><span className="sr-n">{n0 + 3}</span><div className="sr-body"><h4>Send</h4>
        {k && to && L ? <p className="sr-sum">Ask <b>{empOf(b, to)?.name}</b> to work {whose} <b>{L.day} {L.date}</b> shift, {L.time} at {L.where}.</p>
          : <p className="hint" style={{ margin: 0 }}>Pick a shift and {owner ? 'a worker' : 'a coworker'}.</p>}
        <div className="field"><label htmlFor="sr-note">Note (optional)</label><input id="sr-note" type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. doctor's appointment" /></div>
        <div className="actions" style={{ margin: 0 }}><button className="btn primary" disabled={!k || !to || busy} onClick={send}>{busy ? 'Sending…' : 'Send swap request'}</button>
          {(cell || other || to || note || (owner && from)) && <button className="btn" onClick={() => reset(false)}>Clear</button>}</div>
        <span className="hint" style={{ margin: 0 }}>{owner ? 'They accept or decline; when they accept, the schedule updates.' : 'They can accept, decline, or choose a shift of yours to work in return. Your manager is told.'}</span>
      </div></div>
    </div>);
}

/** Worker taps one of their shifts: ask a coworker to work it (the shift is already picked). */
export function SwapSheet({ b, empId, cell, onClose }: { b: Bundle; empId: string; cell?: string; onClose: () => void }) {
  return (
    <Sheet eyebrow="Swap a shift" title={cell ? 'Ask a coworker to work it' : 'Ask a coworker to work a shift'} onClose={onClose}>
      <SwapRequest b={b} empId={empId} pending={[]} onSent={onClose} initialCell={cell} />
    </Sheet>);
}

/** Owner: set up a swap for any worker, in a popup from the schedule. */
export function OwnerSwapSheet({ b, onClose }: { b: Bundle; onClose: () => void }) {
  return (
    <Sheet eyebrow="Shift swap" title="Set up a swap" onClose={onClose}>
      <p className="hint" style={{ margin: 0 }}>Tip: you can also tap any shift on the schedule, then “Swap or find cover”.</p>
      <SwapRequest b={b} owner pending={[]} onSent={onClose} />
    </Sheet>);
}
/** Owner: every swap (waiting, agreed, done) and shifts owed, in a popup from the schedule. */
export function SwapsSheet({ b, onClose }: { b: Bundle; onClose: () => void }) {
  return (
    <Sheet eyebrow="Shift swaps" title="All swaps" onClose={onClose}>
      <div className="swaps-sheet"><AdjustmentsPanel b={b} owner /></div>
    </Sheet>);
}
