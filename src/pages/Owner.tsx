import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../App';
import { supabase, errText } from '../lib/supabase';
import { applyChanges, loadBundle, markNotesRead, sendInvite } from '../lib/api';
import { DAY_LONG, addDays, ago, mondayOf, money, rangeTitle, shiftLong, shiftShort, todayIso } from '../lib/time';
import {
  HUES, TYPE_LABEL, absStart, availText, cellKey, countWeek, empOf, evaluate, hoursWeek, keysOf, locName, parseCell, payFor, periodOf,
  slotLabel, slotOf, valid, type Changes, type Result, type Row,
} from '../lib/rules';
import type { Bundle, Emp, LedgerRow, Loc, Req } from '../lib/types';
import { ConfirmButton, Loading, Sheet, StatusTag, useToast } from '../components/ui';
import { PrintIcon, WeekGrid, printBoards, useDragDrop } from '../components/WeekGrid';
import { ShiftEditor } from '../components/ShiftEditor';
import { AppBar, NotesSheet, useNotes } from './AppShell';
import Onboarding from './Onboarding';
import TimeClock from './OwnerTime';
import WorkerApp from './Worker';

type SheetState =
  | { type: 'shift'; key: string } | { type: 'swap'; key: string } | { type: 'swap-with'; key: string; other: string }
  | { type: 'payback'; id: string } | { type: 'profile'; id: string } | { type: 'loc'; loc: Loc }
  | { type: 'notes' } | { type: 'account' } | null;

const countClass = (n: number, max: number) => (n > max ? 'over' : n === max ? 'full' : '');
const statusTag = (r: Result) => r.errors.length ? <span className="tag bad">{r.errors[0].short}</span>
  : r.warnings.length ? <span className="tag warn">{r.warnings[0].short}</span> : <span className="tag ok">Works</span>;

export default function OwnerApp() {
  const { me, signOut } = useAuth();
  const toast = useToast();
  const [week, setWeek] = useState(() => mondayOf(todayIso()));
  const [b, setB] = useState<Bundle | null>(null);
  const [tab, setTab] = useState<'schedule' | 'time' | 'payroll'>('schedule');
  const [sheet, setSheet] = useState<SheetState>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [previewEmp, setPreviewEmp] = useState<string | null>(null);
  const undo = useRef<{ changes: Changes; ledgerId?: string }[]>([]);
  const { notes, reload: reloadNotes } = useNotes();
  const orgId = me!.orgId!;

  const reload = useCallback(async () => {
    try { setB(await loadBundle(orgId, week, true)); } catch (e) { toast(errText(e), 'error', "Couldn't load"); }
  }, [orgId, week, toast]);
  useEffect(() => { reload(); }, [reload]);
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
  const commit = useCallback(async (changes: Changes, message: string, opts: { ledger?: Record<string, unknown>; settle?: string; skipUndo?: boolean; shakeKey?: string } = {}) => {
    if (!b) return false;
    const r = evaluate(b, changes);
    if (r.errors.length) {
      toast(r.errors[0].msg, 'error', "Can't do that");
      if (opts.shakeKey) { const td = document.querySelector(`td[data-cell="${opts.shakeKey}"]`); td?.classList.remove('shake'); void (td as HTMLElement | null)?.offsetWidth; td?.classList.add('shake'); }
      return false;
    }
    const inverse: Changes = {};
    for (const k in changes) inverse[k] = b.assign[k] ?? null;
    setB((prev) => { if (!prev) return prev; const a = { ...prev.assign }; for (const k in changes) { const v = changes[k]; if (v) a[k] = v; else delete a[k]; } return { ...prev, assign: a }; });
    try {
      await applyChanges(orgId, changes);
      let ledgerId: string | undefined;
      if (opts.ledger) { const { data } = await supabase.from('ledger').insert(opts.ledger).select('id').single(); ledgerId = data?.id; }
      if (opts.settle) await supabase.from('ledger').update({ status: 'settled', settled_at: new Date().toISOString() }).eq('id', opts.settle);
      if (!opts.skipUndo) { undo.current.push({ changes: inverse, ledgerId }); if (undo.current.length > 40) undo.current.shift(); }
      if (r.warnings.length) toast(`${message} ${r.warnings.map((w) => w.msg).join(' ')}`, 'warn', 'Done, check this'); else toast(message, 'ok', 'Done');
      reload();
      return true;
    } catch (e) {
      toast(errText(e), 'error', "Can't do that");
      reload();
      return false;
    }
  }, [b, orgId, reload, toast]);

  const doUndo = async () => {
    const last = undo.current.pop(); if (!last) return;
    if (last.ledgerId) await supabase.from('ledger').delete().eq('id', last.ledgerId);
    await commit(last.changes, 'Last change undone.', { skipUndo: true });
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

  if (!b) return <Loading />;
  if (previewEmp) return <WorkerApp preview={{ orgId, empId: previewEmp, onExit: () => { setPreviewEmp(null); reload(); } }} />;
  if (adding) return (
    <><AppBar subtitle={b.org.name} onAccount={() => setSheet({ type: 'account' })} who={<>{b.org.owner_name || me!.email} · <b>Owner</b></>} />
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
    if (approve && r.slot_id && b.assign[cellKey(r.slot_id, r.work_date)] === r.employee_id) {
      setSheet({ type: 'swap', key: cellKey(r.slot_id, r.work_date) });
      toast(`Approved. Now pick who works ${r.label}.`, 'ok', 'Approved');
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
  const onClock = b.entries.filter((e) => !e.clock_out).length, fixCount = b.fixes.filter((f) => f.status === 'pending').length;
  const tabs = <div className="subtabs">{(['schedule', 'time', 'payroll'] as const).map((t) => <button key={t} className={`btn small${tab === t ? ' primary' : ''}`} onClick={() => setTab(t)}>
    {t === 'schedule' ? 'Schedule' : t === 'time' ? <>Time clock{onClock > 0 && <span className="lamp on" style={{ width: 9, height: 9 }} />}{fixCount > 0 && <span className="badge">{fixCount}</span>}</> : 'Payroll'}</button>)}</div>;

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
                <span className="dot" /><span className="wname">{w.name}</span>{b.entries.some((e) => e.employee_id === w.id && !e.clock_out) && <span className="lamp on" title={`${w.name} is on the clock`} aria-label="On the clock" />}
                {w.status !== 'active' && <span className={`lstat ${w.status}`}>{w.status === 'invited' ? 'invited' : w.status === 'expired' ? 'expired' : 'no login'}</span>}
                <span className={`count ${countClass(n, w.max_shifts)}`}>{n}/{w.max_shifts}</span>
                <button className="mini" onClick={() => setSheet({ type: 'profile', id: w.id })} aria-label={`Open ${w.name}'s profile`}>Profile</button>
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
        </section>
        <section className="panel">
          <div className="panel-head"><h2>Shifts owed</h2></div>
          <p className="hint">When someone covers without trading back, it is kept here so it can be paid back later.</p>
          <div className="stack">{openOwed.length ? openOwed.map((l) => (
            <div key={l.id} className="item"><div><b>{empOf(b, l.debtor_id)?.name ?? '?'}</b> owes <b>{empOf(b, l.creditor_id)?.name ?? '?'}</b> 1 shift</div>
              <small>{empOf(b, l.creditor_id)?.name} covered {l.label}</small>
              <div className="actions"><button className="btn small primary" onClick={() => setSheet({ type: 'payback', id: l.id })}>Pay back</button>
                <button className="btn small" onClick={async () => { await supabase.from('ledger').update({ status: 'settled', settled_at: new Date().toISOString() }).eq('id', l.id); reload(); toast('Marked as settled.', 'ok', 'Done'); }}>Mark settled</button></div></div>
          )) : <p className="empty-note">Nobody owes a shift right now.</p>}</div>
        </section>
      </aside>
      <main className="boards">
        {tabs}
        {emptyWeek && <div className="banner"><p><b>No shifts yet for {rangeTitle(week, addDays(week, 6))}.</b> {prevHas ? "Start from last week's schedule, then drag names to change it." : 'Drag names from the staff list into the shifts.'}</p>
          {prevHas && <button className="btn primary" onClick={copyLastWeek}>Copy last week</button>}</div>}
        <WeekGrid b={b} week={week} editable onCell={onCell} onEditLoc={(l) => setSheet({ type: 'loc', loc: l })} />
        <div className="actions no-print"><button className="btn" onClick={() => setAdding(true)}>+ Add a hotel, gas station or shop</button>
          {b.locs.length > 1 && <button className="btn" onClick={() => printBoards()}><PrintIcon /> Print all locations</button>}</div>
      </main>
    </div>
  );

  return (
    <>
      <AppBar subtitle={b.org.name} week={week} setWeek={setWeek} notes={notes} onNotes={() => setSheet({ type: 'notes' })}
        onAccount={() => setSheet({ type: 'account' })} who={<>{b.org.owner_name || me!.email} · <b>Owner</b></>}
        extra={<button className="btn" onClick={doUndo} disabled={!undo.current.length}>↶ Undo</button>} />
      <div className="wrap">{tab === 'schedule' ? schedule : tab === 'time' ? <TimeClock b={b} week={week} tabs={tabs} reload={reload} /> : <Payroll b={b} week={week} tabs={tabs} reload={reload} />}</div>
      {picked && empOf(b, picked) && <div className="pickbar"><span>Tap a shift to place <b>{empOf(b, picked)!.name}</b></span><button className="btn small" onClick={() => setPicked(null)}>Cancel</button></div>}
      {sheet && <OwnerSheet s={sheet} b={b} week={week} set={setSheet} commit={commit} reload={reload} notes={notes} reloadNotes={reloadNotes} decide={decide} signOut={signOut} preview={(id) => { setSheet(null); setPreviewEmp(id); }} />}
    </>
  );
}

// ---------------------------------------------------------------- payroll

function Payroll({ b, week, tabs, reload }: { b: Bundle; week: string; tabs: React.ReactNode; reload: () => void }) {
  const toast = useToast();
  const weeks = periodOf(b.org, week);
  const rows = [...b.emps].sort((x, y) => x.name.localeCompare(y.name)).map((w) => ({ w, p: payFor(b, w, weeks) }));
  const tot = rows.reduce((t, { p }) => ({ hours: t.hours + p.hours, sched: t.sched + p.sched, ot: t.ot + p.ot, gross: t.gross + p.gross, covers: t.covers + p.covers, coverPay: t.coverPay + p.coverPay, open: t.open + p.open }), { hours: 0, sched: 0, ot: 0, gross: 0, covers: 0, coverPay: 0, open: 0 });
  const saveOrg = async (patch: Record<string, unknown>) => { const { error } = await supabase.from('organizations').update(patch).eq('id', b.org.id); if (error) toast(errText(error), 'error', 'Not saved'); reload(); };
  const saveRate = async (id: string, v: string) => { const n = Math.round(parseFloat(v) * 100) / 100; if (!(n >= 0 && n < 1000)) return; await supabase.from('employees').update({ rate: n }).eq('id', id); reload(); };
  return (
    <div className="layout">{tabs}
      <section className="panel">
        <div className="panel-head"><h2>Payroll · {rangeTitle(weeks[0], addDays(weeks[weeks.length - 1], 6))}</h2><span className="tag plain">{b.org.pay_period === 'biweekly' ? 'Every 2 weeks' : 'Every week'}</span></div>
        <p className="hint">Gross pay from clocked hours (clock in to clock out), before taxes and deductions. Shifts without a clock-out aren't paid until they're fixed in Time clock. Change hourly rates right in the table; use ‹ › at the top to move between pay periods.</p>
        <div className="twocol" style={{ marginBottom: 12 }}>
          <div className="field"><label htmlFor="pay-period">Pay schedule</label>
            <select id="pay-period" value={b.org.pay_period} onChange={(e) => saveOrg({ pay_period: e.target.value, pay_anchor: weeks[0] })}><option value="weekly">Weekly</option><option value="biweekly">Every 2 weeks (biweekly)</option></select></div>
          <div className="field"><span style={{ fontSize: 13, fontWeight: 600, color: 'var(--muted)' }}>Overtime</span>
            <label className="checks" style={{ minHeight: 40, alignItems: 'center' }}><span style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={b.org.overtime} onChange={(e) => saveOrg({ overtime: e.target.checked })} /> Pay 1.5× after 40 hours in a week</span></label></div>
        </div>
        <div className="tiles" style={{ marginBottom: 14 }}>
          <div className="tile"><div className="k">Total gross pay</div><div className="v">{money(tot.gross)}</div><div className="s">{rows.length} workers</div></div>
          <div className="tile"><div className="k">Hours worked</div><div className="v">{Math.round(tot.hours * 100) / 100}</div><div className="s">{tot.sched} scheduled · {tot.ot ? `${Math.round(tot.ot * 100) / 100} overtime` : 'no overtime'}</div></div>
          <div className="tile"><div className="k">Still clocked in</div><div className="v">{tot.open}</div><div className="s">{tot.open ? 'not paid until they clock out' : 'everyone is clocked out'}</div></div>
          <div className="tile"><div className="k">Extra shifts (covers)</div><div className="v">{tot.covers}</div><div className="s">{money(tot.coverPay)} included in totals</div></div>
        </div>
        <div className="table-wrap"><table className="data"><thead><tr><th>Worker</th><th>Hourly rate</th><th className="num">Scheduled</th><th className="num">Worked</th><th className="num">Overtime</th><th className="num">Covered for others</th><th className="num">Gross pay</th></tr></thead>
          <tbody>{rows.map(({ w, p }) => (
            <tr key={w.id}><td><span className="dot" style={{ ['--h' as string]: w.hue, display: 'inline-block', marginRight: 6 }} />{w.name}</td>
              <td><span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>$<input type="number" min={0} max={999} step={0.25} defaultValue={w.rate} key={`${w.id}-${w.rate}`} aria-label={`${w.name} hourly rate`}
                onBlur={(e) => { if (+e.target.value !== w.rate) saveRate(w.id, e.target.value); }}
                style={{ width: 84, minHeight: 32, border: '1px solid var(--line-strong)', borderRadius: 6, padding: '4px 6px', background: 'var(--surface)' }} /></span></td>
              <td className="num">{p.sched} h<div className="hint" style={{ margin: 0 }}>{p.shifts} shifts</div></td><td className="num">{p.hours} h{weeks.length > 1 && <div className="hint" style={{ margin: 0 }}>{p.perWeek.join(' + ')}</div>}{p.open > 0 && <div><span className="tag warn">On the clock</span></div>}</td>
              <td className="num">{p.ot ? <span className="tag warn">{p.ot} h</span> : '—'}</td>
              <td className="num">{p.covers ? `${p.covers} · ${money(p.coverPay)}` : '—'}</td><td className="num"><b>{money(p.gross)}</b></td></tr>))}</tbody>
          <tfoot><tr><td><b>Total</b></td><td /><td className="num">{tot.sched} h</td><td className="num"><b>{Math.round(tot.hours * 100) / 100} h</b></td><td className="num">{tot.ot || '—'}</td><td className="num">{tot.covers ? money(tot.coverPay) : '—'}</td><td className="num"><b>{money(tot.gross)}</b></td></tr></tfoot></table></div>
        <p className="hint" style={{ marginTop: 10 }}>"Covered for others" are shifts this person took for a coworker without a trade. They're already in the hours and pay. Trades don't change pay because both people keep the same hours.</p>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- sheets

function OwnerSheet({ s, b, week, set, commit, reload, notes, reloadNotes, decide, signOut, preview }: {
  s: NonNullable<SheetState>; b: Bundle; week: string; set: (s: SheetState) => void;
  commit: (c: Changes, msg: string, o?: { ledger?: Record<string, unknown>; settle?: string }) => Promise<boolean>;
  reload: () => Promise<void>; notes: ReturnType<typeof useNotes>['notes']; reloadNotes: () => void; decide: (r: Req, a: boolean) => void; signOut: () => Promise<void>; preview: (empId: string) => void;
}) {
  const toast = useToast();
  const close = () => set(null);
  const slotCard = (k: string) => { const w = empOf(b, b.assign[k]); const sl = slotOf(b, k)!; const { date } = parseCell(k);
    const dow = DAY_LONG[(new Date(date + 'T00:00:00Z').getUTCDay() + 6) % 7];
    return (<div className="slotcard">{w ? <div className="chip" style={{ ['--h' as string]: w.hue }}>{w.name}</div> : <span className="tag bad">Open</span>}
      <div className="info"><b>{locName(b, sl.location_id)} · {shiftShort(sl.start_hour, sl.hours)}</b><span>{dow} {date.slice(5).replace('-', '/')} · {shiftLong(sl.start_hour, sl.hours)}</span></div></div>); };
  const tradeOptions = (k: string, other: string) => {
    const orig = b.assign[k]; const from = week, until = addDays(week, 21);
    return keysOf(b, other).filter((o) => o !== k && parseCell(o).date >= from && parseCell(o).date < until).map((o) => ({ o, r: evaluate(b, { [k]: other, [o]: orig }) }));
  };

  if (s.type === 'notes') return <NotesSheet notes={notes} onClose={close} reload={reloadNotes} render={(n) => {
    const r = n.request_id ? b.reqs.find((x) => x.id === n.request_id) : undefined;
    if (!r) return null;
    if (r.status === 'pending') return <div className="actions"><button className="btn small primary" onClick={() => { markNotesRead([n.id]); decide(r, true); }}>Approve &amp; find cover</button><button className="btn small" onClick={() => { markNotesRead([n.id]); decide(r, false); }}>Deny</button></div>;
    return <div><span className="tag plain">{r.status[0].toUpperCase() + r.status.slice(1)}</span></div>;
  }} />;

  if (s.type === 'account') return <AccountSheet b={b} onClose={close} reload={reload} signOut={signOut} />;

  if (s.type === 'shift') {
    if (!valid(b, s.key)) return null;
    const w = empOf(b, b.assign[s.key]);
    const rows = w ? [] : b.emps.map((x) => ({ x, r: evaluate(b, { [s.key]: x.id }), n: countWeek(b, x.id, week) }))
      .sort((p, q) => (p.r.errors.length - q.r.errors.length) || (p.r.warnings.length - q.r.warnings.length) || (p.n - q.n) || p.x.name.localeCompare(q.x.name));
    return (
      <Sheet eyebrow="Shift" title={w ? w.name : 'Open shift'} onClose={close}>
        {slotCard(s.key)}
        {w ? <div className="sec"><h4>{w.name} can't make it?</h4><p>Pick who takes this shift. You can trade one of their shifts back to {w.name} right away, or record it as owed.</p>
          <div className="actions"><button className="btn primary" onClick={() => set({ type: 'swap', key: s.key })}>Swap or find cover</button>
            <button className="btn" onClick={() => set({ type: 'profile', id: w.id })}>{w.name}'s profile</button>
            <button className="btn danger" onClick={() => commit({ [s.key]: null }, `${w.name} removed from ${slotLabel(b, s.key)}. The shift is open.`)}>Leave shift open</button></div></div>
          : <div className="sec"><h4>Who can take it</h4><p>Best fits first: no conflicts, then fewest shifts this week.</p><div className="list">
            {rows.length ? rows.map(({ x, r, n }) => <button key={x.id} className="row" disabled={r.errors.length > 0} onClick={async () => { if (await commit({ [s.key]: x.id }, `${x.name} now works ${slotLabel(b, s.key)}.`)) close(); }}>
              <span className="dot" style={{ ['--h' as string]: x.hue }} /><span className="main"><b>{x.name}</b><span>{n}/{x.max_shifts} shifts this week</span></span>{statusTag(r)}</button>) : <p className="empty-note">Add workers first.</p>}
          </div></div>}
      </Sheet>);
  }

  if (s.type === 'swap') {
    const orig = b.assign[s.key], ow = empOf(b, orig);
    if (!ow) return null;
    const rows = b.emps.filter((x) => x.id !== orig).map((x) => { const r = evaluate(b, { [s.key]: x.id }); return { x, r, t: tradeOptions(s.key, x.id).filter((o) => !o.r.errors.length).length, n: countWeek(b, x.id, week) }; })
      .sort((p, q) => (Number(!!q.t || !q.r.errors.length) - Number(!!p.t || !p.r.errors.length)) || (p.r.errors.length - q.r.errors.length) || p.x.name.localeCompare(q.x.name));
    return (
      <Sheet eyebrow="Swap or cover" title={`Replace ${ow.name}`} onClose={close}>
        {slotCard(s.key)}
        <div className="sec"><h4>Who will take {ow.name}'s shift?</h4><p>"Can cover" means they can take it as an extra shift. The trade count is how many of their shifts {ow.name} could work in return.</p>
          <div className="list">{rows.map(({ x, r, t, n }) => { const can = !r.errors.length; return (
            <button key={x.id} className="row" disabled={!can && !t} onClick={() => set({ type: 'swap-with', key: s.key, other: x.id })}>
              <span className="dot" style={{ ['--h' as string]: x.hue }} /><span className="main"><b>{x.name}</b><span>{n}/{x.max_shifts} this week · {t} shift{t === 1 ? '' : 's'} to trade</span></span>
              {can ? (r.warnings.length ? <span className="tag warn">Can cover · {r.warnings[0].short}</span> : <span className="tag ok">Can cover</span>) : <span className="tag bad">{r.errors[0].short}</span>}</button>); })}</div></div>
      </Sheet>);
  }

  if (s.type === 'swap-with') {
    const orig = b.assign[s.key], ow = empOf(b, orig), xw = empOf(b, s.other);
    if (!ow || !xw) return null;
    const cover = evaluate(b, { [s.key]: xw.id });
    const opts = tradeOptions(s.key, xw.id);
    const bestTrade = cover.errors.length > 0;
    const sl = slotOf(b, s.key)!;
    return (
      <Sheet eyebrow={`Replace ${ow.name}`} title={`With ${xw.name}`} onClose={close}>
        {slotCard(s.key)}
        <div className={`option${bestTrade ? '' : ' best'}`}><h4>{xw.name} covers, {ow.name} pays back later</h4>
          <p>{xw.name} takes this as an extra shift. It is recorded as "{ow.name} owes {xw.name} 1 shift" so you can pay it back next week.</p>
          {cover.errors.length ? <div className="reason bad">{cover.errors[0].msg}</div> : cover.warnings.map((w) => <div key={w.msg} className="reason warn">{w.msg}</div>)}
          <div><button className={`btn${bestTrade ? '' : ' primary'}`} disabled={cover.errors.length > 0} onClick={async () => {
            const ok = await commit({ [s.key]: xw.id }, `${xw.name} covers ${slotLabel(b, s.key)}. ${ow.name} owes ${xw.name} 1 shift.`,
              { ledger: { org_id: b.org.id, debtor_id: ow.id, creditor_id: xw.id, slot_id: sl.id, work_date: parseCell(s.key).date, label: slotLabel(b, s.key) } });
            if (ok) close();
          }}>{xw.name} covers this shift</button></div></div>
        <div className={`option${bestTrade ? ' best' : ''}`}><h4>Trade: {ow.name} takes one of {xw.name}'s shifts</h4>
          <p>Pick the shift {ow.name} will work instead. Both keep the same number of shifts.</p>
          <div className="list">{opts.length ? opts.map(({ o, r }) => (
            <button key={o} className="row" disabled={r.errors.length > 0} onClick={async () => { if (await commit({ [s.key]: xw.id, [o]: ow.id }, `Traded. ${xw.name} works ${slotLabel(b, s.key)} and ${ow.name} works ${slotLabel(b, o)}.`)) close(); }}>
              <span className="main"><b>{slotLabel(b, o)}</b><span className={r.errors.length ? 'reason bad' : r.warnings.length ? 'reason warn' : ''}>{r.errors[0]?.msg ?? r.warnings[0]?.msg ?? `${ow.name} works this, ${xw.name} gets ${slotLabel(b, s.key)}`}</span></span>
              {r.errors.length ? <span className="tag bad">No</span> : <span className={`tag ${r.warnings.length ? 'warn' : 'ok'}`}>Trade</span>}</button>))
            : <p className="empty-note">{xw.name} has no shifts in the next three weeks.</p>}</div></div>
        <div><button className="btn" onClick={() => set({ type: 'swap', key: s.key })}>‹ Pick someone else</button></div>
      </Sheet>);
  }

  if (s.type === 'payback') {
    const l = b.ledger.find((x) => x.id === s.id); if (!l) return null;
    const d = empOf(b, l.debtor_id), c = empOf(b, l.creditor_id); if (!d || !c) return null;
    const opts = keysOf(b, c.id).filter((k) => parseCell(k).date > l.work_date).map((k) => ({ k, r: evaluate(b, { [k]: d.id }) }));
    return (
      <Sheet eyebrow="Pay back" title={`${d.name} owes ${c.name}`} onClose={close}>
        <div className="sec"><p>{c.name} covered {d.name}'s {l.label}. Pick one of {c.name}'s upcoming shifts for {d.name} to work. If next week isn't scheduled yet, go to that week and copy last week first.</p></div>
        <div className="list">{opts.length ? opts.map(({ k, r }) => (
          <button key={k} className="row" disabled={r.errors.length > 0} onClick={async () => { if (await commit({ [k]: d.id }, `${d.name} works ${slotLabel(b, k)} for ${c.name}. They're even.`, { settle: l.id })) close(); }}>
            <span className="main"><b>{slotLabel(b, k)}</b><span className={r.errors.length ? 'reason bad' : r.warnings.length ? 'reason warn' : ''}>{r.errors[0]?.msg ?? r.warnings[0]?.msg ?? `${d.name} works it, ${c.name} gets the shift off`}</span></span>{statusTag(r)}</button>))
          : <p className="empty-note">{c.name} has no upcoming shifts after that date.</p>}</div>
        <div className="actions"><button className="btn" onClick={async () => { await supabase.from('ledger').update({ status: 'settled', settled_at: new Date().toISOString() }).eq('id', l.id); await reload(); close(); toast('Marked as settled.', 'ok', 'Done'); }}>Mark settled without a shift</button></div>
      </Sheet>);
  }

  if (s.type === 'profile') return <ProfileSheet b={b} week={week} id={s.id} onClose={close} reload={reload} onPreview={() => preview(s.id)} />;

  if (s.type === 'loc') return <LocSheet b={b} loc={s.loc} onClose={close} reload={reload} />;
  return null;
}

function ProfileSheet({ b, week, id, onClose, reload, onPreview }: { b: Bundle; week: string; id: string; onClose: () => void; reload: () => Promise<void>; onPreview: () => void }) {
  const toast = useToast();
  const w = empOf(b, id);
  const [f, setF] = useState(() => ({ name: w?.name ?? '', email: w?.email ?? '', phone: w?.phone ?? '', max: w?.max_shifts ?? 5, rate: w?.rate ?? 0 }));
  const [busy, setBusy] = useState(false);
  const dirty = useMemo(() => w && (f.name !== w.name || f.email !== (w.email ?? '') || f.phone !== (w.phone ?? '') || f.max !== w.max_shifts || f.rate !== w.rate), [f, w]);
  if (!w) return null;
  const n = countWeek(b, w.id, week);
  const mine = keysOf(b, w.id).filter((k) => parseCell(k).date >= week && parseCell(k).date < addDays(week, 7));
  const pay = payFor(b, w, periodOf(b.org, week));

  const save = async () => {
    if (f.email && !/^\S+@\S+\.\S+$/.test(f.email.trim())) return toast('That email looks wrong. Check it and try again.', 'error', 'Not saved');
    setBusy(true);
    const { error } = await supabase.from('employees').update({ name: f.name.trim() || 'Unnamed', email: f.email.trim() || null, phone: f.phone.trim() || null, max_shifts: Math.max(1, Math.min(21, f.max)), rate: Math.max(0, f.rate) }).eq('id', w.id);
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
      <div className="field"><label htmlFor="pf-name">Name</label><input type="text" id="pf-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
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
      <div className="sec"><h4>Login <StatusTag s={w.status} /></h4>
        <p>{w.status === 'active' ? `${w.name} logs in with their email${w.phone ? ' or phone' : ''} and their own password.`
          : w.status === 'invited' ? `Invite sent ${w.invited_at ? ago(w.invited_at) : ''}. The link works for 24 hours.`
          : w.status === 'expired' ? 'The invite link expired. Send a new one.' : 'Send an invite so they can see their shifts and pay. They choose their own password.'}</p>
        <div className="actions"><button className={`btn small${w.status === 'active' ? '' : ' primary'}`} disabled={busy} onClick={invite}>
          {w.status === 'active' ? 'Send password reset link' : w.status === 'none' ? 'Send invite' : 'Resend invite'}</button></div></div>
      <div className="sec"><h4>Week of {rangeTitle(week, addDays(week, 6))} <span className={`count ${countClass(n, w.max_shifts)}`}>{n}/{w.max_shifts}</span></h4>
        {mine.length ? <><ul className="plain">{mine.map((k) => <li key={k}>{slotLabel(b, k)}</li>)}</ul><p style={{ marginTop: 6 }}>{hoursWeek(b, w.id, week)} hours</p></> : <p>No shifts this week.</p>}</div>
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

const TZS: [string, string][] = [['America/New_York', 'Eastern'], ['America/Chicago', 'Central'], ['America/Denver', 'Mountain'], ['America/Phoenix', 'Arizona'],
  ['America/Los_Angeles', 'Pacific'], ['America/Anchorage', 'Alaska'], ['Pacific/Honolulu', 'Hawaii']];

function AccountSheet({ b, onClose, reload, signOut }: { b: Bundle; onClose: () => void; reload: () => Promise<void>; signOut: () => Promise<void> }) {
  const toast = useToast();
  const [name, setName] = useState(b.org.owner_name ?? '');
  const [biz, setBiz] = useState(b.org.name);
  const [tz, setTz] = useState(b.org.time_zone || 'America/Chicago');
  const [pw, setPw] = useState('');
  const save = async () => {
    const { error } = await supabase.from('organizations').update({ owner_name: name.trim() || null, name: biz.trim() || b.org.name, time_zone: tz }).eq('id', b.org.id);
    if (error) return toast(errText(error), 'error', 'Not saved');
    toast('Saved.', 'ok', 'Saved'); reload();
  };
  const changePw = async () => {
    if (pw.length < 8) return toast('Use at least 8 characters.', 'error', 'Not saved');
    const { error } = await supabase.auth.updateUser({ password: pw });
    if (error) return toast(errText(error), 'error', 'Not saved');
    setPw(''); toast('New password saved.', 'ok', 'Saved');
  };
  const workers = b.emps.length, locs = b.locs.length;
  return (
    <Sheet eyebrow="My account" title="Owner profile" onClose={onClose}>
      <div className="field"><label htmlFor="ac-name">Your name</label><input type="text" id="ac-name" value={name} onChange={(e) => setName(e.target.value)} /></div>
      <div className="field"><label htmlFor="ac-biz">Business name</label><input type="text" id="ac-biz" value={biz} onChange={(e) => setBiz(e.target.value)} /></div>
      <div className="field"><label htmlFor="ac-tz">Time zone (for shift reminders)</label>
        <select id="ac-tz" value={tz} onChange={(e) => setTz(e.target.value)}>{TZS.map(([v, n]) => <option key={v} value={v}>{n}</option>)}{!TZS.some(([v]) => v === tz) && <option value={tz}>{tz}</option>}</select></div>
      <div className="actions"><button className="btn primary" onClick={save}>Save</button></div>
      <div className="sec"><h4>Your business</h4><p>{locs} location{locs === 1 ? '' : 's'} · {workers} worker{workers === 1 ? '' : 's'} · since {new Date(b.org.created_at).toLocaleDateString()}</p></div>
      <div className="sec"><h4>Change password</h4><div className="field"><label htmlFor="ac-pass">New password</label><input type="password" id="ac-pass" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" /></div>
        <div style={{ marginTop: 8 }}><button className="btn small" onClick={changePw}>Save new password</button></div></div>
      <div className="actions"><button className="btn" onClick={signOut}>Log out</button></div>
    </Sheet>
  );
}

