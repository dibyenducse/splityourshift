import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../App';
import { supabase, errText } from '../lib/supabase';
import { loadBundle } from '../lib/api';
import { DAY_LONG, addDays, ago, ampm, mmdd, mondayOf, money, rangeTitle, shiftLong, todayIso } from '../lib/time';
import { cellKey, empOf, keysOf, parseCell, payFor, periodOf, slotLabel, slotOf } from '../lib/rules';
import type { Avail, Bundle, Req } from '../lib/types';
import { Loading, Sheet, useToast } from '../components/ui';
import { WeekGrid } from '../components/WeekGrid';
import { AppBar, NotesSheet, useNotes } from './AppShell';

const reqTag = (r: Req) => r.status === 'pending' ? <span className="tag warn">Time off requested</span>
  : r.status === 'approved' ? <span className="tag ok">Time off approved</span>
  : r.status === 'denied' ? <span className="tag bad">Request denied</span> : <span className="tag plain">Cancelled</span>;
const HOURS = Array.from({ length: 24 }, (_, h) => h);

export default function WorkerApp() {
  const { me, signOut } = useAuth();
  const toast = useToast();
  const [week, setWeek] = useState(() => mondayOf(todayIso()));
  const [b, setB] = useState<Bundle | null>(null);
  const [sheet, setSheet] = useState<'request' | 'notes' | 'account' | null>(null);
  const { notes, reload: reloadNotes } = useNotes();
  const orgId = me!.orgId!, empId = me!.empId!;

  const reload = useCallback(async () => {
    try { setB(await loadBundle(orgId, week, false, empId)); } catch (e) { toast(errText(e), 'error', "Couldn't load"); }
  }, [orgId, empId, week, toast]);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    const ch = supabase.channel(`w-${orgId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'assignments', filter: `org_id=eq.${orgId}` }, () => reload())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'time_off_requests', filter: `employee_id=eq.${empId}` }, () => reload())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [orgId, empId, reload]);

  if (!b) return <Loading />;
  const w = empOf(b, empId);
  if (!w) return <Loading text="Your worker profile was removed. Ask your manager." />;

  const mine = keysOf(b, w.id).filter((k) => parseCell(k).date >= week && parseCell(k).date < addDays(week, 7));
  const live: Record<string, Req> = {};
  for (const r of [...b.reqs].reverse()) if (r.employee_id === w.id && r.status !== 'cancelled' && r.slot_id) live[cellKey(r.slot_id, r.work_date)] = r;
  const myReqs = b.reqs.filter((r) => r.employee_id === w.id);
  const weeks = periodOf(b.org, week), p = payFor(b, w, weeks), wk = payFor(b, w, [week]);
  const hours = mine.reduce((n, k) => n + slotOf(b, k)!.hours, 0);

  const cancel = async (r: Req) => {
    const { error } = await supabase.rpc('cancel_time_off', { p_id: r.id });
    if (error) toast(errText(error), 'error', "Couldn't cancel"); else toast('Request cancelled. You keep this shift.', 'ok', 'Cancelled');
    reload();
  };
  const setAvail = async (a: Avail) => {
    const { error } = await supabase.from('availability').upsert({ employee_id: w.id, dow: a.dow, mode: a.mode, from_hour: a.from_hour, to_hour: a.to_hour });
    if (error) toast(errText(error), 'error', 'Not saved'); else toast(`Saved. ${DAY_LONG[a.dow]}: ${a.mode === 'any' ? 'any time' : a.mode === 'off' ? 'not available' : `${ampm(a.from_hour)} – ${ampm(a.to_hour)}`}.`, 'ok', 'Availability');
    reload();
  };

  return (
    <>
      <AppBar subtitle={b.org.name} week={week} setWeek={setWeek} notes={notes} onNotes={() => setSheet('notes')} onAccount={() => setSheet('account')} who={<>{w.name} · <b>Worker</b></>} />
      <div className="wrap"><div className="layout">
        <section className="panel"><div className="panel-head"><h2>My shifts · {rangeTitle(week, addDays(week, 6))}</h2><button className="btn primary small" onClick={() => setSheet('request')}>Request time off</button></div>
          <p className="hint">{mine.length} shift{mine.length === 1 ? '' : 's'} · {hours} hours this week · limit {w.max_shifts} shifts (set by your manager).</p>
          <div className="myshifts">{mine.length ? mine.map((k) => { const s = slotOf(b, k)!, d = parseCell(k).date, r = live[k];
            return (<div key={k} className="mycard" style={{ ['--h' as string]: w.hue }}>
              <span className="d">{DAY_LONG[(new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7]} {mmdd(d)}</span>
              <span className="t">{shiftLong(s.start_hour, s.hours)} · {s.hours}h</span>
              <span className="l">{b.locs.find((l) => l.id === s.location_id)?.name}</span>{r && reqTag(r)}</div>); })
            : <p className="empty-note">No shifts this week.</p>}</div></section>

        <section className="panel"><div className="panel-head"><h2>My pay · {rangeTitle(weeks[0], addDays(weeks[weeks.length - 1], 6))}</h2><span className="tag plain">Paid {b.org.pay_period === 'biweekly' ? 'every 2 weeks' : 'every week'}</span></div>
          <p className="hint">An estimate from your scheduled shifts, before taxes. Your manager sets your rate.</p>
          <div className="tiles">
            <div className="tile"><div className="k">Estimated pay</div><div className="v">{money(p.gross)}</div><div className="s">for this pay period</div></div>
            <div className="tile"><div className="k">Hours</div><div className="v">{p.hours}</div><div className="s">{weeks.length > 1 ? `${p.perWeek.join(' + ')} by week` : `${p.shifts} shifts`}</div></div>
            <div className="tile"><div className="k">Hourly rate</div><div className="v">{money(p.rate)}</div><div className="s">{p.ot ? `${p.ot} h overtime at ${money(p.rate * 1.5)}` : 'Overtime after 40 h a week'}</div></div>
            <div className="tile"><div className="k">This week</div><div className="v">{money(wk.gross)}</div><div className="s">{wk.hours} hours{p.covers ? ` · ${p.covers} extra shift${p.covers > 1 ? 's' : ''} covered` : ''}</div></div>
          </div></section>

        <section className="panel"><div className="panel-head"><h2>My availability</h2></div>
          <p className="hint">Tell your manager when you can work each week. They see it while making the schedule. For a single day off, use Request time off instead.</p>
          <div className="stack">{w.avail.map((a) => (
            <div key={a.dow} className="srow" style={{ gridTemplateColumns: '110px minmax(0,1.3fr) minmax(0,1fr) minmax(0,1fr)', alignItems: 'center' }}>
              <b>{DAY_LONG[a.dow]}</b>
              <select aria-label={`${DAY_LONG[a.dow]} availability`} value={a.mode} onChange={(e) => setAvail({ ...a, mode: e.target.value as Avail['mode'] })}>
                <option value="any">Any time</option><option value="hours">Only these hours</option><option value="off">Not available</option></select>
              {a.mode === 'hours' ? <>
                <select aria-label={`${DAY_LONG[a.dow]} from`} value={a.from_hour} onChange={(e) => setAvail({ ...a, from_hour: +e.target.value })}>{HOURS.map((h) => <option key={h} value={h}>{ampm(h)}</option>)}</select>
                <select aria-label={`${DAY_LONG[a.dow]} until`} value={a.to_hour} onChange={(e) => setAvail({ ...a, to_hour: +e.target.value })}>{HOURS.map((h) => <option key={h} value={h}>{ampm(h)}</option>)}</select>
              </> : <><span /><span /></>}
            </div>))}</div></section>

        <section className="panel"><div className="panel-head"><h2>My time-off requests</h2></div>
          <p className="hint">You can cancel a request while it's waiting. After your manager approves it, ask them directly to change it.</p>
          <div className="stack">{myReqs.length ? myReqs.map((r) => (
            <div key={r.id} className="item"><div><b>{r.label}</b></div>{r.reason && <q>{r.reason}</q>}
              <div className="actions">{reqTag(r)}<small>sent {ago(r.created_at)}</small>
                {r.status === 'pending' && <button className="btn small danger" onClick={() => cancel(r)}>Cancel request</button>}</div></div>))
            : <p className="empty-note">You haven't asked for any time off.</p>}</div></section>

        <div className="boards"><WeekGrid b={b} week={week} editable={false} meId={w.id} onlyLocs={w.locs.length ? w.locs : undefined} /></div>
      </div></div>

      {sheet === 'notes' && <NotesSheet notes={notes} onClose={() => setSheet(null)} reload={reloadNotes} />}
      {sheet === 'request' && <RequestSheet b={b} empId={w.id} week={week} live={live} onClose={() => setSheet(null)} reload={reload} />}
      {sheet === 'account' && <WorkerAccount b={b} empId={w.id} onClose={() => setSheet(null)} reload={reload} signOut={signOut} />}
    </>
  );
}

function RequestSheet({ b, empId, week, live, onClose, reload }: { b: Bundle; empId: string; week: string; live: Record<string, Req>; onClose: () => void; reload: () => void }) {
  const toast = useToast();
  const [sel, setSel] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const upcoming = keysOf(b, empId).filter((k) => { const d = parseCell(k).date; return d >= week && d < addDays(week, 14) && d >= todayIso() && !(live[k] && live[k].status !== 'denied'); });
  const send = async () => {
    if (!sel.length) return toast('Tick at least one shift.', 'error', 'Nothing selected');
    const cells = sel.map((k) => { const { slot, date } = parseCell(k); return { slot_id: slot, work_date: date }; });
    const { data, error } = await supabase.rpc('request_time_off', { p_cells: cells, p_reason: reason });
    if (error) return toast(errText(error), 'error', 'Not sent');
    toast(`Request sent for ${data} shift${data === 1 ? '' : 's'}. You can cancel it while it's waiting.`, 'ok', 'Sent');
    onClose(); reload();
  };
  return (
    <Sheet eyebrow="Time off" title="Ask for time off" onClose={onClose}>
      <div className="sec"><p>Choose the shifts you can't work. Your manager decides and finds cover. You'll get a notification with the answer, and you can cancel while it's waiting.</p></div>
      <div className="list">{upcoming.length ? upcoming.map((k) => (
        <label key={k} className="row"><input type="checkbox" checked={sel.includes(k)} onChange={(e) => setSel(e.target.checked ? [...sel, k] : sel.filter((x) => x !== k))} />
          <span className="main"><b>{slotLabel(b, k)}</b><span>{shiftLong(slotOf(b, k)!.start_hour, slotOf(b, k)!.hours)}</span></span></label>))
        : <p className="empty-note">No upcoming shifts to ask off in these two weeks.</p>}</div>
      <div className="field"><label htmlFor="rq-reason">Reason (optional)</label><input type="text" id="rq-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Doctor's appointment" /></div>
      <div><button className="btn primary" disabled={!upcoming.length} onClick={send}>Send request</button></div>
    </Sheet>
  );
}

function WorkerAccount({ b, empId, onClose, reload, signOut }: { b: Bundle; empId: string; onClose: () => void; reload: () => void; signOut: () => Promise<void> }) {
  const toast = useToast();
  const w = empOf(b, empId)!;
  const [phone, setPhone] = useState(w.phone ?? '');
  const [a, setA] = useState(''); const [c, setC] = useState('');
  const saveProfile = async () => {
    const { error } = await supabase.rpc('update_my_profile', { p_phone: phone });
    if (error) return toast(errText(error), 'error', 'Not saved');
    toast('Saved.', 'ok', 'Saved'); reload();
  };
  const changePw = async () => {
    if (a.length < 8) return toast('Use at least 8 characters.', 'error', "Can't save");
    if (a !== c) return toast("The two passwords don't match.", 'error', "Can't save");
    const { error } = await supabase.auth.updateUser({ password: a });
    if (error) return toast(errText(error), 'error', "Can't save");
    setA(''); setC(''); toast('New password saved.', 'ok', 'Saved');
  };
  return (
    <Sheet eyebrow="My account" title="My profile" onClose={onClose}>
      <div className="field"><label htmlFor="ac-wname">Name</label><input type="text" id="ac-wname" value={w.name} readOnly /></div>
      <div className="field"><label htmlFor="ac-email">Email (log-in)</label><input type="email" id="ac-email" value={w.email ?? ''} readOnly /></div>
      <div className="field"><label htmlFor="ac-phone">Phone (log-in)</label><input type="tel" id="ac-phone" value={phone} onChange={(e) => setPhone(e.target.value)} /></div>
      <div className="actions"><button className="btn primary" onClick={saveProfile}>Save</button></div>
      <div className="sec"><h4>Set by your manager</h4><p>Works at {w.locs.map((id) => b.locs.find((l) => l.id === id)?.name).filter(Boolean).join(', ') || '—'} · up to {w.max_shifts} shifts a week · {money(w.rate)} an hour.</p></div>
      <div className="sec"><h4>Change password</h4><div className="twocol">
        <div className="field"><label htmlFor="ac-pass">New password</label><input type="password" id="ac-pass" value={a} onChange={(e) => setA(e.target.value)} autoComplete="new-password" /></div>
        <div className="field"><label htmlFor="ac-pass2">Type it again</label><input type="password" id="ac-pass2" value={c} onChange={(e) => setC(e.target.value)} autoComplete="new-password" /></div></div>
        <div style={{ marginTop: 8 }}><button className="btn small" onClick={changePw}>Save new password</button></div></div>
      <div className="actions"><button className="btn" onClick={signOut}>Log out</button></div>
    </Sheet>
  );
}
