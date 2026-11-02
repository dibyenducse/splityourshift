import { useCallback, useEffect, useState } from 'react';
import { supabase, errText } from '../lib/supabase';
import { ago } from '../lib/time';
import { empOf } from '../lib/rules';
import type { Adjustment, Bundle } from '../lib/types';
import { ConfirmButton, useToast } from './ui';

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
    case 'late_swap': return a.slot_id ? `${f} comes ${a.minutes} min early for ${t} another day (was late${on})` : `${f} and ${t}: ${a.minutes}-minute swap${a.note ? ` (${a.note})` : ''}`;
    case 'late_payroll': return `${f} was ${a.minutes} min late; paid by normal payroll${t ? ` (${t} stayed on)` : ''}${on}`;
    default: return `${f} and ${t ?? ''}: adjustment${on}`;
  }
}

/**
 * Shift swaps, takeovers and late-arrival agreements. Workers answer requests for them and see their history;
 * the owner sees everything, approves when mutual approval is off, and can propose a swap.
 */
export function AdjustmentsPanel({ b, empId, owner }: { b: Bundle; empId?: string; owner?: boolean }) {
  const toast = useToast();
  const [rows, setRows] = useState<Adjustment[]>([]);
  const [busy, setBusy] = useState('');
  const [prop, setProp] = useState({ from: '', to: '', kind: 'swap', minutes: 30, note: '' });
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
    if (!prop.from || !prop.to || prop.from === prop.to) return toast('Pick two different workers.', 'error', 'Missing');
    act('new', () => supabase.rpc('propose_adjustment', { p_from: prop.from, p_to: prop.to, p_kind: prop.kind, p_minutes: prop.minutes, p_note: prop.note }),
      `Sent to ${empOf(b, prop.to)?.name}. They accept or decline.`);
    setProp({ ...prop, note: '' });
  };

  const forMe = rows.filter((a) => owner ? a.status === 'awaiting_owner' : a.status === 'pending' && a.to_emp === empId);
  const mineWaiting = owner ? rows.filter((a) => a.status === 'pending') : rows.filter((a) => a.status === 'pending' && a.from_emp === empId);
  const todo = rows.filter((a) => a.status === 'accepted' && a.kind === 'late_swap' && (owner || a.from_emp === empId || a.to_emp === empId));
  const history = rows.filter((a) => !forMe.includes(a) && !mineWaiting.includes(a) && !todo.includes(a)).slice(0, 25);
  const tag = (a: Adjustment) => <span className={`tag ${STATUS[a.status][1]}`}>{STATUS[a.status][0]}</span>;
  const item = (a: Adjustment, buttons?: React.ReactNode) => (
    <div key={a.id} className="item adj"><div>{adjText(b, a)}</div><small>{ago(a.created_at)} · {tag(a)}</small>{buttons && <div className="actions">{buttons}</div>}</div>);

  if (!owner && !rows.length) return null;
  return (
    <section className="panel">
      <div className="panel-head"><h2>{owner ? 'Swaps and shift adjustments' : 'Swaps and agreements'}</h2>{forMe.length > 0 && <span className="badge">{forMe.length}</span>}</div>
      <p className="hint">{owner ? 'Takeovers, swaps, extra shifts and late arrivals that workers set up from the time clock. ' + (b.locs.some((l) => (l as { mutual_approval?: boolean }).mutual_approval === false) ? 'Where mutual approval is off, accepted swaps wait for you.' : 'When both workers agree it is final; you are told.')
        : 'Requests from coworkers, and what you agreed to. Your manager is told about each one.'}</p>
      {forMe.length > 0 && <><h4>{owner ? 'Waiting for your approval' : 'Waiting for your answer'}</h4><div className="stack">{forMe.map((a) => item(a, owner ? <>
        <button className="btn small primary" disabled={busy === a.id} onClick={() => update(a, 'approve', 'Approved.')}>Approve</button>
        <button className="btn small" disabled={busy === a.id} onClick={() => update(a, 'decline', 'Declined.')}>Decline</button></> : <>
        <button className="btn small primary" disabled={busy === a.id} onClick={() => respond(a, true)}>{a.kind === 'late_ignore' ? 'Approve' : 'Accept'}</button>
        <button className="btn small" disabled={busy === a.id} onClick={() => respond(a, false)}>Decline</button></>))}</div></>}
      {mineWaiting.length > 0 && <><h4>{owner ? 'Waiting for a worker to answer' : 'Your requests'}</h4><div className="stack">{mineWaiting.map((a) => item(a,
        <ConfirmButton className="btn small" label="Cancel request" confirmLabel="Tap again to cancel" onConfirm={() => update(a, 'cancel', 'Request cancelled.')} />))}</div></>}
      {todo.length > 0 && <><h4>Agreed, not done yet</h4><div className="stack">{todo.map((a) => item(a,
        <button className="btn small" disabled={busy === a.id} onClick={() => update(a, 'complete', 'Marked done.')}>Mark done</button>))}</div></>}
      {history.length > 0 && <details className="adj-history"><summary>History ({history.length})</summary><div className="stack">{history.map((a) => item(a))}</div></details>}
      {owner && <details className="adj-history"><summary>Propose a swap between two workers</summary>
        <div className="twocol" style={{ marginTop: 8 }}>
          <div className="field"><label htmlFor="pp-from">Worker who gets covered / comes early</label>
            <select id="pp-from" value={prop.from} onChange={(e) => setProp({ ...prop, from: e.target.value })}><option value="">Pick…</option>{b.emps.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></div>
          <div className="field"><label htmlFor="pp-to">Worker who is asked</label>
            <select id="pp-to" value={prop.to} onChange={(e) => setProp({ ...prop, to: e.target.value })}><option value="">Pick…</option>{b.emps.filter((e) => e.id !== prop.from).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></div>
          <div className="field"><label htmlFor="pp-kind">What</label>
            <select id="pp-kind" value={prop.kind} onChange={(e) => setProp({ ...prop, kind: e.target.value })}><option value="swap">They cover one whole shift (goes to Shifts owed)</option><option value="late_swap">A swap of minutes</option></select></div>
          {prop.kind === 'late_swap' && <div className="field"><label htmlFor="pp-min">Minutes</label><input id="pp-min" type="number" min={1} max={600} value={prop.minutes} onChange={(e) => setProp({ ...prop, minutes: +e.target.value || 1 })} /></div>}
          <div className="field" style={{ gridColumn: '1 / -1' }}><label htmlFor="pp-note">Note (optional)</label><input id="pp-note" type="text" value={prop.note} onChange={(e) => setProp({ ...prop, note: e.target.value })} placeholder="e.g. Friday night, Microtel" /></div>
        </div>
        <div className="actions"><button className="btn primary" disabled={busy === 'new'} onClick={propose}>Send proposal</button></div>
      </details>}
      {owner && !rows.length && <p className="empty-note">Nothing yet. When a worker clocks in late, covers someone or picks up an extra shift, it shows up here.</p>}
    </section>
  );
}
