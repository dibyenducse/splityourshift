import { useCallback, useEffect, useState } from 'react';
import { supabase, errText } from '../lib/supabase';
import { addDays, ago, shiftLong, todayIso } from '../lib/time';
import { cellKey, empOf, evaluate, keysOf, parseCell, slotLabel } from '../lib/rules';
import type { Bundle, Req } from '../lib/types';
import { Sheet, useToast } from './ui';
import { shiftNameOf } from './Logbook';

interface Offer { id: string; request_id: string; employee_id: string; label: string; slot_id: string | null; work_date: string; off_name: string | null; status: 'pending' | 'accepted' | 'declined' | 'closed'; created_at: string; decided_at: string | null }

/** Worker: ask the owner for time off on any date and shift (no schedule needed). Not a swap. */
export function TimeOffSheet({ b, empId, onClose, reload }: { b: Bundle; empId: string; onClose: () => void; reload: () => void }) {
  const toast = useToast();
  const me = empOf(b, empId);
  const locs = b.locs.filter((l) => me?.locs.includes(l.id)).length ? b.locs.filter((l) => me?.locs.includes(l.id)) : b.locs;
  const mine = keysOf(b, empId).filter((k) => parseCell(k).date >= todayIso() && !b.reqs.some((r) => r.employee_id === empId && r.slot_id === parseCell(k).slot && r.work_date === parseCell(k).date && ['pending', 'approved'].includes(r.status))).slice(0, 8);
  const [f, setF] = useState({ loc: locs[0]?.id ?? '', slot: '', date: addDays(todayIso(), 1), reason: '' });
  const [busy, setBusy] = useState(false);
  const slots = b.slots.filter((s) => s.location_id === f.loc).sort((x, y) => x.start_hour - y.start_hour);
  const pick = (k: string) => { const { slot, date } = parseCell(k); setF({ ...f, slot, date, loc: b.slots.find((s) => s.id === slot)?.location_id ?? f.loc }); };
  const send = async () => {
    if (!f.slot || !f.date) return toast('Pick the date and the shift.', 'error', 'Missing');
    setBusy(true);
    const { error } = await supabase.rpc('request_time_off_slot', { p_slot: f.slot, p_date: f.date, p_reason: f.reason });
    setBusy(false);
    if (error) return toast(errText(error), 'error', 'Not sent');
    toast('Sent to your manager. You get a notification with the answer and can cancel while it waits.', 'ok', 'Time off requested'); onClose(); reload();
  };
  return (
    <Sheet eyebrow="Time off" title="Request time off" onClose={onClose}>
      <div className="sec"><p>Goes straight to your manager, for any date, even if that week isn't scheduled yet. If they approve, they find someone to cover. (To trade a shift with a coworker yourself, use <b>Swap a shift</b> instead.)</p></div>
      {mine.length > 0 && <div className="field"><span className="lbl">Your upcoming shifts</span>
        <div className="chips-pick">{mine.map((k) => <button key={k} className={`btn small${f.slot === parseCell(k).slot && f.date === parseCell(k).date ? ' primary' : ''}`} onClick={() => pick(k)}>{slotLabel(b, k)}</button>)}</div></div>}
      <div className="twocol">
        <div className="field"><label htmlFor="to-date">Date</label><input id="to-date" type="date" min={todayIso()} value={f.date} onChange={(e) => e.target.value && setF({ ...f, date: e.target.value })} /></div>
        {locs.length > 1 && <div className="field"><label htmlFor="to-loc">Location</label>
          <select id="to-loc" value={f.loc} onChange={(e) => setF({ ...f, loc: e.target.value, slot: '' })}>{locs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>}
        <div className="field"><label htmlFor="to-slot">Shift</label>
          <select id="to-slot" value={f.slot} onChange={(e) => setF({ ...f, slot: e.target.value })}><option value="">Pick…</option>
            {slots.map((s) => <option key={s.id} value={s.id}>{shiftNameOf(s)} · {shiftLong(s.start_hour, s.hours)}</option>)}</select></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label htmlFor="to-reason">Reason (optional)</label><input id="to-reason" type="text" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="Doctor's appointment" /></div>
      </div>
      <div className="actions"><button className="btn primary" disabled={busy} onClick={send}>Send to manager</button><button className="btn" onClick={onClose}>Cancel</button></div>
    </Sheet>
  );
}

/** Worker: shifts the owner asks them to cover. The first to accept gets the shift. */
export function CoverOffersPanel({ b, empId }: { b: Bundle; empId: string }) {
  const toast = useToast();
  const [rows, setRows] = useState<Offer[]>([]);
  const [busy, setBusy] = useState('');
  const load = useCallback(async () => {
    const { data } = await supabase.from('cover_offers').select('*').eq('employee_id', empId).order('created_at', { ascending: false }).limit(20);
    setRows((data ?? []) as Offer[]);
  }, [empId]);
  useEffect(() => {
    load();
    const ch = supabase.channel(`offers-${empId}`).on('postgres_changes', { event: '*', schema: 'public', table: 'cover_offers', filter: `employee_id=eq.${empId}` }, () => load()).subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [empId, load]);
  const answer = async (o: Offer, yes: boolean) => {
    setBusy(o.id);
    const { error } = await supabase.rpc('answer_cover', { p_offer: o.id, p_accept: yes });
    setBusy('');
    if (error) toast(errText(error), 'error', "Didn't work"); else toast(yes ? `Thanks! ${o.label} is yours.` : 'Declined. Your manager is told.', 'ok', 'Done');
    load();
  };
  const open = rows.filter((o) => o.status === 'pending' && o.work_date >= todayIso());
  const recent = rows.filter((o) => !open.includes(o)).slice(0, 5);
  if (!rows.length) return null;
  void b;
  return (
    <section className="panel" id="cover-offers">
      <div className="panel-head"><h2>Can you cover?</h2>{open.length > 0 && <span className="badge">{open.length}</span>}</div>
      <p className="hint">Your manager is looking for someone to cover these shifts. The first to accept gets the shift.</p>
      {open.length ? <div className="stack">{open.map((o) => (
        <div key={o.id} className="item"><div><b>{o.label}</b>{o.off_name ? ` · ${o.off_name} is off` : ''}</div><small>{ago(o.created_at)}</small>
          <div className="actions"><button className="btn small primary" disabled={busy === o.id} onClick={() => answer(o, true)}>Yes, I'll cover it</button>
            <button className="btn small" disabled={busy === o.id} onClick={() => answer(o, false)}>Can't</button></div></div>))}</div>
        : <p className="empty-note">No open requests right now.</p>}
      {recent.length > 0 && <details className="adj-history"><summary>Earlier ({recent.length})</summary><div className="stack">{recent.map((o) => (
        <div key={o.id} className="item"><div>{o.label}</div><small><span className={`tag ${o.status === 'accepted' ? 'ok' : 'plain'}`}>{o.status === 'accepted' ? 'You covered it' : o.status === 'declined' ? 'You declined' : 'Covered by someone else'}</span></small></div>))}</div></details>}
    </section>
  );
}

/** Owner: "Who can cover this shift?" for an approved time off. Offers go to the chosen workers. */
export function CoverSheet({ b, req, onClose, reload }: { b: Bundle; req: Req; onClose: () => void; reload: () => void }) {
  const toast = useToast();
  const [offers, setOffers] = useState<Offer[]>([]);
  const [sel, setSel] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const { data } = await supabase.from('cover_offers').select('*').eq('request_id', req.id);
    setOffers((data ?? []) as Offer[]);
  }, [req.id]);
  useEffect(() => { load(); }, [load]);
  const slot = b.slots.find((s) => s.id === req.slot_id);
  const k = req.slot_id ? cellKey(req.slot_id, req.work_date) : null;
  const off = empOf(b, req.employee_id), cover = empOf(b, req.covered_by);
  const people = b.emps.filter((e) => e.id !== req.employee_id && (!slot || e.locs.includes(slot.location_id)))
    .map((e) => ({ e, r: k ? evaluate(b, { [k]: e.id }, { allowOver: true }) : { errors: [], warnings: [] }, o: offers.find((x) => x.employee_id === e.id) }))
    .sort((x, y) => x.r.errors.length - y.r.errors.length || x.r.warnings.length - y.r.warnings.length || x.e.name.localeCompare(y.e.name));
  const send = async () => {
    if (!sel.length) return toast('Pick at least one worker.', 'error', 'Nobody picked');
    setBusy(true);
    const { error } = await supabase.rpc('offer_cover', { p_request: req.id, p_emps: sel });
    setBusy(false);
    if (error) return toast(errText(error), 'error', 'Not sent');
    toast(`Asked ${sel.length} worker${sel.length > 1 ? 's' : ''}. The first to accept gets the shift.`, 'ok', 'Offers sent'); setSel([]); load(); reload();
  };
  return (
    <Sheet eyebrow="Time off approved" title="Who can cover this shift?" onClose={onClose}>
      <div className="sec"><p><b>{req.label}</b> · {off?.name ?? 'A worker'} is off{req.reason ? ` (${req.reason})` : ''}.</p>
        {cover ? <p><span className="tag ok">Coverage assigned</span> <b>{cover.name}</b> is covering it.</p> : <p><span className="tag bad">Needs cover</span> Pick who to ask. They get a notification; the first to accept is put on the shift, even if that week isn't scheduled yet.</p>}</div>
      {!cover && <div className="list">{people.map(({ e, r, o }) => (
        <label key={e.id} className="row"><input type="checkbox" checked={sel.includes(e.id)} disabled={o?.status === 'pending'} onChange={(ev) => setSel(ev.target.checked ? [...sel, e.id] : sel.filter((x) => x !== e.id))} />
          <span className="main"><b>{e.name}</b><span>{r.errors[0]?.msg ?? r.warnings[0]?.msg ?? 'Free at that time'}</span></span>
          {o ? <span className={`tag ${o.status === 'declined' ? 'bad' : o.status === 'accepted' ? 'ok' : 'warn'}`}>{o.status === 'pending' ? 'Asked' : o.status === 'declined' ? "Can't" : o.status === 'accepted' ? 'Covering' : 'Closed'}</span>
            : r.errors.length ? <span className="tag bad">{r.errors[0].short}</span> : r.warnings.length ? <span className="tag warn">{r.warnings[0].short}</span> : <span className="tag ok">Available</span>}</label>))}
        {!people.length && <p className="empty-note">No other workers at this location.</p>}</div>}
      <div className="actions">{!cover && <button className="btn primary" disabled={busy || !sel.length} onClick={send}>Ask {sel.length || ''} to cover</button>}<button className="btn" onClick={onClose}>Close</button></div>
    </Sheet>
  );
}
