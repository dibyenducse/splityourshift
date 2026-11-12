import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../App';
import { supabase, errText } from '../lib/supabase';
import { loadBundle } from '../lib/api';
import { DAY_LONG, addDays, ago, mmdd, mondayOf, money, rangeTitle, shiftLong, todayIso } from '../lib/time';
import { availFor, cellKey, empOf, keysOf, parseCell, payFor, periodOf, slotOf } from '../lib/rules';
import { dateShort, myPay, periodTitle, type MyPay } from '../lib/payroll';
import type { Bundle, Req } from '../lib/types';
import { Loading, Sheet, useToast } from '../components/ui';
import { WeekGrid } from '../components/WeekGrid';
import { ClockPanel, HoursList } from '../components/Clock';
import { HowToSheet } from '../components/HowTo';
import { AppBar, NotesSheet, useNotes } from './AppShell';
import { ProfileMenu } from '../components/Avatar';
import { PayslipList } from '../components/Payslips';
import { AdjustmentsPanel, SwapSheet } from '../components/Adjustments';
import { MessagesView, useUnreadMessages } from '../components/Messages';
import { CoverOffersPanel, TimeOffSheet } from '../components/Cover';
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
  // A shift of mine I tapped: what to do with it (swap, time off, message my manager)
  const [shiftK, setShiftK] = useState<string | null>(null);
  const [swapK, setSwapK] = useState<string | null>(null);
  const [swapAny, setSwapAny] = useState(false);
  const [offK, setOffK] = useState<string | null>(null);
  const [msgWith, setMsgWith] = useState<string | null>(null);
  const [asks, setAsks] = useState<string[]>([]);
  const [howto, setHowto] = useState(false);
  // Worker sections in the header: my shifts (time clock, schedule, pay), the shift report logbook, my tasks.
  type View = 'schedule' | 'team' | 'pay' | 'messages' | 'reports' | 'tasks';
  const location = useLocation();
  const [pv, setPv] = useState<View>('schedule'); // owner's preview of a worker keeps its own tab
  const wseg = location.pathname.split('/')[2] ?? '';
  const view: View = preview ? pv : (['schedule', 'team', 'pay', 'messages', 'reports', 'tasks'] as string[]).includes(wseg) ? wseg as View : 'schedule';
  const { unread: unreadMsgs, reloadUnread } = useUnreadMessages(preview ? undefined : me?.orgId, preview ? undefined : me?.userId);
  const nav = useNavigate();
  const setView = (v: View) => { if (preview) setPv(v); else if (v !== view) { nav(`/app/${v}`); window.scrollTo({ top: 0 }); } };
  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const { notes, reload: reloadNotes } = useNotes();
  const [pay, setPay] = useState<MyPay[]>([]);
  const orgId = preview?.orgId ?? me!.orgId!, empId = preview?.empId ?? me!.empId!;

  const reload = useCallback(async () => {
    try { setB(await loadBundle(orgId, week, !!preview, empId)); } catch (e) { toast(errText(e), 'error', "Couldn't load"); }
  }, [orgId, empId, week, toast]);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { myPay(empId).then(setPay, () => {}); }, [empId, b?.entries.length]);
  // swap requests I've sent that are still waiting (marked on my shifts)
  const loadAsks = useCallback(() => supabase.from('shift_adjustments').select('slot_id, work_date').eq('from_emp', empId).eq('kind', 'future_swap').eq('status', 'pending')
    .then(({ data }) => setAsks((data ?? []).map((x) => cellKey(x.slot_id, x.work_date)))), [empId]);
  useEffect(() => { loadAsks(); }, [loadAsks, b]);
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
  /** What needs attention on one of my shifts. */
  const problemsOf = (k: string): { text: string; bad?: boolean }[] => {
    const out: { text: string; bad?: boolean }[] = [], r = live[k], d = parseCell(k).date;
    if (r?.status === 'pending') out.push({ text: 'Day off asked' });
    if (r?.status === 'approved') out.push({ text: 'Day off approved' });
    if (r?.status === 'denied') out.push({ text: 'Day off denied', bad: true });
    if (asks.includes(k)) out.push({ text: 'Swap asked' });
    if (!availFor(b, w, k)) out.push({ text: "You said you can't work then", bad: true });
    if (keysOf(b, w.id).some((x) => x !== k && parseCell(x).date === d)) out.push({ text: '2 shifts this day' });
    return out;
  };
  const weeks = periodOf(b.org, week), p = payFor(b, w, weeks), wk = payFor(b, w, [week]);
  const hours = mine.reduce((n, k) => n + slotOf(b, k)!.hours, 0);
  // Time clock off at every location I work at: no clock anywhere (panel, hours list, wording); pay is by schedule.
  const clockOn = b.locs.some((l) => w.locs.includes(l.id) && l.time_clock !== false) || b.entries.some((e) => e.employee_id === w.id && !e.clock_out);

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
          ...(self ? [{ label: 'Switch to owner view', hint: 'Schedule, time clock, payroll', onClick: self.onExit, primary: true, icon: 'switch' as const }] : []),
          { label: 'Account settings', onClick: () => nav('/app/account'), icon: 'account' as const },
          { label: 'Request time off', onClick: () => setSheet('request'), icon: 'timeoff' as const },
          { label: 'How-to videos', onClick: () => setHowto(true), icon: 'video' as const },
        ]} />}
        nav={<nav className="topnav" aria-label="Sections">{([['schedule', 'My schedule', 'Mine'], ['team', 'Team schedule', 'Team'], ['pay', 'Pay', 'Pay'], ['messages', 'Messages', 'Chat'], ['reports', 'Shift reports', 'Reports'], ['tasks', 'My tasks', 'Tasks']] as const).filter(([v]) => !(preview && v === 'messages')).map(([v, t, sh]) =>
          <button key={v} className={`tnav${view === v ? ' on' : ''}`} aria-current={view === v ? 'page' : undefined} onClick={() => setView(v)}>
            <span className="full">{t}</span><span className="short">{sh}</span>{v === 'messages' && unreadMsgs > 0 && <span className="badge">{unreadMsgs}</span>}</button>)}</nav>} />
      {view === 'reports' ? <div className="wrap"><div className="layout"><ShiftReportsBook b={b} empId={preview ? undefined : w.id} /></div></div>
      : view === 'tasks' ? <div className="wrap"><div className="layout"><TasksBoard b={b} empId={preview ? undefined : w.id} /></div></div>
      : view === 'messages' && !preview ? <div className="wrap"><div className="layout"><MessagesView orgId={orgId} userId={me!.userId} withUser={msgWith} onRead={reloadUnread} /></div></div>
      : <div className="wrap"><div className="layout">
        {preview && <div className="banner sample"><p><b>Preview: this is what {w.name} sees on their phone.</b> Buttons are turned off here. {w.status !== 'active' && `${w.name} can't log in yet: send them an invite from their profile.`}</p>
          <button className="btn small" onClick={preview.onExit}>‹ Back to owner view</button></div>}
        <fieldset disabled={!!preview} style={{ border: 0, padding: 0, margin: 0, minWidth: 0, display: 'contents' }}>
        {view === 'team' ? <>
        <section className="panel"><div className="panel-head"><h2>Team schedule · {rangeTitle(week, addDays(week, 6))}</h2></div>
          <p className="hint">Who works when this week. Your shifts are highlighted: tap one of yours to swap it or ask for the day off. Use the arrows at the top for other weeks.</p>
          <div className="boards"><WeekGrid b={b} week={week} editable={false} meId={w.id} onlyLocs={w.locs.length ? w.locs : undefined} onMine={preview ? undefined : (k) => setShiftK(k)} /></div></section>
        </> : view === 'schedule' ? <>
        <ClockPanel b={b} empId={w.id} userId={me!.userId} reload={reload} />
        <div className="quick-acts">
          <button className="quick-act" onClick={() => setSwapAny(true)}><span aria-hidden="true">⇄</span><b>Swap a shift</b><small>Ask a coworker to work it</small></button>
          <button className="quick-act" onClick={() => setSheet('request')}><span aria-hidden="true">🌴</span><b>Request time off</b><small>Your manager finds cover</small></button>
          {!preview && <button className="quick-act" onClick={() => { setMsgWith(b.org.owner_id); setView('messages'); }}><span aria-hidden="true">💬</span><b>Message manager</b><small>{unreadMsgs ? `${unreadMsgs} new message${unreadMsgs > 1 ? 's' : ''}` : 'Ask anything'}</small></button>}
        </div>
        {!preview && <CoverOffersPanel b={b} empId={w.id} />}

        <section className="panel" id="my-shifts"><div className="panel-head"><h2>My shifts · {rangeTitle(week, addDays(week, 6))}</h2><button className="btn primary small" onClick={() => setSheet('request')}>Request time off</button></div>
          <p className="hint">{mine.length} shift{mine.length === 1 ? '' : 's'} · {hours} hours this week · limit {w.max_shifts} shifts. <b>Tap a shift</b> to swap it, ask for the day off, or message your manager. See everyone's shifts under <button type="button" className="linkish" onClick={() => setView('team')}>Team schedule</button>.</p>
          {mine.length > w.max_shifts && <p className="reason bad" style={{ marginTop: 0 }}>You have {mine.length} shifts this week; your limit is {w.max_shifts}. Talk to your manager.</p>}
          <div className="myshifts">{mine.length ? mine.map((k) => { const s = slotOf(b, k)!, d = parseCell(k).date, probs = problemsOf(k);
            return (<button key={k} type="button" className={`mycard tap${probs.some((x) => x.bad) ? ' has-prob' : ''}${d === todayIso() ? ' today' : ''}`} style={{ ['--h' as string]: w.hue }} onClick={() => setShiftK(k)}>
              <span className="d">{d === todayIso() ? 'Today · ' : ''}{DAY_LONG[(new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7]} {mmdd(d)}</span>
              <span className="t">{shiftLong(s.start_hour, s.hours)} · {s.hours}h</span>
              <span className="l">{b.locs.find((l) => l.id === s.location_id)?.name}</span>
              {probs.length > 0 && <span className="probs">{probs.map((x) => <span key={x.text} className={`tag ${x.bad ? 'bad' : 'warn'}`}>{x.text}</span>)}</span>}
              <span className="go" aria-hidden="true">›</span></button>); })
            : <p className="empty-note">No shifts this week. Use the arrows at the top to see other weeks.</p>}</div></section>

        {!preview && <AdjustmentsPanel b={b} empId={w.id} />}
        </> : <>
        <section className="panel"><div className="panel-head"><h2>My pay · {rangeTitle(weeks[0], addDays(weeks[weeks.length - 1], 6))}</h2><span className="tag plain">Paid {b.org.pay_period === 'biweekly' ? 'every 2 weeks' : 'every week'}</span></div>
          <p className="hint">{clockOn && !b.locs.filter((l) => w.locs.includes(l.id)).every((l) => l.pay_method === 'schedule' || l.time_clock === false) ? 'Pay counts the hours you clocked in and out' : 'Pay counts your scheduled shift hours'}, before taxes. Your manager sets your rate.</p>
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
          {clockOn && <><h3 style={{ fontSize: 17, margin: '16px 0 8px' }}>My hours</h3>
          <HoursList b={b} empId={w.id} weeks={weeks} onCancel={async (f) => { const { error } = await supabase.rpc('cancel_time_fix', { p_id: f.id }); if (error) toast(errText(error), 'error', "Couldn't cancel"); else toast('Request cancelled.', 'ok', 'Cancelled'); reload(); }} /></>}
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

        </>}
        </fieldset>
      </div></div>}

      {howto && <HowToSheet topics={['clock', 'swap']} onClose={() => setHowto(false)} />}
      {sheet === 'notes' && <NotesSheet notes={notes} onClose={() => setSheet(null)} reload={reloadNotes} />}
      {sheet === 'request' && <TimeOffSheet b={b} empId={w.id} onClose={() => setSheet(null)} reload={reload} />}
      {offK && <TimeOffSheet b={b} empId={w.id} initialKey={offK} onClose={() => setOffK(null)} reload={reload} />}
      {swapAny && <SwapSheet b={b} empId={w.id} onClose={() => { setSwapAny(false); loadAsks(); }} />}
      {swapK && <SwapSheet b={b} empId={w.id} cell={swapK} onClose={() => { setSwapK(null); loadAsks(); }} />}
      {shiftK && slotOf(b, shiftK) && (() => { const s = slotOf(b, shiftK)!, d = parseCell(shiftK).date, probs = problemsOf(shiftK), r = live[shiftK], asked = asks.includes(shiftK);
        const sameDay = Object.keys(b.assign).filter((x) => parseCell(x).date === d && x !== shiftK && slotOf(b, x)?.location_id === s.location_id).map((x) => ({ x, e: empOf(b, b.assign[x]) })).filter((y) => y.e);
        return (
        <Sheet eyebrow="My shift" title={`${DAY_LONG[(new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7]} ${mmdd(d)} · ${shiftLong(s.start_hour, s.hours)}`} onClose={() => setShiftK(null)}>
          <p style={{ margin: 0 }}>{b.locs.find((l) => l.id === s.location_id)?.name} · {s.hours} hours</p>
          {probs.length > 0 && <div className="probs">{probs.map((x) => <span key={x.text} className={`tag ${x.bad ? 'bad' : 'warn'}`}>{x.text}</span>)}</div>}
          {d >= todayIso() && <div className="shift-acts">
            <button className="shift-act primary" disabled={asked} onClick={() => { setShiftK(null); setSwapK(shiftK); }}><span aria-hidden="true">⇄</span><b>{asked ? 'Swap already asked' : "Can't work it? Ask a coworker to swap"}</b><small>{asked ? 'Waiting for their answer. See Swaps below.' : 'Pick who works it; you see who is free that day.'}</small></button>
            <button className="shift-act" disabled={!!r && r.status !== 'denied'} onClick={() => { setShiftK(null); setOffK(shiftK); }}><span aria-hidden="true">🌴</span><b>{r && r.status !== 'denied' ? 'Day off already asked' : 'Ask for this day off'}</b><small>Your manager approves it and finds cover.</small></button>
            {!preview && <button className="shift-act" onClick={() => { const o = b.org.owner_id; setShiftK(null); setMsgWith(o); setView('messages'); }}><span aria-hidden="true">💬</span><b>Message my manager</b><small>About this shift or anything else.</small></button>}
          </div>}
          {sameDay.length > 0 && <div className="sec"><h4>Also working that day</h4><div className="stack">{sameDay.map(({ x, e }) => <div key={x} className="item"><span><b>{e!.name}</b> · {shiftLong(slotOf(b, x)!.start_hour, slotOf(b, x)!.hours)}</span></div>)}</div></div>}
        </Sheet>); })()}
    </>
  );
}


