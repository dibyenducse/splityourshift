import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../App';
import { supabase, errText } from '../lib/supabase';
import { loadBundle } from '../lib/api';
import { addDays, ago, mmdd, mondayOf, money, todayIso } from '../lib/time';
import { TYPE_LABEL, countWeek, hoursWeek, payFor, periodOf } from '../lib/rules';
import type { Bundle } from '../lib/types';
import { ConfirmButton, Loading, Sheet, StatusTag, useToast } from '../components/ui';
import { WeekGrid } from '../components/WeekGrid';
import { dateShort, payRuns, periodTitle, reopenRun, type PayRun } from '../lib/payroll';
import { AppBar } from './AppShell';
import { ProfileMenu } from '../components/Avatar';
import { ActivityLog, Dashboard, PlansEditor, Users } from './AdminPanel';
import { PLANS, untilText, type PlanId } from '../lib/plans';

interface Account { id: string; name: string; owner_name: string | null; owner_email: string | null; types: string | null; locations: number; workers: number; created_at: string; last_active_at: string | null; status: string;
  plan?: PlanId; plan_until?: string | null; plan_source?: string | null; plan_now?: PlanId; location_limit?: number | null }

type Section = 'dashboard' | 'businesses' | 'users' | 'plans' | 'coupons' | 'log';
const SECTIONS: { id: Section; label: string; icon: string }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: 'M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z' },
  { id: 'businesses', label: 'Businesses', icon: 'M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6' },
  { id: 'users', label: 'Users', icon: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21a7 7 0 0 1 14 0M17 11a3 3 0 1 0 0-6M22 21a6 6 0 0 0-4-5.6' },
  { id: 'plans', label: 'Plans & pricing', icon: 'M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8zM7.5 7.5h.01' },
  { id: 'coupons', label: 'Coupons', icon: 'M3 8a2 2 0 0 0 0 4v6h18v-6a2 2 0 0 1 0-4V4H3zM13 4v16' },
  { id: 'log', label: 'Activity log', icon: 'M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z' },
];

export default function AdminApp() {
  const { signOut } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const path = useLocation().pathname;
  // Direct links: /app/<section> (e.g. /app/coupons); /app/accounts still opens Businesses.
  const fromPath = (): Section => { const last = path.split('/').pop() ?? ''; return last === 'accounts' ? 'businesses' : (SECTIONS.some((x) => x.id === last) ? last as Section : 'dashboard'); };
  const [tab, setTabState] = useState<Section>(fromPath);
  useEffect(() => { setTabState(fromPath()); setOpen(null); }, [path]); // eslint-disable-line react-hooks/exhaustive-deps
  const [accts, setAccts] = useState<Account[] | null>(null);
  const [open, setOpen] = useState<Account | null>(null);
  const [account, setAccount] = useState(false);
  const [q, setQ] = useState(''); const [fPlan, setFPlan] = useState(''); const [fStatus, setFStatus] = useState('');
  const setTab = (t: Section) => { setTabState(t); setOpen(null); nav(t === 'dashboard' ? '/app' : `/app/${t}`, { replace: true }); window.scrollTo({ top: 0 }); };

  const loadAccts = () => supabase.rpc('admin_accounts').then(({ data, error }) => { if (error) toast(errText(error), 'error', "Couldn't load"); else { setAccts(data as Account[]); setOpen((o) => (o ? (data as Account[]).find((x) => x.id === o.id) ?? o : o)); } });
  useEffect(() => { loadAccts(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const openBusiness = (id: string) => { const a = accts?.find((x) => x.id === id); if (a) { setTabState('businesses'); setOpen(a); } };

  const shown = (accts ?? []).filter((a) => (!fPlan || (a.plan_now ?? 'free') === fPlan) && (!fStatus || a.status === fStatus)
    && (!q.trim() || `${a.name} ${a.owner_name} ${a.owner_email} ${a.types}`.toLowerCase().includes(q.trim().toLowerCase())));

  let body;
  if (open) body = <AccountView a={open} onBack={() => setOpen(null)} reload={loadAccts} />;
  else if (tab === 'dashboard') body = <Dashboard openBusiness={openBusiness} />;
  else if (tab === 'users') body = <Users />;
  else if (tab === 'plans') body = <PlansEditor />;
  else if (tab === 'coupons') body = <><div className="ad-head"><div><h1>Coupons</h1><p className="hint" style={{ margin: 0 }}>Codes owners type under Plan &amp; billing to get a plan for some months, with no card.</p></div></div><Coupons /></>;
  else if (tab === 'log') body = <ActivityLog />;
  else body = (<>
    <div className="ad-head"><div><h1>Businesses</h1><p className="hint" style={{ margin: 0 }}>Every owner account. Open one to see its schedule and payroll, change its plan, or suspend it.</p></div></div>
    <section className="panel">
      <div className="ad-tools">
        <input type="search" className="ad-search" placeholder="Search business, owner or email…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search businesses" />
        <select value={fPlan} onChange={(e) => setFPlan(e.target.value)} aria-label="Plan"><option value="">All plans</option>{(['free', 'plus', 'premium'] as PlanId[]).map((p) => <option key={p} value={p}>{PLANS[p].name}</option>)}</select>
        <select value={fStatus} onChange={(e) => setFStatus(e.target.value)} aria-label="Status"><option value="">Any status</option><option value="active">Active</option><option value="suspended">Suspended</option></select>
        <span className="hint" style={{ margin: 0 }}>{shown.length} of {accts?.length ?? 0}</span>
      </div>
      {!accts ? <Loading /> : <div className="table-wrap"><table className="data ad-table"><thead><tr><th>Business</th><th>Owner</th><th>Type</th><th className="num">Locations</th><th className="num">Workers</th><th>Plan</th><th>Joined</th><th>Last active</th><th>Status</th><th /></tr></thead>
        <tbody>{shown.map((a) => <tr key={a.id} className="clickrow" onClick={() => setOpen(a)}><td><b>{a.name}</b></td><td>{a.owner_name || '—'}<div className="hint" style={{ margin: 0 }}>{a.owner_email}</div></td><td>{a.types || '—'}</td>
          <td className="num">{a.locations}</td><td className="num">{a.workers}</td><td><span className="tag plain">{PLANS[a.plan_now ?? 'free'].name}</span>{a.plan_now && a.plan_now !== 'free' && <div className="hint" style={{ margin: 0 }}>{a.plan_until ? `until ${untilText(a.plan_until)}` : a.plan_source === 'early_access' ? 'early access' : 'no end date'}</div>}{a.location_limit ? <div className="hint" style={{ margin: 0 }}>limit {a.location_limit} locations</div> : null}</td><td>{new Date(a.created_at).toLocaleDateString()}</td><td>{a.last_active_at ? ago(a.last_active_at) : '—'}</td>
          <td>{a.status === 'active' ? <span className="tag ok">Active</span> : <span className="tag bad">Suspended</span>}</td>
          <td><button className="btn small" onClick={(e) => { e.stopPropagation(); setOpen(a); }}>Open</button></td></tr>)}
          {!shown.length && <tr><td colSpan={10}><p className="empty-note">{accts.length ? 'No businesses match.' : 'No owners have signed up yet.'}</p></td></tr>}</tbody></table></div>}
    </section></>);

  return (
    <>
      <AppBar subtitle="Admin panel" onAccount={() => setAccount(true)} who={<b>Admin</b>}
        profile={<ProfileMenu name="Admin" role="SplitYourShift admin" items={[{ label: 'Account settings', onClick: () => nav('/app/account'), icon: 'account' }]} />} />
      <div className="wrap ad-wrap"><div className="ad-shell">
        <nav className="ad-nav" aria-label="Admin sections">{SECTIONS.map((x) => (
          <button key={x.id} className={`ad-navbtn${tab === x.id ? ' on' : ''}`} aria-current={tab === x.id ? 'page' : undefined} onClick={() => setTab(x.id)}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={x.icon} /></svg>{x.label}</button>))}</nav>
        <main className="ad-main">{body}</main>
      </div></div>
      {account && <Sheet eyebrow="My account" title="Admin" onClose={() => setAccount(false)}>
        <div className="sec"><p>You can see every business, worker and request, change plans and prices, and block logins. You can't change anyone's schedule.</p></div>
        <div className="actions"><button className="btn" onClick={signOut}>Log out</button></div></Sheet>}
    </>
  );
}

function AccountView({ a, onBack, reload }: { a: Account; onBack: () => void; reload: () => void }) {
  const toast = useToast();
  const [week, setWeek] = useState(() => mondayOf(todayIso()));
  const [b, setB] = useState<Bundle | null>(null);
  useEffect(() => { loadBundle(a.id, week, true).then(setB, (e) => toast(errText(e), 'error', "Couldn't load")); }, [a.id, week, toast]);
  if (!b) return <Loading />;
  const weeks = periodOf(b.org, week);
  const setStatus = async (status: string) => {
    const { error } = await supabase.from('organizations').update({ status }).eq('id', a.id);
    if (error) toast(errText(error), 'error', 'Not saved'); else { toast(status === 'active' ? 'Account reactivated.' : 'Account suspended.', 'ok', 'Saved'); reload(); onBack(); }
  };
  return (<>
    <div className="banner"><p><b>Read-only support view.</b> You can see everything in {b.org.name}, but only the owner can change it.</p>
      <button className="btn small" onClick={onBack}>‹ All accounts</button></div>
    <section className="panel"><div className="panel-head"><h2>Owner</h2>
      {a.status === 'active' ? <ConfirmButton className="btn small danger" label="Suspend account" confirmLabel="Click again to suspend" onConfirm={() => setStatus('suspended')} />
        : <button className="btn small" onClick={() => setStatus('active')}>Reactivate</button>}</div>
      <div className="twocol"><div><b>{a.owner_name || '—'}</b><div className="hint" style={{ margin: 0 }}>{a.owner_email}</div></div>
        <div><b>{b.locs.length} location{b.locs.length === 1 ? '' : 's'} · {b.emps.length} workers</b><div className="hint" style={{ margin: 0 }}>{b.locs.map((l) => `${l.name} (${TYPE_LABEL[l.type] ?? 'Other'})`).join(', ')}</div></div></div></section>
    <PlanControl a={a} reload={reload} />
    <section className="panel"><div className="panel-head"><h2>Workers</h2></div>
      <div className="table-wrap"><table className="data"><thead><tr><th>Name</th><th>Login</th><th>Email</th><th>Phone</th><th className="num">Shifts this week</th><th className="num">Hours</th><th className="num">Rate</th><th className="num">Pay this period</th></tr></thead>
        <tbody>{b.emps.map((w) => <tr key={w.id}><td>{w.name}</td><td><StatusTag s={w.status} /></td><td>{w.email || '—'}</td><td>{w.phone || '—'}</td>
          <td className="num">{countWeek(b, w.id, week)}/{w.max_shifts}</td><td className="num">{hoursWeek(b, w.id, week)}</td><td className="num">{money(w.rate)}</td><td className="num">{money(payFor(b, w, weeks).gross)}</td></tr>)}</tbody></table></div></section>
    <AdminPayroll orgId={a.id} />
    <section className="panel"><div className="panel-head"><h2>Time-off requests</h2></div>
      <div className="table-wrap"><table className="data"><thead><tr><th>Worker</th><th>Shift</th><th>Reason</th><th>Status</th><th>Sent</th></tr></thead>
        <tbody>{b.reqs.map((r) => <tr key={r.id}><td>{b.emps.find((e) => e.id === r.employee_id)?.name ?? '?'}</td><td>{r.label}</td><td>{r.reason || '—'}</td><td>{r.status}</td><td>{ago(r.created_at)}</td></tr>)}
          {!b.reqs.length && <tr><td colSpan={5}>No requests.</td></tr>}</tbody></table></div></section>
    <div className="actions"><button className="btn icon" onClick={() => setWeek(addDays(week, -7))} aria-label="Previous week">‹</button><b>Week of {mmdd(week)}</b><button className="btn icon" onClick={() => setWeek(addDays(week, 7))} aria-label="Next week">›</button></div>
    <div className="boards"><WeekGrid b={b} week={week} editable={false} /></div>
  </>);
}

/** Paid payrolls of one business. A paid payroll can only be reopened here, with a reason; both are logged. */
function AdminPayroll({ orgId }: { orgId: string }) {
  const toast = useToast();
  const [runs, setRuns] = useState<PayRun[]>([]);
  const [audit, setAudit] = useState<{ run_id: string; action: string; reason: string | null; at: string }[]>([]);
  const [reason, setReason] = useState<Record<string, string>>({});
  const load = useCallback(() => {
    payRuns(orgId).then(setRuns, () => {});
    supabase.from('payroll_audit').select('run_id, action, reason, at').eq('org_id', orgId).order('at', { ascending: false }).then(({ data }) => setAudit(data ?? []));
  }, [orgId]);
  useEffect(load, [load]);
  const reopen = async (r: PayRun) => {
    try { await reopenRun(r.id, reason[r.id] ?? ''); toast(`${r.location_name} ${periodTitle(r)} reopened. The owner was told.`, 'ok', 'Reopened'); load(); }
    catch (e) { toast(errText(e), 'error', "Couldn't reopen"); }
  };
  return (
    <section className="panel"><div className="panel-head"><h2>Payroll history</h2></div>
      <p className="hint">Paid payrolls are locked for the owner. Reopen one only when the owner asks for a correction; write why. It is logged.</p>
      <div className="table-wrap"><table className="data"><thead><tr><th>Business</th><th>Pay period</th><th>Pay date</th><th className="num">Total paid</th><th>Status</th><th>Log</th><th>Reopen</th></tr></thead>
        <tbody>{runs.map((r) => <tr key={r.id}><td>{r.location_name}</td><td>{periodTitle(r)}</td><td>{dateShort(r.pay_date)}</td><td className="num">{money(r.total_net)}</td>
          <td>{r.status === 'paid' ? <span className="tag ok">Paid</span> : <span className="tag warn">Reopened</span>}</td>
          <td className="hint">{audit.filter((x) => x.run_id === r.id).map((x) => `${x.action} ${new Date(x.at).toLocaleString('en-US')}${x.reason ? `: ${x.reason}` : ''}`).join(' · ')}</td>
          <td>{r.status === 'paid' && <div className="actions" style={{ margin: 0, flexWrap: 'nowrap' }}>
            <input type="text" placeholder="Reason" value={reason[r.id] ?? ''} onChange={(e) => setReason({ ...reason, [r.id]: e.target.value })} aria-label="Reason for reopening" style={{ minHeight: 32, width: 160 }} />
            <ConfirmButton className="btn small danger" label="Reopen" confirmLabel="Click again" onConfirm={() => reopen(r)} /></div>}</td></tr>)}
          {!runs.length && <tr><td colSpan={7}>No payroll marked paid yet.</td></tr>}</tbody></table></div></section>
  );
}

/** Admin: set a business's plan by hand (e.g. a paying customer by invoice, or a free upgrade). */
function PlanControl({ a, reload }: { a: Account; reload: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ plan: (a.plan ?? 'free') as PlanId, until: a.plan_until ? a.plan_until.slice(0, 10) : '', limit: a.location_limit ? String(a.location_limit) : '' });
  const save = async () => {
    const { error } = await supabase.rpc('admin_set_plan', { p_org: a.id, p_plan: f.plan, p_until: f.plan !== 'free' && f.until ? new Date(f.until + 'T23:59:59').toISOString() : null, p_limit: f.limit.trim() ? Math.max(1, Math.round(+f.limit)) : null });
    if (error) toast(errText(error), 'error', 'Not saved'); else { toast(`${a.name} is on ${PLANS[f.plan].name}${f.plan !== 'free' ? (f.until ? ` until ${untilText(f.until + 'T12:00:00')}` : ' with no end date') : ''}.`, 'ok', 'Plan saved'); reload(); }
  };
  return (
    <section className="panel"><div className="panel-head"><h2>Plan</h2><span className="tag plain">Now: {PLANS[a.plan_now ?? 'free'].name}</span></div>
      <p className="hint">Change it by hand, for example for a customer who paid by invoice. Coupons the owner used show in Coupons.</p>
      <div className="twocol" style={{ maxWidth: 560 }}>
        <div className="field"><label htmlFor="ap-plan">Plan</label><select id="ap-plan" value={f.plan} onChange={(e) => setF({ ...f, plan: e.target.value as PlanId })}>
          {(['free', 'plus', 'premium'] as PlanId[]).map((p) => <option key={p} value={p}>{PLANS[p].name}{PLANS[p].price ? ` ($${PLANS[p].price}/month)` : ' (free)'}</option>)}</select></div>
        {f.plan !== 'free' && <div className="field"><label htmlFor="ap-until">Until (empty = no end date)</label><input id="ap-until" type="date" value={f.until} onChange={(e) => setF({ ...f, until: e.target.value })} /></div>}
        <div className="field"><label htmlFor="ap-limit">Location limit (empty = the plan's)</label><input id="ap-limit" type="number" min={1} max={1000} value={f.limit} placeholder={String(PLANS[f.plan].locations ?? '')} onChange={(e) => setF({ ...f, limit: e.target.value })} /></div>
      </div>
      <div className="actions"><button className="btn primary" onClick={save}>Save plan</button></div>
    </section>);
}

interface Coupon { id: string; code: string; plan: PlanId; months: number; max_uses: number | null; uses: number; expires_at: string | null; active: boolean; note: string | null; created_at: string;
  used_by: { org: string; at: string; until: string }[] }

/** Admin: make coupon codes (plan + months), copy them, see who used them, turn them off. */
function Coupons() {
  const toast = useToast();
  const [rows, setRows] = useState<Coupon[] | null>(null);
  const [f, setF] = useState({ plan: 'premium' as 'plus' | 'premium', months: 1, custom: false, count: 1, uses: '1', expires: '', note: '', prefix: 'SYS' });
  const [made, setMade] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc('admin_coupons');
    if (error) toast(errText(error), 'error', "Couldn't load coupons"); else setRows(data as Coupon[]);
  }, [toast]);
  useEffect(() => { load(); }, [load]);
  const make = async () => {
    setBusy(true);
    const { data, error } = await supabase.rpc('generate_coupons', { p_plan: f.plan, p_months: f.months, p_count: f.count, p_max_uses: f.uses.trim() ? Math.max(1, +f.uses) : null,
      p_expires: f.expires ? new Date(f.expires + 'T23:59:59').toISOString() : null, p_note: f.note, p_prefix: f.prefix });
    setBusy(false);
    if (error) return toast(errText(error), 'error', 'Not made');
    const codes = (data as Coupon[]).map((c) => c.code); setMade(codes); load();
    toast(`${codes.length} code${codes.length > 1 ? 's' : ''} ready: ${PLANS[f.plan].name} for ${f.months} month${f.months > 1 ? 's' : ''}.`, 'ok', 'Coupons made');
  };
  const copy = async (text: string) => { try { await navigator.clipboard.writeText(text); toast('Copied.', 'ok', 'Copied'); } catch { toast('Select the code and copy it.', 'error', "Couldn't copy"); } };
  const setActive = async (c: Coupon, active: boolean) => {
    const { error } = await supabase.from('coupons').update({ active }).eq('id', c.id);
    if (error) toast(errText(error), 'error', 'Not saved'); else { toast(active ? 'Coupon turned back on.' : 'Coupon turned off. It can\'t be used any more.', 'ok', 'Saved'); load(); }
  };
  const state = (c: Coupon) => !c.active ? ['plain', 'Off'] : c.expires_at && new Date(c.expires_at) < new Date() ? ['bad', 'Expired'] : c.max_uses !== null && c.uses >= c.max_uses ? ['plain', 'Used up'] : ['ok', 'Active'];
  return (<>
    <section className="panel"><div className="panel-head"><h2>Make coupon codes</h2></div>
      <p className="hint">An owner types the code under Plan &amp; billing and gets the plan for that many months, with no card. A code works once per business.</p>
      <div className="coupon-form">
        <div className="field"><label htmlFor="cp-plan">Plan</label><select id="cp-plan" value={f.plan} onChange={(e) => setF({ ...f, plan: e.target.value as 'plus' | 'premium' })}>
          <option value="premium">Premium (unlimited locations)</option><option value="plus">Plus (up to 3 locations)</option></select></div>
        <div className="field"><span className="lbl">How long</span><div className="seg" role="group" aria-label="Months">
          {[1, 2, 3].map((m) => <button key={m} type="button" className={!f.custom && f.months === m ? 'on' : ''} onClick={() => setF({ ...f, months: m, custom: false })}>{m} month{m > 1 ? 's' : ''}</button>)}
          <button type="button" className={f.custom ? 'on' : ''} onClick={() => setF({ ...f, custom: true })}>Other</button></div>
          {f.custom && <input type="number" min={1} max={24} value={f.months} onChange={(e) => setF({ ...f, months: Math.max(1, Math.min(24, +e.target.value || 1)) })} aria-label="Months" style={{ marginTop: 6, maxWidth: 120 }} />}</div>
        <div className="field"><label htmlFor="cp-count">How many codes</label><input id="cp-count" type="number" min={1} max={200} value={f.count} onChange={(e) => setF({ ...f, count: Math.max(1, Math.min(200, +e.target.value || 1)) })} /></div>
        <div className="field"><label htmlFor="cp-uses">Businesses per code</label><input id="cp-uses" type="number" min={1} value={f.uses} onChange={(e) => setF({ ...f, uses: e.target.value })} placeholder="No limit" />
          <span className="hint" style={{ margin: 0 }}>1 = a private code. Empty = anyone (a promo code).</span></div>
        <div className="field"><label htmlFor="cp-exp">Use by (optional)</label><input id="cp-exp" type="date" value={f.expires} onChange={(e) => setF({ ...f, expires: e.target.value })} /></div>
        <div className="field"><label htmlFor="cp-pre">Starts with</label><input id="cp-pre" type="text" maxLength={10} value={f.prefix} onChange={(e) => setF({ ...f, prefix: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })} /></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label htmlFor="cp-note">Note (only you see it)</label><input id="cp-note" type="text" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="e.g. Lafayette hotel owners meetup" /></div>
      </div>
      <div className="actions"><button className="btn primary" disabled={busy} onClick={make}>{busy ? 'Making…' : `Make ${f.count} code${f.count > 1 ? 's' : ''}`}</button></div>
      {made.length > 0 && <div className="coupon-made"><div className="panel-head"><b>New codes · {PLANS[f.plan].name}, {f.months} month{f.months > 1 ? 's' : ''}</b><button className="btn small" onClick={() => copy(made.join('\n'))}>Copy all</button></div>
        <div className="codes">{made.map((c) => <button key={c} className="code" onClick={() => copy(c)} title="Copy">{c}</button>)}</div></div>}
    </section>
    <section className="panel"><div className="panel-head"><h2>All coupons</h2><span className="hint" style={{ margin: 0 }}>{rows?.length ?? 0} total</span></div>
      {!rows ? <Loading /> : rows.length ? <div className="table-wrap"><table className="data"><thead><tr><th>Code</th><th>Plan</th><th className="num">Months</th><th>Used</th><th>Use by</th><th>Status</th><th>Note</th><th /></tr></thead>
        <tbody>{rows.map((c) => { const [k, t] = state(c); return (<tr key={c.id}>
          <td><button className="code" onClick={() => copy(c.code)} title="Copy">{c.code}</button></td><td>{PLANS[c.plan].name}</td><td className="num">{c.months}</td>
          <td>{c.uses}{c.max_uses !== null ? ` of ${c.max_uses}` : ''}{c.used_by.map((u) => <div key={u.at} className="hint" style={{ margin: 0 }}>{u.org} · {untilText(u.at)}</div>)}</td>
          <td>{c.expires_at ? untilText(c.expires_at) : '—'}</td><td><span className={`tag ${k}`}>{t}</span></td><td>{c.note ?? ''}</td>
          <td>{c.active ? <ConfirmButton className="btn small" label="Turn off" confirmLabel="Click again" onConfirm={() => setActive(c, false)} /> : <button className="btn small" onClick={() => setActive(c, true)}>Turn on</button>}</td></tr>); })}</tbody></table></div>
        : <p className="empty-note">No coupons yet. Make some above.</p>}
    </section>
  </>);
}
