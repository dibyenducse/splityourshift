import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../App';
import { supabase, errText } from '../lib/supabase';
import { applyChanges, loadBundle, markNotesRead, myWorkerProfile, sendInvite } from '../lib/api';
import { DAY_LONG, addDays, ago, mondayOf, money, rangeTitle, shiftLong, shiftShort, todayIso } from '../lib/time';
import {
  HUES, TYPE_LABEL, absStart, availText, cellKey, countWeek, empOf, evaluate, hoursWeek, keysOf, locName, parseCell, payFor, periodOf,
  shortName, slotLabel, slotOf, swapOf, valid, type Changes, type Result, type Row,
} from '../lib/rules';
import type { Bundle, Emp, LedgerRow, Loc, Req } from '../lib/types';
import { ConfirmButton, Loading, Sheet, StatusTag, useToast } from '../components/ui';
import { PrintIcon, WeekGrid, printBoards, useDragDrop } from '../components/WeekGrid';
import { ShiftEditor } from '../components/ShiftEditor';
import { AppBar, NotesSheet, useNotes } from './AppShell';
import { ProfileMenu } from '../components/Avatar';
import { TaskManager, TasksBoard } from '../components/ShiftLog';
import { ShiftReportsBook } from '../components/Logbook';
import { CoverSheet, PaybackPicker } from '../components/Cover';
import { PayslipList } from '../components/Payslips';
import Onboarding from './Onboarding';
import TimeClock from './OwnerTime';
import Payroll from './Payroll';
import { payDashboard, dateShort, type DashRow } from '../lib/payroll';
import WorkerApp from './Worker';
import { PLANS, planOf, wantPlan } from '../lib/plans';

type SheetState =
  | { type: 'shift'; key: string } | { type: 'swap'; key: string } | { type: 'swap-with'; key: string; other: string }
  | { type: 'payback'; id: string } | { type: 'profile'; id: string } | { type: 'loc'; loc: Loc } | { type: 'delloc' }
  | { type: 'notes' } | { type: 'cover'; id: string } | null;

const countClass = (n: number, max: number) => (n > max ? 'over' : n === max ? 'full' : '');
const UserIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>
);

const statusTag = (r: Result) => r.errors.length ? <span className="tag bad">{r.errors[0].short}</span>
  : r.warnings.length ? <span className="tag warn">{r.warnings[0].short}</span> : <span className="tag ok">Works</span>;

export default function OwnerApp() {
  const { me, signOut, refresh } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const [week, setWeek] = useState(() => mondayOf(todayIso()));
  const [b, setB] = useState<Bundle | null>(null);
  // Owner who also works shifts: the worker view of their own profile (remembered on this device).
  const [asWorker, setAsWorkerState] = useState(() => { try { return localStorage.getItem('sys-view') === 'worker'; } catch { return false; } });
  const setAsWorker = (on: boolean) => { setAsWorkerState(on); try { localStorage.setItem('sys-view', on ? 'worker' : 'owner'); } catch { /* private mode */ } };
  const [tab, setTab] = useState<'schedule' | 'time' | 'payroll' | 'reports' | 'tasks'>('schedule');
  const [sheet, setSheet] = useState<SheetState>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [previewEmp, setPreviewEmp] = useState<string | null>(null);
  const [payLoc, setPayLoc] = useState<string | undefined>();
  const [payDue, setPayDue] = useState<DashRow[]>([]);
  // Undo is per schedule (location): each change remembers which locations' cells it touched.
  const undo = useRef<{ locs: string[]; changes: Changes; ledgerId?: string }[]>([]);
  const [, setUndoTick] = useState(0);
  const { notes, reload: reloadNotes } = useNotes();
  const orgId = me!.orgId!;

  const reload = useCallback(async () => {
    try { setB(await loadBundle(orgId, week, true)); } catch (e) { toast(errText(e), 'error', "Couldn't load"); }
  }, [orgId, week, toast]);
  useEffect(() => { reload(); }, [reload]);
  // A plan picked on the home page before signing up: open its checkout once.
  useEffect(() => { const [p, bill] = (wantPlan.take() ?? '').split('|'); if (p === 'plus' || p === 'premium') nav(`/app/plan?plan=${p}&billing=${bill === 'yearly' ? 'yearly' : 'monthly'}`); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Payroll reminder on the main screen: payday within 2 days (or past) and not marked paid yet.
  useEffect(() => {
    const soon = addDays(todayIso(), 2);
    payDashboard(orgId).then((d) => setPayDue(d.filter((r) => r.pending > 0 || (!r.next_paid && r.next_pay_date <= soon))), () => {});
  }, [orgId, tab]);

  /** Opens the owner's own worker view. Every owner has a worker profile (made with the business); this re-creates it if it was deleted. */
  const goWorker = async () => {
    setSheet(null);
    if (me!.empId) return setAsWorker(true);
    try { await myWorkerProfile(orgId); await refresh(); setAsWorker(true); }
    catch (e) { toast(errText(e), 'error', "Couldn't switch"); }
  };
  useEffect(() => {
    let t: number | undefined;
    const soon = () => { clearTimeout(t); t = window.setTimeout(reload, 400); };
    const ch = supabase.channel(`org-${orgId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'assignments', filter: `org_id=eq.${orgId}` }, soon)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'time_off_requests', filter: `org_id=eq.${orgId}` }, soon)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'time_entries', filter: `org_id=eq.${orgId}` }, soon)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'time_fix_requests', filter: `org_id=eq.${orgId}` }, soon)
      .subscribe();
    return () => { clearTimeout(t); supabase.removeChannel(ch); };
  }, [orgId, reload]);

  // Apply schedule changes: check locally (instant), save through apply_changes (the database re-checks), roll back on error.
  const commit = useCallback(async (changes: Changes, message: string, opts: { ledger?: Record<string, unknown>; settle?: string; skipUndo?: boolean; shakeKey?: string; allowOver?: boolean } = {}) => {
    if (!b) return false;
    const r = evaluate(b, changes, { allowOver: opts.allowOver });
    if (r.errors.length) {
      toast(r.errors[0].msg, 'error', "Can't do that");
      if (opts.shakeKey) { const td = document.querySelector(`td[data-cell="${opts.shakeKey}"]`); td?.classList.remove('shake'); void (td as HTMLElement | null)?.offsetWidth; td?.classList.add('shake'); }
      return false;
    }
    const inverse: Changes = {};
    for (const k in changes) inverse[k] = b.assign[k] ?? null;
    setB((prev) => { if (!prev) return prev; const a = { ...prev.assign }; for (const k in changes) { const v = changes[k]; if (v) a[k] = v; else delete a[k]; } return { ...prev, assign: a }; });
    try {
      await applyChanges(orgId, changes, opts.allowOver);
      let ledgerId: string | undefined;
      if (opts.ledger) { const { data } = await supabase.from('ledger').insert(opts.ledger).select('id').single(); ledgerId = data?.id; }
      if (opts.settle) await supabase.from('ledger').update({ status: 'settled', settled_at: new Date().toISOString() }).eq('id', opts.settle);
      if (!opts.skipUndo) {
        const locs = [...new Set(Object.keys(changes).map((k) => slotOf(b, k)?.location_id).filter(Boolean) as string[])];
        undo.current.push({ locs, changes: inverse, ledgerId }); if (undo.current.length > 80) undo.current.shift();
        setUndoTick((t) => t + 1);
      }
      if (r.warnings.length) toast(`${message} ${r.warnings.map((w) => w.msg).join(' ')}`, 'warn', 'Done, check this'); else toast(message, 'ok', 'Done');
      reload();
      return true;
    } catch (e) {
      toast(errText(e), 'error', "Can't do that");
      reload();
      return false;
    }
  }, [b, orgId, reload, toast]);

  /** Undo the last change made on one location's schedule; changes on other locations stay. */
  const doUndo = async (locId: string) => {
    const i = undo.current.map((u) => u.locs.includes(locId)).lastIndexOf(true); if (i < 0) return;
    const [last] = undo.current.splice(i, 1); setUndoTick((t) => t + 1);
    if (last.ledgerId) await supabase.from('ledger').delete().eq('id', last.ledgerId);
    const names = last.locs.map((id) => b?.locs.find((l) => l.id === id)?.name).filter(Boolean).join(' and ');
    await commit(last.changes, `Undone: the last change on ${names}.`, { skipUndo: true, allowOver: true });
  };
  const undoHint = (locId: string) => {
    const u = [...undo.current].reverse().find((x) => x.locs.includes(locId)); if (!u || !b) return null;
    const keys = Object.keys(u.changes), other = u.locs.filter((x) => x !== locId).map((id) => b.locs.find((l) => l.id === id)?.name).filter(Boolean);
    return `Undo the last change here (${keys.length === 1 ? slotLabel(b, keys[0]) : `${keys.length} shifts`})${other.length ? `; it was a trade with ${other.join(', ')}, so that part is undone too` : ''}`;
  };

  useDragDrop({
    enabled: !!b && tab === 'schedule' && !adding && !previewEmp,
    check: (ch) => (b ? evaluate(b, ch) : { errors: [], warnings: [] }),
    nameOf: (id) => empOf(b!, id)?.name ?? '',
    occupant: (k) => b?.assign[k],
    label: (k) => slotLabel(b!, k),
    onStart: () => setPicked(null),
    onDrop: (ch, wid, from, to) => {
      const name = empOf(b!, wid)?.name ?? '';
      if (to === 'trash') { commit(ch, `${name} removed from ${slotLabel(b!, from!)}. The shift is open.`); return; }
      const occ = empOf(b!, b!.assign[to]);
      const msg = from ? (occ ? `Traded. ${name} works ${slotLabel(b!, to)} and ${occ.name} works ${slotLabel(b!, from)}.` : `${name} moved to ${slotLabel(b!, to)}.`)
        : (occ ? `${name} replaces ${occ.name} on ${slotLabel(b!, to)}.` : `${name} now works ${slotLabel(b!, to)}.`);
      commit(ch, msg, { shakeKey: to });
    },
  });

  if (asWorker && me!.empId) return <WorkerApp self={{ onExit: () => { setAsWorker(false); reload(); } }} />;
  if (!b) return <Loading />;
  if (previewEmp) return <WorkerApp preview={{ orgId, empId: previewEmp, onExit: () => { setPreviewEmp(null); reload(); } }} />;
  if (adding) return (
    <><AppBar subtitle={b.org.name} onAccount={() => nav('/app/account')} who={<>{b.org.owner_name || me!.email} · <b>Owner</b></>}
      profile={<ProfileMenu name={b.org.owner_name || me!.email} role={`Owner · ${b.org.name}`} items={[{ label: 'Account settings', onClick: () => nav('/app/account') }]} />} />
      <div className="wrap"><Onboarding mode="add" orgId={orgId} existing={b.emps} onCancel={() => setAdding(false)} onDone={() => { setAdding(false); reload(); }} /></div></>
  );

  const onCell = (k: string) => {
    if (picked) {
      const w = empOf(b, picked)!, prev = empOf(b, b.assign[k]);
      if (prev?.id === w.id) { setPicked(null); return; }
      commit({ [k]: w.id }, prev ? `${w.name} replaces ${prev.name} on ${slotLabel(b, k)}.` : `${w.name} now works ${slotLabel(b, k)}.`, { shakeKey: k }).then((ok) => ok && setPicked(null));
      return;
    }
    setSheet({ type: 'shift', key: k });
  };

  const pending = b.reqs.filter((r) => r.status === 'pending');
  const needCover = b.reqs.filter((r) => r.status === 'approved' && r.slot_id && !r.covered_by && r.work_date >= todayIso()).sort((x, y) => x.work_date.localeCompare(y.work_date));
  const openOwed = b.ledger.filter((l) => l.status === 'open');
  const emptyWeek = !b.slots.some((s) => DAY_LONG.some((_, d) => b.assign[cellKey(s.id, addDays(week, d))]));
  const prevHas = b.slots.some((s) => DAY_LONG.some((_, d) => b.assign[cellKey(s.id, addDays(week, d - 7))]));

  const copyLastWeek = async () => {
    const ch: Changes = {};
    for (const s of b.slots) for (let d = 0; d < 7; d++) { const w = b.assign[cellKey(s.id, addDays(week, d - 7))]; if (w) ch[cellKey(s.id, addDays(week, d))] = w; }
    try { await applyChanges(orgId, ch); toast(`Copied last week into ${rangeTitle(week, addDays(week, 6))}. Drag names to make changes.`, 'ok', 'Copied'); }
    catch (e) { toast(errText(e), 'error', "Couldn't copy"); }
    reload();
  };

  const decide = async (r: Req, approve: boolean) => {
    const { error } = await supabase.rpc('decide_time_off', { p_id: r.id, p_approve: approve });
    if (error) { toast(errText(error), 'error', 'Not saved'); reload(); return; }
    const w = empOf(b, r.employee_id);
    await reload(); reloadNotes();
    if (approve && r.slot_id) {
      setSheet({ type: 'cover', id: r.id });
      toast(`Approved. ${w?.name ?? 'They'} ${w ? 'is' : 'are'} off ${r.label}. Now ask who can cover.`, 'ok', 'Approved');
    } else toast(approve ? 'Approved.' : `Denied. ${w?.name ?? 'The worker'} keeps the shift.`, approve ? 'ok' : 'warn', approve ? 'Approved' : 'Denied');
  };

  const addWorker = async () => {
    const { data, error } = await supabase.from('employees').insert({ org_id: orgId, name: 'New worker', hue: HUES[b.emps.length % HUES.length] }).select('id').single();
    if (error) return toast(errText(error), 'error', "Couldn't add");
    if (b.locs[0]) await supabase.from('employee_locations').insert({ employee_id: data.id, location_id: b.locs[0].id });
    await reload(); setSheet({ type: 'profile', id: data.id });
  };

  // ---------- views ----------
  const staff = [...b.emps].sort((x, y) => x.name.localeCompare(y.name));
  const onClock = b.entries.filter((e) => !e.clock_out).length, fixCount = b.fixes.filter((f) => f.status === 'pending').length + b.entries.filter((e) => e.claimed_in).length;
  const tabs = <nav className="topnav" aria-label="Sections">{(['schedule', 'time', 'payroll', 'reports', 'tasks'] as const).map((t) => <button key={t} className={`tnav${tab === t ? ' on' : ''}`} aria-current={tab === t ? 'page' : undefined} onClick={() => setTab(t)}>
    {t === 'schedule' ? 'Schedule' : t === 'time' ? <>Time clock{onClock > 0 && <span className="sdot" />}{fixCount > 0 && <span className="badge">{fixCount}</span>}</> : t === 'payroll' ? 'Payroll' : t === 'reports' ? <><span className="full">Shift reports</span><span className="short">Reports</span></> : 'Tasks'}</button>)}</nav>;

  const schedule = (
    <div className="layout two owner">
      <aside className="rail">
        <section className="panel" id="roster">
          <div className="panel-head"><h2>Staff</h2><button className="mini" onClick={addWorker}>+ Add worker</button></div>
          <p className="hint">Drag a name onto a shift, or tap a name and then a shift. The number is shifts this week out of their limit. Open a profile to send a login invite.</p>
          <div className="roster-list">
            {staff.length ? staff.map((w) => { const n = countWeek(b, w.id, week); return (
              <div key={w.id} className={`wcard${picked === w.id ? ' picked' : ''}`} data-drag="" data-wid={w.id} style={{ ['--h' as string]: w.hue }}
                onClick={(e) => { if (!(e.target as HTMLElement).closest('button')) setPicked(picked === w.id ? null : w.id); }}>
                <span className="dot" /><span className="wname" title={w.name}>{w.name}</span>{b.entries.some((e) => e.employee_id === w.id && !e.clock_out) && <span className="sdot" title={`${w.name} is on the clock`} aria-label="On the clock" />}
                {w.user_id === me!.userId ? <span className="lstat you">you</span> : w.status !== 'active' && <span className={`lstat ${w.status}`}>{w.status === 'invited' ? 'invited' : w.status === 'expired' ? 'expired' : 'no login'}</span>}
                <span className={`count ${countClass(n, w.max_shifts)}`}>{n}/{w.max_shifts}</span>
                <button className="iconbtn" onClick={() => setSheet({ type: 'profile', id: w.id })} title="View Profile" aria-label={`View ${w.name}'s profile`}><UserIcon /></button>
              </div>); }) : <p className="empty-note">No workers yet.</p>}
          </div>
        </section>
        <section className="panel">
          <div className="panel-head"><h2>Time-off requests{pending.length > 0 && <span className="badge">{pending.length}</span>}</h2></div>
          <p className="hint">Workers send these from their phone. You decide; they can cancel while it's pending.</p>
          <div className="stack">{pending.length ? pending.map((r) => (
            <div key={r.id} className="item"><div><b>{empOf(b, r.employee_id)?.name ?? '?'}</b> wants this shift off</div><small>{r.label} · {ago(r.created_at)}</small>
              {r.reason && <q>{r.reason}</q>}
              <div className="actions"><button className="btn small primary" onClick={() => decide(r, true)}>Approve &amp; find cover</button><button className="btn small" onClick={() => decide(r, false)}>Deny</button></div></div>
          )) : <p className="empty-note">No requests waiting.</p>}</div>
          {needCover.length > 0 && <><h4 style={{ margin: '12px 0 6px' }}>Approved, needs cover</h4><div className="stack">{needCover.map((r) => (
            <div key={r.id} className="item"><div><b>{r.label}</b> · {empOf(b, r.employee_id)?.name ?? '?'} is off</div>
              <div className="actions"><button className="btn small primary" onClick={() => setSheet({ type: 'cover', id: r.id })}>Who can cover?</button></div></div>))}</div></>}
        </section>
        <section className="panel">
          <div className="panel-head"><h2>Shifts owed</h2></div>
          <p className="hint">When someone covers in an emergency, it stays here until it's paid back, in any later week. Tap Pay back when you plan that week.</p>
          <div className="stack">{openOwed.length ? openOwed.map((l) => (
            <div key={l.id} className="item"><div><b>{empOf(b, l.debtor_id)?.name ?? '?'}</b> owes <b>{empOf(b, l.creditor_id)?.name ?? '?'}</b> 1 shift</div>
              <small>{empOf(b, l.creditor_id)?.name} covered {l.label}</small>
              <div className="actions"><button className="btn small primary" onClick={() => setSheet({ type: 'payback', id: l.id })}>Pay back</button>
                <button className="btn small" onClick={async () => { await supabase.from('ledger').update({ status: 'settled', settled_at: new Date().toISOString() }).eq('id', l.id); reload(); toast('Marked as settled.', 'ok', 'Done'); }}>Mark settled</button></div></div>
          )) : <p className="empty-note">Nobody owes a shift right now.</p>}</div>
        </section>
      </aside>
      <main className="boards">
        <div className="tabsrow end">
          <label className="namepick no-print">Names
            <select value={b.org.name_display ?? 'first'} onChange={async (e) => { const { error } = await supabase.from('organizations').update({ name_display: e.target.value }).eq('id', b.org.id); if (error) toast(errText(error), 'error', 'Not saved'); reload(); }} aria-label="How names show on the schedule">
              <option value="first">First name</option><option value="last">Last name</option><option value="first_initial">First name + last initial</option><option value="custom">Custom short name</option></select></label>
          <button className="btn small no-print" onClick={() => printBoards()} title="Print every location's schedule for this week"><PrintIcon /> Print all</button></div>
        {payDue.map((r) => <div key={r.location_id} className={`banner ${r.pending ? 'bad' : 'warn'} no-print`} style={{ marginBottom: 10 }}>
          <p><b>{r.pending ? `${r.name}: ${r.pending} payroll${r.pending > 1 ? 's' : ''} not marked paid.` : `${r.name} payday ${r.next_pay_date === todayIso() ? 'is today' : dateShort(r.next_pay_date)}.`}</b>{' '}
            {!r.next_paid && <>{rangeTitle(r.next_start, r.next_end)}: {money(r.payable)} for {r.employees} employee{r.employees === 1 ? '' : 's'}.</>}</p>
          <button className="btn small primary" onClick={() => { setPayLoc(r.location_id); setTab('payroll'); }}>Open payroll</button></div>)}
        {(() => { const p = planOf(b.org), lim = PLANS[p].locations; return lim !== null && b.locs.length > lim && <div className="banner warn no-print" style={{ marginBottom: 10 }}>
          <p><b>{(b.org.plan ?? 'free') !== 'free' && p === 'free' ? `Your ${PLANS[b.org.plan ?? 'free'].name} plan has ended.` : `You have ${b.locs.length} locations on the ${PLANS[p].name} plan.`}</b> Everything keeps working, but you can't add more locations until you choose a bigger plan.</p>
          <button className="btn small primary" onClick={() => nav('/app/plan')}>See plans</button></div>; })()}
        {emptyWeek && <div className="banner"><p><b>No shifts yet for {rangeTitle(week, addDays(week, 6))}.</b> {prevHas ? "Start from last week's schedule, then drag names to change it." : 'Drag names from the staff list into the shifts.'}</p>
          {prevHas && <button className="btn primary" onClick={copyLastWeek}>Copy last week</button>}</div>}
        <WeekGrid b={b} week={week} editable onCell={onCell} undoHint={undoHint} onUndo={doUndo} onEditLoc={(l) => setSheet({ type: 'loc', loc: l })}
          onClearWeek={(l) => { const ch: Changes = {}; for (const s of b.slots.filter((x) => x.location_id === l.id)) for (let d = 0; d < 7; d++) { const k = cellKey(s.id, addDays(week, d)); if (b.assign[k]) ch[k] = null; }
            commit(ch, `${l.name}: this week's schedule is cleared. Use Undo to bring it back.`); }} />
        <div className="actions no-print"><button className="btn" onClick={() => { const lim = PLANS[planOf(b.org)].locations; if (lim !== null && b.locs.length >= lim) nav('/app/plan?need=locations'); else setAdding(true); }}>+ Add a hotel, gas station or shop</button>
          {b.locs.length > 0 && <button className="btn danger" onClick={() => setSheet({ type: 'delloc' })}>Delete a location</button>}</div>
      </main>
    </div>
  );

  return (
    <>
      <AppBar subtitle={b.org.name} week={week} setWeek={setWeek} notes={notes} onNotes={() => setSheet({ type: 'notes' })}
        onAccount={() => nav('/app/account')} who={<>{b.org.owner_name || me!.email} · <b>Owner</b></>}
        nav={tabs}
        profile={<ProfileMenu name={b.org.owner_name || me!.email} role={`Owner · ${b.org.name}`} items={[
          { label: '⇄ Switch to worker view', hint: 'Your own shifts, clock in and out, time off, pay', onClick: () => goWorker(), primary: true },
          { label: 'Account settings', hint: 'Name, email, photo, password, time zone', onClick: () => nav('/app/account') },
          { label: 'Plan & billing', hint: `${PLANS[planOf(b.org)].name} plan · coupons`, onClick: () => nav('/app/plan') },
          { label: 'Payroll', hint: 'Paydays, payslips, history', onClick: () => setTab('payroll') },
          { label: 'Schedule', hint: rangeTitle(week, addDays(week, 6)), onClick: () => setTab('schedule') },
          { label: 'Time clock', hint: 'Who is on the clock, hour fixes', onClick: () => setTab('time') },
          { label: 'Shift swaps', hint: 'Swap any date and shift; pending, accepted, done', onClick: () => { setTab('time'); setTimeout(() => document.getElementById('swaps')?.scrollIntoView({ behavior: 'smooth' }), 80); } },
          { label: 'Shift reports', hint: 'The logbook your workers write', onClick: () => setTab('reports') },
          { label: 'Tasks', hint: 'Task lists for each shift', onClick: () => setTab('tasks') },
          { label: 'Add a worker', onClick: () => { setTab('schedule'); addWorker(); } },
          { label: 'Print this week', onClick: () => { setTab('schedule'); setTimeout(() => printBoards(), 50); } },
        ]} />} />
      <div className="wrap">{tab === 'schedule' ? schedule : tab === 'time' ? <TimeClock b={b} week={week} tabs={null} reload={reload} /> : tab === 'reports' ? <div className="layout"><ShiftReportsBook b={b} owner /></div> : tab === 'tasks' ? <div className="layout"><TasksBoard b={b} owner /><TaskManager b={b} /></div> : <Payroll b={b} tabs={null} reload={reload} initialLoc={payLoc} />}</div>
      {picked && empOf(b, picked) && <div className="pickbar"><span>Tap a shift to place <b>{empOf(b, picked)!.name}</b></span><button className="btn small" onClick={() => setPicked(null)}>Cancel</button></div>}
      {sheet && <OwnerSheet s={sheet} b={b} week={week} set={setSheet} commit={commit} reload={reload} notes={notes} reloadNotes={reloadNotes} decide={decide} signOut={signOut} preview={(id) => { setSheet(null); setPreviewEmp(id); }} goWorker={() => goWorker()} />}
    </>
  );
}

// ---------------------------------------------------------------- payroll

// ---------------------------------------------------------------- sheets

function OwnerSheet({ s, b, week, set, commit, reload, notes, reloadNotes, decide, signOut, preview, goWorker }: {
  s: NonNullable<SheetState>; b: Bundle; week: string; set: (s: SheetState) => void;
  commit: (c: Changes, msg: string, o?: { ledger?: Record<string, unknown>; settle?: string; allowOver?: boolean }) => Promise<boolean>;
  reload: () => Promise<void>; notes: ReturnType<typeof useNotes>['notes']; reloadNotes: () => void; decide: (r: Req, a: boolean) => void; signOut: () => Promise<void>; preview: (empId: string) => void; goWorker: () => void;
}) {
  const toast = useToast();
  const close = () => set(null);
  const slotCard = (k: string) => { const w = empOf(b, b.assign[k]); const sl = slotOf(b, k)!; const { date } = parseCell(k);
    const dow = DAY_LONG[(new Date(date + 'T00:00:00Z').getUTCDay() + 6) % 7];
    return (<div className="slotcard">{w ? <div className="chip" style={{ ['--h' as string]: w.hue }}>{w.name}</div> : <span className="tag bad">Open</span>}
      <div className="info"><b>{locName(b, sl.location_id)} · {shiftShort(sl.start_hour, sl.hours)}</b><span>{dow} {date.slice(5).replace('-', '/')} · {shiftLong(sl.start_hour, sl.hours)}</span></div></div>); };
  // Every upcoming shift of `other` that is loaded (about five weeks ahead); emergencies may go over the weekly limit.
  const tradeOptions = (k: string, other: string) => {
    const orig = b.assign[k];
    return keysOf(b, other).filter((o) => o !== k && parseCell(o).date >= todayIso()).map((o) => ({ o, r: evaluate(b, { [k]: other, [o]: orig }, { allowOver: true }) }));
  };

  if (s.type === 'cover') { const r = b.reqs.find((x) => x.id === s.id); return r ? <CoverSheet b={b} req={r} onClose={close} reload={reload} /> : null; }
  if (s.type === 'notes') return <NotesSheet notes={notes} onClose={close} reload={reloadNotes} render={(n) => {
    const r = n.request_id ? b.reqs.find((x) => x.id === n.request_id) : undefined;
    if (!r) return null;
    if (r.status === 'pending') return <div className="actions"><button className="btn small primary" onClick={() => { markNotesRead([n.id]); decide(r, true); }}>Approve &amp; find cover</button><button className="btn small" onClick={() => { markNotesRead([n.id]); decide(r, false); }}>Deny</button></div>;
    return <div><span className="tag plain">{r.status[0].toUpperCase() + r.status.slice(1)}</span></div>;
  }} />;


  if (s.type === 'shift') {
    if (!valid(b, s.key)) return null;
    const w = empOf(b, b.assign[s.key]);
    const rows = w ? [] : b.emps.map((x) => ({ x, r: evaluate(b, { [s.key]: x.id }, { allowOver: true }), n: countWeek(b, x.id, week) }))
      .sort((p, q) => (p.r.errors.length - q.r.errors.length) || (p.r.warnings.length - q.r.warnings.length) || (p.n - q.n) || p.x.name.localeCompare(q.x.name));
    return (
      <Sheet eyebrow="Shift" title={w ? w.name : 'Open shift'} onClose={close}>
        {slotCard(s.key)}
        {(() => { const { slot, date } = parseCell(s.key); const off = b.reqs.find((r) => r.status === 'approved' && r.slot_id === slot && r.work_date === date); if (!off) return null;
          return (<div className="banner warn"><p><b>{empOf(b, off.employee_id)?.name} has approved time off</b> for this shift. {off.covered_by ? `${empOf(b, off.covered_by)?.name} is covering it.` : 'Nobody is covering it yet.'}</p>
            {!off.covered_by && <button className="btn small primary" onClick={() => set({ type: 'cover', id: off.id })}>Who can cover?</button>}</div>); })()}
        {(() => { const sw = swapOf(b, s.key); if (!sw) return null; const o = empOf(b, sw.orig)?.name ?? 'someone', n = empOf(b, sw.now)?.name ?? 'someone';
          return (<div className="sec swapinfo"><h4>⇄ Swapped shift</h4>
            <p><b>{n}</b> works this shift instead of <b>{o}</b>.</p>
            <ul className="plain">
              <li>Original: {o}</li><li>Now: {n}</li>
              <li>{sw.a.kind === 'future_swap' ? `${o} asked ${n} to work it${sw.a.note ? ` (${sw.a.note})` : ''}; ${n} accepted` : sw.a.kind === 'payback' ? `${n} pays back a shift owed to ${o}${sw.a.note ? ` (${sw.a.note})` : ''}` : sw.a.kind === 'takeover' ? `${n} took it over at clock-in (given for good)` : `${n} covered it at clock-in as a swap`}</li>
              <li>Requested {new Date(sw.a.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}{sw.a.decided_at ? ` · accepted ${new Date(sw.a.decided_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''}</li>
            </ul></div>); })()}
        {w ? <div className="sec"><h4>{w.name} can't make it?</h4><p>Pick who takes this shift. You can trade one of their shifts back to {w.name} right away, or record it as owed.</p>
          <div className="actions"><button className="btn primary" onClick={() => set({ type: 'swap', key: s.key })}>Swap or find cover</button>
            <button className="btn" onClick={() => set({ type: 'profile', id: w.id })}>{w.name}'s profile</button>
            <button className="btn danger" onClick={() => commit({ [s.key]: null }, `${w.name} removed from ${slotLabel(b, s.key)}. The shift is open.`)}>Leave shift open</button></div></div>
          : <div className="sec"><h4>Who can take it</h4><p>Best fits first: no conflicts, then fewest shifts this week.</p><div className="list">
            {rows.length ? rows.map(({ x, r, n }) => <button key={x.id} className="row" disabled={r.errors.length > 0} onClick={async () => { if (await commit({ [s.key]: x.id }, `${x.name} now works ${slotLabel(b, s.key)}.`, { allowOver: true })) close(); }}>
              <span className="dot" style={{ ['--h' as string]: x.hue }} /><span className="main"><b>{x.name}</b><span>{n}/{x.max_shifts} shifts this week</span></span>{statusTag(r)}</button>) : <p className="empty-note">Add workers first.</p>}
          </div></div>}
      </Sheet>);
  }

  if (s.type === 'swap') {
    const orig = b.assign[s.key], ow = empOf(b, orig);
    if (!ow) return null;
    const rows = b.emps.filter((x) => x.id !== orig).map((x) => { const r = evaluate(b, { [s.key]: x.id }, { allowOver: true }); return { x, r, t: tradeOptions(s.key, x.id).filter((o) => !o.r.errors.length).length, n: countWeek(b, x.id, week) }; })
      .sort((p, q) => (Number(!!q.t || !q.r.errors.length) - Number(!!p.t || !p.r.errors.length)) || (p.r.errors.length - q.r.errors.length) || p.x.name.localeCompare(q.x.name));
    return (
      <Sheet eyebrow="Swap or cover" title={`Replace ${ow.name}`} onClose={close}>
        {slotCard(s.key)}
        <div className="sec"><h4>Who will take {ow.name}'s shift?</h4><p>"Can cover" means they can take it now, even as an extra shift over their weekly limit; {ow.name} pays it back later. The trade count is how many of their shifts {ow.name} could work in return right away.</p>
          <div className="list">{rows.map(({ x, r, t, n }) => { const can = !r.errors.length; return (
            <button key={x.id} className="row" disabled={!can && !t} onClick={() => set({ type: 'swap-with', key: s.key, other: x.id })}>
              <span className="dot" style={{ ['--h' as string]: x.hue }} /><span className="main"><b>{x.name}</b><span>{n}/{x.max_shifts} this week · {t} shift{t === 1 ? '' : 's'} to trade</span></span>
              {can ? (r.warnings.length ? <span className="tag warn">Can cover · {r.warnings[0].short}</span> : <span className="tag ok">Can cover</span>) : <span className="tag bad">{r.errors[0].short}</span>}</button>); })}</div></div>
      </Sheet>);
  }

  if (s.type === 'swap-with') {
    const orig = b.assign[s.key], ow = empOf(b, orig), xw = empOf(b, s.other);
    if (!ow || !xw) return null;
    const cover = evaluate(b, { [s.key]: xw.id }, { allowOver: true });
    const opts = tradeOptions(s.key, xw.id);
    const bestTrade = cover.errors.length > 0;
    const sl = slotOf(b, s.key)!;
    // If the coverer already owes this worker a shift, covering now pays that back instead of starting a new debt.
    const evens = b.ledger.find((l) => l.status === 'open' && l.debtor_id === xw.id && l.creditor_id === ow.id);
    const extra = cover.warnings.some((w) => w.short.startsWith('Extra shift'));
    return (
      <Sheet eyebrow={`Replace ${ow.name}`} title={`With ${xw.name}`} onClose={close}>
        {slotCard(s.key)}
        <div className={`option${bestTrade ? '' : ' best'}`}><h4>{xw.name} covers now{evens ? `, and they're even` : `, ${ow.name} pays back later`}</h4>
          <p>{evens ? `${xw.name} owed ${ow.name} a shift (${evens.label}). Covering this one pays it back.`
            : <>{xw.name} takes this shift{extra ? ' as an extra shift' : ''}. It goes on the <b>Shifts owed</b> list as "{ow.name} owes {xw.name} 1 shift". You don't have to decide the payback now: when you plan a later week, tap <b>Pay back</b> and pick any of {xw.name}'s shifts for {ow.name} to work.</>}</p>
          {cover.errors.length ? <div className="reason bad">{cover.errors[0].msg}</div> : cover.warnings.map((w) => <div key={w.msg} className="reason warn">{w.msg}</div>)}
          <div><button className={`btn${bestTrade ? '' : ' primary'}`} disabled={cover.errors.length > 0} onClick={async () => {
            const ok = evens
              ? await commit({ [s.key]: xw.id }, `${xw.name} covers ${slotLabel(b, s.key)}. ${xw.name} and ${ow.name} are even now.`, { settle: evens.id, allowOver: true })
              : await commit({ [s.key]: xw.id }, `${xw.name} covers ${slotLabel(b, s.key)}. ${ow.name} owes ${xw.name} 1 shift.`,
                { ledger: { org_id: b.org.id, debtor_id: ow.id, creditor_id: xw.id, slot_id: sl.id, work_date: parseCell(s.key).date, label: slotLabel(b, s.key) }, allowOver: true });
            if (ok) close();
          }}>{xw.name} covers this shift{extra ? ' (extra shift)' : ''}</button></div></div>
        {!evens && <div className="option"><h4>Or {ow.name} gives it away: nothing owed</h4>
          <p>{xw.name} keeps this shift for good and is paid for it{extra ? ' as an extra shift' : ''}. {ow.name} doesn't owe anything and works one shift less.</p>
          <div><button className="btn" disabled={cover.errors.length > 0} onClick={async () => {
            if (await commit({ [s.key]: xw.id }, `${xw.name} takes ${slotLabel(b, s.key)} for good. Nothing owed.`, { allowOver: true })) close();
          }}>{xw.name} takes it, no payback</button></div></div>}
        <div className={`option${bestTrade ? ' best' : ''}`}><h4>Or trade right away: {ow.name} takes one of {xw.name}'s shifts</h4>
          <p>Pick the shift {ow.name} will work instead. Both keep the same number of shifts. Later weeks show up here once they're scheduled.</p>
          <div className="list">{opts.length ? opts.map(({ o, r }) => (
            <button key={o} className="row" disabled={r.errors.length > 0} onClick={async () => { if (await commit({ [s.key]: xw.id, [o]: ow.id }, `Traded. ${xw.name} works ${slotLabel(b, s.key)} and ${ow.name} works ${slotLabel(b, o)}.`, { allowOver: true })) close(); }}>
              <span className="main"><b>{slotLabel(b, o)}</b><span className={r.errors.length ? 'reason bad' : r.warnings.length ? 'reason warn' : ''}>{r.errors[0]?.msg ?? r.warnings[0]?.msg ?? `${ow.name} works this, ${xw.name} gets ${slotLabel(b, s.key)}`}</span></span>
              {r.errors.length ? <span className="tag bad">No</span> : <span className={`tag ${r.warnings.length ? 'warn' : 'ok'}`}>Trade</span>}</button>))
            : <p className="empty-note">{xw.name} has no upcoming shifts scheduled yet. Use "covers now" above and pay it back later.</p>}</div></div>
        <div><button className="btn" onClick={() => set({ type: 'swap', key: s.key })}>‹ Pick someone else</button></div>
      </Sheet>);
  }

  if (s.type === 'payback') {
    const l = b.ledger.find((x) => x.id === s.id); if (!l) return null;
    const d = empOf(b, l.debtor_id), c = empOf(b, l.creditor_id); if (!d || !c) return null;
    const opts = keysOf(b, c.id).filter((k) => parseCell(k).date > l.work_date && parseCell(k).date >= todayIso()).map((k) => ({ k, r: evaluate(b, { [k]: d.id }, { allowOver: true }) }));
    return (
      <Sheet eyebrow="Pay back" title={`${d.name} owes ${c.name}`} onClose={close}>
        <div className="sec"><p>{c.name} covered {d.name}'s {l.label}. Pick one of {c.name}'s scheduled shifts below, or any future date and shift. If {d.name} later covers one of {c.name}'s shifts, that also settles it automatically.</p></div>
        <div className="list">{opts.length ? opts.map(({ k, r }) => (
          <button key={k} className="row" disabled={r.errors.length > 0} onClick={async () => { if (await commit({ [k]: d.id }, `${d.name} works ${slotLabel(b, k)} for ${c.name}. They're even.`, { settle: l.id, allowOver: true })) close(); }}>
            <span className="main"><b>{slotLabel(b, k)}</b><span className={r.errors.length ? 'reason bad' : r.warnings.length ? 'reason warn' : ''}>{r.errors[0]?.msg ?? r.warnings[0]?.msg ?? `${d.name} works it, ${c.name} gets the shift off`}</span></span>{statusTag(r)}</button>))
          : <p className="empty-note">{c.name} has no scheduled shifts after that date yet.</p>}</div>
        <PaybackPicker b={b} ledgerId={l.id} owner onDone={async () => { await reload(); close(); }} />
        <div className="actions"><button className="btn" onClick={async () => { await supabase.from('ledger').update({ status: 'settled', settled_at: new Date().toISOString() }).eq('id', l.id); await reload(); close(); toast('Marked as settled.', 'ok', 'Done'); }}>Mark settled without a shift</button></div>
      </Sheet>);
  }

  if (s.type === 'profile') return <ProfileSheet b={b} week={week} id={s.id} onClose={close} reload={reload} onPreview={() => preview(s.id)} />;

  if (s.type === 'loc') return <LocSheet b={b} loc={s.loc} onClose={close} reload={reload} />;
  if (s.type === 'delloc') return (
    <Sheet eyebrow="Locations" title="Delete a location" onClose={close}>
      <div className="sec"><p>Deleting a location removes its shifts and its whole schedule, including past weeks. Workers stay in your staff list. This can't be undone.</p></div>
      <div className="list">{b.locs.map((l) => { const n = Object.keys(b.assign).filter((k) => b.slots.find((x) => x.id === parseCell(k).slot)?.location_id === l.id).length;
        return (<div key={l.id} className="row"><span className="main"><b>{l.name}</b><span>{TYPE_LABEL[l.type] ?? 'Location'} · {n} shift{n === 1 ? '' : 's'} on the schedule</span></span>
          <ConfirmButton className="btn small danger" label="Delete" confirmLabel={`Click again to delete ${l.name}`} onConfirm={async () => {
            const { error } = await supabase.from('locations').delete().eq('id', l.id);
            if (error) return toast(errText(error), 'error', "Couldn't delete");
            toast(`${l.name} deleted.`, 'warn', 'Deleted'); close(); reload();
          }} /></div>); })}</div>
    </Sheet>);
  return null;
}

function ProfileSheet({ b, week, id, onClose, reload, onPreview }: { b: Bundle; week: string; id: string; onClose: () => void; reload: () => Promise<void>; onPreview: () => void }) {
  const toast = useToast();
  const { me, refresh } = useAuth();
  const w = empOf(b, id);
  const others = b.emps.filter((x) => !x.user_id);
  const [f, setF] = useState(() => ({ name: w?.name ?? '', short: w?.short_name ?? '', email: w?.email ?? '', phone: w?.phone ?? '', max: w?.max_shifts ?? 5, rate: w?.rate ?? 0 }));
  const [busy, setBusy] = useState(false);
  const dirty = useMemo(() => w && (f.name !== w.name || f.short !== (w.short_name ?? '') || f.email !== (w.email ?? '') || f.phone !== (w.phone ?? '') || f.max !== w.max_shifts || f.rate !== w.rate), [f, w]);
  if (!w) return null;
  const n = countWeek(b, w.id, week);
  const mine = keysOf(b, w.id).filter((k) => parseCell(k).date >= week && parseCell(k).date < addDays(week, 7));
  const pay = payFor(b, w, periodOf(b.org, week));

  const save = async () => {
    if (f.email && !/^\S+@\S+\.\S+$/.test(f.email.trim())) return toast('That email looks wrong. Check it and try again.', 'error', 'Not saved');
    setBusy(true);
    const { error } = await supabase.from('employees').update({ name: f.name.trim() || 'Unnamed', short_name: f.short.trim().slice(0, 20) || null, email: f.email.trim() || null, phone: f.phone.trim() || null, max_shifts: Math.max(1, Math.min(21, f.max)), rate: Math.max(0, f.rate) }).eq('id', w.id);
    setBusy(false);
    if (error) return toast(errText(error), 'error', 'Not saved');
    if (f.max < n) toast(`${f.name} already has ${n} shifts this week, more than the new limit of ${f.max}.`, 'warn', 'Over the limit'); else toast('Profile saved.', 'ok', 'Saved');
    reload();
  };
  const toggleLoc = async (locId: string, on: boolean) => {
    const q = on ? supabase.from('employee_locations').insert({ employee_id: w.id, location_id: locId }) : supabase.from('employee_locations').delete().eq('employee_id', w.id).eq('location_id', locId);
    const { error } = await q; if (error) toast(errText(error), 'error', 'Not saved'); reload();
  };
  const invite = async () => {
    if (dirty) await save();
    if (!(f.email || w.email)) return toast('Add an email address first, then save.', 'error', "Can't send");
    setBusy(true);
    try {
      const r = await sendInvite(w.id);
      toast(r === 'reset' ? `Password reset link sent to ${f.email || w.email}.` : r === 'linked' ? `${w.name} already has a SplitYourShift login. They can log in now with their password.` : `Invite sent to ${f.email || w.email}. The link works for 24 hours.`, 'ok', 'Sent');
    } catch (e) { toast(errText(e), 'error', "Couldn't send"); }
    setBusy(false); reload();
  };

  return (
    <Sheet eyebrow="Worker profile" title={w.name} onClose={onClose}>
      <div className="twocol">
        <div className="field"><label htmlFor="pf-name">Full name</label><input type="text" id="pf-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
        <div className="field"><label htmlFor="pf-short">Short name on the schedule</label><input type="text" id="pf-short" maxLength={20} value={f.short} onChange={(e) => setF({ ...f, short: e.target.value })} placeholder={w ? shortName({ ...b, org: { ...b.org, name_display: 'first' } }, w) : ''} />
          <span className="hint">{(b.org.name_display ?? 'first') === 'custom' ? 'Shown on the schedule.' : 'Used when the schedule shows custom short names.'}</span></div>
      </div>
      <div className="twocol">
        <div className="field"><label htmlFor="pf-email">Email (invite and log-in)</label><input type="email" id="pf-email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder="name@email.com" /></div>
        <div className="field"><label htmlFor="pf-phone">Phone (log-in)</label><input type="tel" id="pf-phone" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="(555) 123-4567" /></div>
      </div>
      <div className="twocol">
        <div className="field"><label htmlFor="pf-max">Max shifts per week</label><input type="number" id="pf-max" min={1} max={21} value={f.max} onChange={(e) => setF({ ...f, max: +e.target.value || 1 })} /></div>
        <div className="field"><label htmlFor="pf-rate">Hourly rate ($)</label><input type="number" id="pf-rate" min={0} step={0.25} value={f.rate} onChange={(e) => setF({ ...f, rate: +e.target.value || 0 })} /></div>
      </div>
      <div className="actions"><button className="btn primary" disabled={!dirty || busy} onClick={save}>Save changes</button></div>
      <fieldset className="field"><legend>Works at</legend><div className="checks">
        {b.locs.map((l) => <label key={l.id}><input type="checkbox" checked={w.locs.includes(l.id)} onChange={(e) => toggleLoc(l.id, e.target.checked)} /> {l.name}</label>)}</div></fieldset>
      {w.user_id === me?.userId ? <div className="sec"><h4>Login</h4><p>This is you. You log in with your owner account; tap your photo at the top right, then <b>Switch to worker view</b>, to clock in and out.</p>
        {others.length > 0 && <details><summary>Already on the list under another name?</summary>
          <p>Pick that worker and your worker view will use it (with its shifts) instead of this one.</p>
          <div className="actions">{others.map((x) => <button key={x.id} className="btn small" disabled={busy} onClick={async () => {
            setBusy(true); try { await myWorkerProfile(b.org.id, x.id); await refresh(); toast(`Your worker view now uses ${x.name}. You can delete ${w.name} if you don't need it.`, 'ok', 'Linked'); onClose(); reload(); } catch (e) { toast(errText(e), 'error', "Couldn't link"); } setBusy(false);
          }}>That's me: {x.name}</button>)}</div></details>}</div> : <>
      <div className="sec"><h4>Login <StatusTag s={w.status} /></h4>
        <p>{w.status === 'active' ? `${w.name} logs in with their email${w.phone ? ' or phone' : ''} and their own password.`
          : w.status === 'invited' ? `Invite sent ${w.invited_at ? ago(w.invited_at) : ''}. The link works for 24 hours.`
          : w.status === 'expired' ? 'The invite link expired. Send a new one.' : 'Send an invite so they can see their shifts and pay. They choose their own password.'}</p>
        <div className="actions"><button className={`btn small${w.status === 'active' ? '' : ' primary'}`} disabled={busy} onClick={invite}>
          {w.status === 'active' ? 'Send password reset link' : w.status === 'none' ? 'Send invite' : 'Resend invite'}</button></div></div>
      </>}
      <div className="sec"><h4>Week of {rangeTitle(week, addDays(week, 6))} <span className={`count ${countClass(n, w.max_shifts)}`}>{n}/{w.max_shifts}</span></h4>
        {mine.length ? <><ul className="plain">{mine.map((k) => <li key={k}>{slotLabel(b, k)}</li>)}</ul><p style={{ marginTop: 6 }}>{hoursWeek(b, w.id, week)} hours</p></> : <p>No shifts this week.</p>}</div>
      <div className="sec"><h4>Pay history</h4><PayslipList business={b.org.name} empId={w.id} limit={4} /></div>
      <div className="sec"><h4>Pay this period</h4><p>{pay.hours} hours × {money(pay.rate)}{pay.ot ? ` + ${pay.ot} h overtime` : ''} = <b>{money(pay.gross)}</b></p></div>
      <div className="sec"><h4>Availability <span className="hint">(set by {w.name})</span></h4><ul className="plain">{w.avail.map((a) => <li key={a.dow}>{DAY_LONG[a.dow].slice(0, 3)} · {availText(a)}</li>)}</ul></div>
      <div className="actions"><button className="btn" onClick={onPreview}>See what {w.name} sees</button>
        <ConfirmButton label="Delete worker" confirmLabel={`Click again to delete ${w.name}`} onConfirm={async () => {
        const { error } = await supabase.from('employees').delete().eq('id', w.id);
        if (error) return toast(errText(error), 'error', "Couldn't delete");
        toast(`${w.name} deleted. Their shifts are now open.`, 'warn', 'Deleted'); onClose(); reload();
      }} /></div>
    </Sheet>
  );
}

function LocSheet({ b, loc, onClose, reload }: { b: Bundle; loc: Loc; onClose: () => void; reload: () => Promise<void> }) {
  const toast = useToast();
  const current = b.slots.filter((s) => s.location_id === loc.id).sort((x, y) => x.start_hour - y.start_hour);
  const [name, setName] = useState(loc.name);
  const [rows, setRows] = useState<Row[]>(current.map((s) => ({ id: s.id, start_hour: s.start_hour, hours: s.hours })));
  const removed = current.filter((s) => !rows.some((r) => r.id === s.id));
  const lost = Object.keys(b.assign).filter((k) => removed.some((s) => s.id === parseCell(k).slot)).length;
  const save = async () => {
    if (!rows.length) return toast('Keep at least one shift.', 'error', "Can't save");
    try {
      if (name.trim() && name !== loc.name) await supabase.from('locations').update({ name: name.trim() }).eq('id', loc.id);
      for (const s of removed) await supabase.from('shift_slots').delete().eq('id', s.id);
      for (const [i, r] of rows.entries()) {
        const { error } = r.id ? await supabase.from('shift_slots').update({ start_hour: r.start_hour, hours: r.hours, sort: i }).eq('id', r.id)
          : await supabase.from('shift_slots').insert({ org_id: b.org.id, location_id: loc.id, start_hour: r.start_hour, hours: r.hours, sort: i });
        if (error) throw error;
      }
      toast(`${name} shifts saved.`, 'ok', 'Saved'); onClose(); reload();
    } catch (e) { toast(errText(e), 'error', "Couldn't save"); }
  };
  return (
    <Sheet eyebrow={TYPE_LABEL[loc.type] ?? 'Location'} title={`Edit ${loc.name}`} onClose={onClose}>
      <div className="field"><label htmlFor="le-name">Name</label><input type="text" id="le-name" value={name} onChange={(e) => setName(e.target.value)} /></div>
      <div className="sec"><h4>Shifts</h4><p>Changing a shift's time keeps the people already in it. Removing a shift clears its row.</p><ShiftEditor idPrefix="le" rows={rows} onChange={setRows} /></div>
      {lost > 0 && <div className="reason warn">Removing {removed.length} shift{removed.length > 1 ? 's' : ''} will clear {lost} scheduled shift{lost > 1 ? 's' : ''}.</div>}
      <div className="actions"><button className="btn primary" onClick={save}>Save shifts</button><button className="btn" onClick={onClose}>Cancel</button>
        <ConfirmButton label="Delete location" confirmLabel={`Click again to delete ${loc.name}`} onConfirm={async () => {
          const { error } = await supabase.from('locations').delete().eq('id', loc.id);
          if (error) return toast(errText(error), 'error', "Couldn't delete");
          toast(`${loc.name} deleted.`, 'warn', 'Deleted'); onClose(); reload();
        }} /></div>
    </Sheet>
  );
}



