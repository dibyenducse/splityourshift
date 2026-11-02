import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../App';
import { supabase, errText } from '../lib/supabase';
import { loadBundle } from '../lib/api';
import { DAY_LONG, addDays, ago, mmdd, mondayOf, money, rangeTitle, shiftLong, todayIso } from '../lib/time';
import { cellKey, empOf, keysOf, parseCell, payFor, periodOf, slotLabel, slotOf } from '../lib/rules';
import { dateShort, myPay, periodTitle, type MyPay } from '../lib/payroll';
import type { Bundle, Req } from '../lib/types';
import { Loading, Sheet, useToast } from '../components/ui';
import { WeekGrid } from '../components/WeekGrid';
import { ClockPanel, HoursList } from '../components/Clock';
import { AppBar, NotesSheet, useNotes } from './AppShell';
import { ProfileMenu } from '../components/Avatar';
import { PayslipList } from '../components/Payslips';
import { AdjustmentsPanel } from '../components/Adjustments';
import { TasksBoard } from '../components/ShiftLog';
import { ShiftReportsBook } from '../components/Logbook';
import { AvailabilityEditor } from '../components/Availability';

const reqTag = (r: Req) => r.status === 'pending' ? <span className="tag warn">Time off requested</span>
  : r.status === 'approved' ? <span className="tag ok">Time off approved</span>
  : r.status === 'denied' ? <span className="tag bad">Request denied</span> : <span className="tag plain">Cancelled</span>;

/**
 * Worker app. With `preview`, an owner sees exactly what one worker sees, with every button turned off.
 * With `self`, an owner who also works shifts uses their own worker profile (fully working) and can switch back.
 */
export default function WorkerApp({ preview, self }: { preview?: { orgId: string; empId: string; onExit: () => void }; self?: { onExit: () => void } }) {
  const { me } = useAuth();
  const toast = useToast();
  const [week, setWeek] = useState(() => mondayOf(todayIso()));
  const [b, setB] = useState<Bundle | null>(null);
  const [sheet, setSheet] = useState<'request' | 'notes' | null>(null);
  // Worker sections in the header: my shifts (time clock, schedule, pay), the shift report logbook, my tasks.
  const [view, setView] = useState<'home' | 'reports' | 'tasks'>('home');
  const nav = useNavigate();
  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const { notes, reload: reloadNotes } = useNotes();
  const [pay, setPay] = useState<MyPay[]>([]);
  const orgId = preview?.orgId ?? me!.orgId!, empId = preview?.empId ?? me!.empId!;

  const reload = useCallback(async () => {
    try { setB(await loadBundle(orgId, week, !!preview, empId)); } catch (e) { toast(errText(e), 'error', "Couldn't load"); }
  }, [orgId, empId, week, toast]);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { myPay(empId).then(setPay, () => {}); }, [empId, b?.entries.length]);
  useEffect(() => {
    const ch = supabase.channel(`w-${orgId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'assignments', filter: `org_id=eq.${orgId}` }, () => reload())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'time_off_requests', filter: `employee_id=eq.${empId}` }, () => reload())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'time_entries', filter: `employee_id=eq.${empId}` }, () => reload())
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

  return (
    <>
      <AppBar subtitle={b.org.name} week={week} setWeek={setWeek} notes={preview ? undefined : notes} onNotes={preview ? undefined : () => setSheet('notes')}
        onAccount={preview ? preview.onExit : () => nav('/app/account')} who={preview ? <>‹ Back to owner view</> : <>{w.name} · <b>Worker</b></>}
        profile={preview ? undefined : <ProfileMenu name={w.name} role={`${self ? 'Owner, working as a worker' : 'Worker'} · ${b.org.name}`} items={[
          ...(self ? [{ label: '⇄ Switch to owner view', hint: 'Schedule, time clock, payroll', onClick: self.onExit, primary: true }] : []),
          { label: 'Account settings', hint: 'Name, email, photo, password, availability', onClick: () => nav('/app/account') },
          { label: 'My shifts', hint: rangeTitle(week, addDays(week, 6)), onClick: () => { setView('home'); setTimeout(() => jump('my-shifts'), 50); } },
          { label: 'Shift reports', hint: 'The logbook: write and read reports', onClick: () => setView('reports') },
          { label: 'My tasks', onClick: () => setView('tasks') },
          { label: 'Request time off', onClick: () => setSheet('request') },
          { label: 'My payslips', hint: 'Every paid payday', onClick: () => { setView('home'); setTimeout(() => jump('my-payslips'), 50); } },
        ]} />}
        nav={<nav className="topnav" aria-label="Sections">{([['home', 'My shifts'], ['reports', 'Shift reports'], ['tasks', 'My tasks']] as const).map(([v, t]) =>
          <button key={v} className={`tnav${view === v ? ' on' : ''}`} aria-current={view === v ? 'page' : undefined} onClick={() => setView(v)}>{t}</button>)}</nav>} />
      {view === 'reports' ? <div className="wrap"><div className="layout"><ShiftReportsBook b={b} empId={preview ? undefined : w.id} /></div></div>
      : view === 'tasks' ? <div className="wrap"><div className="layout"><TasksBoard b={b} empId={preview ? undefined : w.id} /></div></div>
      : <div className="wrap"><div className="layout">
        {preview && <div className="banner sample"><p><b>Preview: this is what {w.name} sees on their phone.</b> Buttons are turned off here. {w.status !== 'active' && `${w.name} can't log in yet: send them an invite from their profile.`}</p>
          <button className="btn small" onClick={preview.onExit}>‹ Back to owner view</button></div>}
        <fieldset disabled={!!preview} style={{ border: 0, padding: 0, margin: 0, minWidth: 0, display: 'contents' }}>
        <ClockPanel b={b} empId={w.id} userId={me!.userId} reload={reload} />
        {!preview && <AdjustmentsPanel b={b} empId={w.id} />}

        <section className="panel" id="my-shifts"><div className="panel-head"><h2>My shifts · {rangeTitle(week, addDays(week, 6))}</h2><button className="btn primary small" onClick={() => setSheet('request')}>Request time off</button></div>
          <p className="hint">{mine.length} shift{mine.length === 1 ? '' : 's'} · {hours} hours this week · limit {w.max_shifts} shifts (set by your manager).</p>
          <div className="myshifts">{mine.length ? mine.map((k) => { const s = slotOf(b, k)!, d = parseCell(k).date, r = live[k];
            return (<div key={k} className="mycard" style={{ ['--h' as string]: w.hue }}>
              <span className="d">{DAY_LONG[(new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7]} {mmdd(d)}</span>
              <span className="t">{shiftLong(s.start_hour, s.hours)} · {s.hours}h</span>
              <span className="l">{b.locs.find((l) => l.id === s.location_id)?.name}</span>{r && reqTag(r)}</div>); })
            : <p className="empty-note">No shifts this week.</p>}</div></section>

        <section className="panel"><div className="panel-head"><h2>My pay · {rangeTitle(weeks[0], addDays(weeks[weeks.length - 1], 6))}</h2><span className="tag plain">Paid {b.org.pay_period === 'biweekly' ? 'every 2 weeks' : 'every week'}</span></div>
          <p className="hint">Pay counts the hours you clocked in and out, before taxes. Your manager sets your rate.</p>
          <div className="tiles">
            {pay.map((x) => <div key={x.location_id} className="tile"><div className="k">Next payday{pay.length > 1 ? ` · ${x.location_name}` : ''} · {dateShort(x.next_pay_date)}</div><div className="v">{money(x.next_net)}</div>
              <div className="s">{x.next_paid ? 'paid · ' : ''}for {periodTitle({ period_start: x.next_start, period_end: x.next_end })} · {x.next_hours} h</div></div>)}
            <div className="tile"><div className="k">Earned so far</div><div className="v">{money(p.gross)}</div><div className="s">this pay period</div></div>
            <div className="tile"><div className="k">Hours worked</div><div className="v">{p.hours}</div><div className="s">{p.sched} h scheduled{weeks.length > 1 ? ` · ${p.perWeek.join(' + ')} by week` : ''}</div></div>
            <div className="tile"><div className="k">Hourly rate</div><div className="v">{money(p.rate)}</div><div className="s">{p.ot ? `${p.ot} h overtime at ${money(p.rate * 1.5)}` : 'Overtime after 40 h a week'}</div></div>
            <div className="tile"><div className="k">This week</div><div className="v">{money(wk.gross)}</div><div className="s">{wk.hours} h worked{p.covers ? ` · ${p.covers} extra shift${p.covers > 1 ? 's' : ''} covered` : ''}</div></div>
          </div>
          <h3 id="my-payslips" style={{ fontSize: 17, margin: '16px 0 8px' }}>My payslips</h3>
          <PayslipList business={b.org.name} empId={w.id} limit={6} />
          <h3 style={{ fontSize: 17, margin: '16px 0 8px' }}>My hours</h3>
          <HoursList b={b} empId={w.id} weeks={weeks} onCancel={async (f) => { const { error } = await supabase.rpc('cancel_time_fix', { p_id: f.id }); if (error) toast(errText(error), 'error', "Couldn't cancel"); else toast('Request cancelled.', 'ok', 'Cancelled'); reload(); }} />
        </section>

        <section className="panel"><div className="panel-head"><h2>My availability</h2></div>
          <p className="hint">Tell your manager when you can work each week. They see it while making the schedule. For a single day off, use Request time off instead.</p>
          <AvailabilityEditor empId={w.id} avail={w.avail} onSaved={reload} /></section>

        <section className="panel"><div className="panel-head"><h2>My time-off requests</h2></div>
          <p className="hint">You can cancel a request while it's waiting. After your manager approves it, ask them directly to change it.</p>
          <div className="stack">{myReqs.length ? myReqs.map((r) => (
            <div key={r.id} className="item"><div><b>{r.label}</b></div>{r.reason && <q>{r.reason}</q>}
              <div className="actions">{reqTag(r)}<small>sent {ago(r.created_at)}</small>
                {r.status === 'pending' && <button className="btn small danger" onClick={() => cancel(r)}>Cancel request</button>}</div></div>))
            : <p className="empty-note">You haven't asked for any time off.</p>}</div></section>

        <div className="boards"><WeekGrid b={b} week={week} editable={false} meId={w.id} onlyLocs={w.locs.length ? w.locs : undefined} /></div>
        </fieldset>
      </div></div>}

      {sheet === 'notes' && <NotesSheet notes={notes} onClose={() => setSheet(null)} reload={reloadNotes} />}
      {sheet === 'request' && <RequestSheet b={b} empId={w.id} week={week} live={live} onClose={() => setSheet(null)} reload={reload} />}
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

