import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase, errText } from '../lib/supabase';
import { ago, money } from '../lib/time';
import { ConfirmButton, Loading, useToast } from '../components/ui';
import { PLANS, TRIAL, applyCatalog, dollars, untilText, type CatalogRow, type PlanId } from '../lib/plans';

// ---------------------------------------------------------------- dashboard

interface Stats {
  days: number; owners: number; signups: number; signups_prev: number; active_7d: number; suspended: number; locations: number;
  loc_types: { hotel: number; gas: number; shop: number }; workers: number; workers_new: number; worker_logins: number; users: number; blocked: number;
  plans: Partial<Record<PlanId, number>>; plan_value: number; paid_plans: number; coupons_used: number; clocked_orgs: number; payrolls_paid: number;
  swaps: number; reports: number; visitors: number; signup_views: number; onboarded: number; scheduled: number;
  daily: { day: string; visitors: number; signups: number }[];
  recent: { id: string; name: string; email: string | null; created_at: string; plan: PlanId; locations: number; workers: number }[];
  pages: { path: string; views: number }[];
}
const dayLabel = (d: string) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });

/** Single-series column chart with a hover readout (one measure per chart; never two scales). */
function Columns({ data, label }: { data: { day: string; n: number }[]; label: string }) {
  const [hi, setHi] = useState<number | null>(null);
  const max = Math.max(1, ...data.map((d) => d.n)), W = 100 / Math.max(1, data.length);
  const total = data.reduce((s, d) => s + d.n, 0), h = hi !== null ? data[hi] : null;
  return (
    <div className="ad-chart" onMouseLeave={() => setHi(null)}>
      <div className="ad-read">{h ? <><b>{h.n}</b> {label} · {dayLabel(h.day)}</> : <><b>{total}</b> {label} in {data.length} days</>}</div>
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label={`${label} per day`}>
        <line x1="0" y1="39.6" x2="100" y2="39.6" className="ad-base" />
        {data.map((d, i) => { const bh = (d.n / max) * 36; return (
          <g key={d.day} onMouseEnter={() => setHi(i)} onFocus={() => setHi(i)} tabIndex={-1}>
            <rect x={i * W} y="0" width={W} height="40" fill="transparent" />
            <rect x={i * W + W * 0.18} y={39.6 - bh} width={W * 0.64} height={Math.max(bh, d.n ? 0.8 : 0)} rx="0.6" className={`ad-bar${hi === i ? ' on' : ''}`} />
          </g>); })}
      </svg>
      <div className="ad-axis"><span>{data[0] && dayLabel(data[0].day)}</span><span>{data.length > 1 && dayLabel(data[data.length - 1].day)}</span></div>
    </div>);
}

/** Single-series line with a crosshair readout. */
function Line({ data, label }: { data: { day: string; n: number }[]; label: string }) {
  const [hi, setHi] = useState<number | null>(null);
  const max = Math.max(1, ...data.map((d) => d.n)), n = data.length;
  const x = (i: number) => (n <= 1 ? 50 : (i / (n - 1)) * 100), y = (v: number) => 37 - (v / max) * 33;
  const pts = data.map((d, i) => `${x(i).toFixed(2)},${y(d.n).toFixed(2)}`).join(' ');
  const h = hi !== null ? data[hi] : null, total = data.reduce((s, d) => s + d.n, 0);
  return (
    <div className="ad-chart" onMouseLeave={() => setHi(null)}
      onMouseMove={(e) => { const r = e.currentTarget.querySelector('svg')!.getBoundingClientRect(); setHi(Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left) / r.width) * (n - 1))))); }}>
      <div className="ad-read">{h ? <><b>{h.n}</b> {label} · {dayLabel(h.day)}</> : <><b>{total}</b> {label} in {n} days</>}</div>
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label={`${label} per day`}>
        <line x1="0" y1="39.6" x2="100" y2="39.6" className="ad-base" />
        <polygon points={`0,40 ${pts} 100,40`} className="ad-area" />
        <polyline points={pts} className="ad-line" vectorEffect="non-scaling-stroke" />
        {h && <line x1={x(hi!)} x2={x(hi!)} y1="0" y2="40" className="ad-cross" vectorEffect="non-scaling-stroke" />}
      </svg>
      {h && <span className="ad-dot" style={{ left: `${x(hi!)}%`, top: `${(y(h.n) / 40) * 100}%` }} />}
      <div className="ad-axis"><span>{data[0] && dayLabel(data[0].day)}</span><span>{n > 1 && dayLabel(data[n - 1].day)}</span></div>
    </div>);
}

const delta = (now: number, before: number) => {
  if (!before) return now ? <span className="ad-delta up">new</span> : null;
  const p = Math.round(((now - before) / before) * 100);
  return <span className={`ad-delta ${p >= 0 ? 'up' : 'down'}`}>{p >= 0 ? '▲' : '▼'} {Math.abs(p)}%</span>;
};

export function Dashboard({ openBusiness }: { openBusiness: (id: string) => void }) {
  const toast = useToast();
  const [days, setDays] = useState(30);
  const [s, setS] = useState<Stats | null>(null);
  useEffect(() => { setS(null); supabase.rpc('admin_stats', { p_days: days }).then(({ data, error }) => { if (error) toast(errText(error), 'error', "Couldn't load"); else setS(data as Stats); }); }, [days, toast]);
  if (!s) return <Loading />;
  const planRows = (['free', 'plus', 'premium'] as PlanId[]).map((id) => ({ id, n: s.plans[id] ?? 0 }));
  const planMax = Math.max(1, ...planRows.map((r) => r.n));
  const funnel = [['Visitors', s.visitors], ['Opened sign-up', s.signup_views], ['Signed up', s.signups], ['Added a location', s.onboarded], ['Made a schedule', s.scheduled]] as const;
  const fMax = Math.max(1, ...funnel.map(([, n]) => n));
  return (<>
    <div className="ad-head"><div><h1>Dashboard</h1><p className="hint" style={{ margin: 0 }}>Everything happening on SplitYourShift.</p></div>
      <div className="seg" role="tablist" aria-label="Period">{[7, 30, 90].map((d) => <button key={d} className={days === d ? 'on' : ''} onClick={() => setDays(d)}>{d} days</button>)}</div></div>
    <div className="ad-kpis">
      <div className="ad-kpi"><span>Businesses</span><b>{s.owners}</b><small>{s.signups} new in {days} days {delta(s.signups, s.signups_prev)}</small></div>
      <div className="ad-kpi"><span>Active this week</span><b>{s.active_7d}</b><small>{s.owners ? Math.round((s.active_7d / s.owners) * 100) : 0}% of businesses{s.suspended ? ` · ${s.suspended} suspended` : ''}</small></div>
      <div className="ad-kpi"><span>Plan value / month</span><b>{money(Number(s.plan_value))}</b><small>at list price · {s.paid_plans} on Plus or Premium</small></div>
      <div className="ad-kpi"><span>Workers</span><b>{s.workers}</b><small>{s.worker_logins} with a login · {s.workers_new} new</small></div>
      <div className="ad-kpi"><span>Locations</span><b>{s.locations}</b><small>{s.loc_types.hotel} hotels · {s.loc_types.gas} gas · {s.loc_types.shop} shops</small></div>
      <div className="ad-kpi"><span>Logins</span><b>{s.users}</b><small>{s.blocked ? `${s.blocked} blocked` : 'none blocked'}</small></div>
    </div>
    <div className="ad-grid2">
      <section className="panel"><div className="panel-head"><h2>Sign-ups</h2></div><Columns data={s.daily.map((d) => ({ day: d.day, n: d.signups }))} label="sign-ups" /></section>
      <section className="panel"><div className="panel-head"><h2>Visitors</h2></div><Line data={s.daily.map((d) => ({ day: d.day, n: d.visitors }))} label="visitors" /></section>
    </div>
    <div className="ad-grid3">
      <section className="panel"><div className="panel-head"><h2>Plans</h2></div>
        <div className="ad-hbars">{planRows.map((r) => <div key={r.id} className="ad-hbar" title={`${PLANS[r.id].name}: ${r.n}`}>
          <span className="l">{PLANS[r.id].name}</span><span className="t"><i style={{ width: `${(r.n / planMax) * 100}%` }} /></span><b>{r.n}</b></div>)}</div>
        <p className="hint" style={{ margin: '10px 0 0' }}>{s.coupons_used} coupon{s.coupons_used === 1 ? '' : 's'} used in {days} days.</p></section>
      <section className="panel"><div className="panel-head"><h2>Sign-up funnel</h2></div>
        <div className="ad-hbars">{funnel.map(([l, n]) => <div key={l} className="ad-hbar" title={`${l}: ${n}`}><span className="l">{l}</span><span className="t"><i style={{ width: `${(n / fMax) * 100}%` }} /></span><b>{n}</b></div>)}</div></section>
      <section className="panel"><div className="panel-head"><h2>Using the app</h2><span className="hint" style={{ margin: 0 }}>{days} days</span></div>
        <div className="ad-mini">
          <div><b>{s.clocked_orgs}</b><span>businesses clocked in this week</span></div>
          <div><b>{s.payrolls_paid}</b><span>payrolls marked paid</span></div>
          <div><b>{s.swaps}</b><span>swaps and adjustments</span></div>
          <div><b>{s.reports}</b><span>shift reports written</span></div>
        </div></section>
    </div>
    <div className="ad-grid2">
      <section className="panel"><div className="panel-head"><h2>Newest businesses</h2></div>
        {s.recent.length ? <div className="ad-list">{s.recent.map((r) => (
          <button key={r.id} className="ad-row" onClick={() => openBusiness(r.id)}>
            <span className="ad-av">{r.name.slice(0, 1).toUpperCase()}</span>
            <span className="m"><b>{r.name}</b><small>{r.email ?? '—'} · {r.locations} location{r.locations === 1 ? '' : 's'} · {r.workers} worker{r.workers === 1 ? '' : 's'}</small></span>
            <span className="r"><span className="tag plain">{PLANS[r.plan]?.name}</span><small>{ago(r.created_at)}</small></span></button>))}</div>
          : <p className="empty-note">No sign-ups yet.</p>}</section>
      <section className="panel"><div className="panel-head"><h2>Most visited pages</h2></div>
        {s.pages.length ? <div className="ad-hbars">{s.pages.map((p) => <div key={p.path} className="ad-hbar"><span className="l mono">{p.path || '/'}</span>
          <span className="t"><i style={{ width: `${(p.views / Math.max(1, s.pages[0].views)) * 100}%` }} /></span><b>{p.views}</b></div>)}</div>
          : <p className="empty-note">No visits recorded yet.</p>}</section>
    </div>
  </>);
}

// ---------------------------------------------------------------- users (every login)

interface UserRow { id: string; email: string | null; name: string | null; phone: string | null; role: 'admin' | 'owner' | 'worker' | 'new'; business: string | null; org_id: string | null;
  created_at: string; last_sign_in_at: string | null; banned_until: string | null; confirmed: boolean }

export function Users() {
  const toast = useToast();
  const [rows, setRows] = useState<UserRow[] | null>(null);
  const [q, setQ] = useState(''); const [role, setRole] = useState(''); const [busy, setBusy] = useState('');
  const load = useCallback(async () => { const { data, error } = await supabase.rpc('admin_users'); if (error) toast(errText(error), 'error', "Couldn't load"); else setRows(data as UserRow[]); }, [toast]);
  useEffect(() => { load(); }, [load]);
  const act = async (u: UserRow, action: 'block' | 'unblock' | 'reset') => {
    setBusy(u.id + action);
    const { data, error } = await supabase.functions.invoke('admin-users', { body: { action, user_id: u.id } });
    setBusy('');
    let msg = (data as { message?: string; error?: string } | null)?.message;
    if (error) { try { const b = await (error as { context?: Response }).context?.json(); msg = b?.error; } catch { /* keep */ } return toast(msg || errText(error), 'error', "Didn't work"); }
    toast(msg ?? 'Done.', 'ok', action === 'reset' ? 'Email sent' : action === 'block' ? 'Blocked' : 'Unblocked'); load();
  };
  const blocked = (u: UserRow) => !!u.banned_until && new Date(u.banned_until) > new Date();
  const list = useMemo(() => (rows ?? []).filter((u) => (!role || (role === 'blocked' ? blocked(u) : u.role === role))
    && (!q.trim() || `${u.email} ${u.name} ${u.phone} ${u.business}`.toLowerCase().includes(q.trim().toLowerCase()))), [rows, q, role]);
  if (!rows) return <Loading />;
  const count = (r: string) => rows.filter((u) => (r === 'blocked' ? blocked(u) : u.role === r)).length;
  return (<>
    <div className="ad-head"><div><h1>Users</h1><p className="hint" style={{ margin: 0 }}>Every login: owners, workers and admins. Block someone, or send them a password-reset email.</p></div></div>
    <section className="panel">
      <div className="ad-tools">
        <input type="search" className="ad-search" placeholder="Search name, email, phone or business…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search users" />
        <div className="seg" role="tablist">{[['', `All ${rows.length}`], ['owner', `Owners ${count('owner')}`], ['worker', `Workers ${count('worker')}`], ['blocked', `Blocked ${count('blocked')}`]].map(([v, t]) =>
          <button key={v} className={role === v ? 'on' : ''} onClick={() => setRole(v)}>{t}</button>)}</div>
      </div>
      <div className="table-wrap"><table className="data ad-table"><thead><tr><th>User</th><th>Role</th><th>Business</th><th>Joined</th><th>Last login</th><th>Status</th><th /></tr></thead>
        <tbody>{list.map((u) => { const b = blocked(u); return (
          <tr key={u.id} className={b ? 'blocked' : ''}>
            <td><b>{u.name || u.email || u.phone}</b><div className="hint" style={{ margin: 0 }}>{u.email ?? u.phone}</div></td>
            <td><span className={`tag ${u.role === 'admin' ? 'warn' : 'plain'}`}>{u.role}</span></td>
            <td>{u.business ?? '—'}</td><td>{new Date(u.created_at).toLocaleDateString()}</td><td>{u.last_sign_in_at ? ago(u.last_sign_in_at) : 'never'}</td>
            <td>{b ? <span className="tag bad">Blocked</span> : u.confirmed ? <span className="tag ok">Active</span> : <span className="tag warn">Not confirmed</span>}</td>
            <td><div className="actions" style={{ margin: 0, flexWrap: 'nowrap', justifyContent: 'flex-end' }}>
              {u.email && <button className="btn small" disabled={busy === u.id + 'reset'} onClick={() => act(u, 'reset')}>Reset password</button>}
              {u.role !== 'admin' && (b ? <button className="btn small" disabled={busy === u.id + 'unblock'} onClick={() => act(u, 'unblock')}>Unblock</button>
                : <ConfirmButton className="btn small danger" label="Block" confirmLabel="Tap again to block" onConfirm={() => act(u, 'block')} />)}</div></td>
          </tr>); })}
          {!list.length && <tr><td colSpan={7}><p className="empty-note">No users match.</p></td></tr>}</tbody></table></div>
      <p className="hint" style={{ margin: '10px 0 0' }}>Blocked users can't log in until you unblock them; their data stays. To stop a whole business, suspend it under Businesses.</p>
    </section>
  </>);
}

// ---------------------------------------------------------------- plans & pricing

export function PlansEditor() {
  const toast = useToast();
  const [rows, setRows] = useState<CatalogRow[] | null>(null);
  const [saving, setSaving] = useState('');
  const load = useCallback(async () => { const { data, error } = await supabase.from('plan_catalog').select('*').order('sort'); if (error) toast(errText(error), 'error', "Couldn't load"); else setRows((data as CatalogRow[]).map((r) => ({ ...r, price_month: Number(r.price_month), price_year: Number(r.price_year) }))); }, [toast]);
  useEffect(() => { load(); }, [load]);
  if (!rows) return <Loading />;
  const set = (id: PlanId, p: Partial<CatalogRow>) => setRows(rows.map((r) => (r.id === id ? { ...r, ...p } : p.popular ? { ...r, popular: false } : r)));
  const save = async (r: CatalogRow) => {
    if (!r.name.trim()) return toast('Give the plan a name.', 'error', 'Missing');
    if (!(r.price_month >= 0 && r.price_year >= 0 && r.locations >= 1)) return toast('Check the prices and the location limit.', 'error', 'Not saved');
    setSaving(r.id);
    const upd = { name: r.name.trim(), price_month: r.price_month, price_year: r.price_year, locations: Math.round(r.locations), blurb: r.blurb, features: r.features.map((f) => f.trim()).filter(Boolean), popular: r.popular };
    const { error } = await supabase.from('plan_catalog').update(upd).eq('id', r.id);
    if (!error && r.popular) await supabase.from('plan_catalog').update({ popular: false }).neq('id', r.id);
    setSaving('');
    if (error) return toast(errText(error), 'error', 'Not saved');
    toast(`${r.name} saved. The website, checkout and location limits use it now.`, 'ok', 'Plan saved'); applyCatalog(rows); load();
  };
  return (<>
    <div className="ad-head"><div><h1>Plans &amp; pricing</h1><p className="hint" style={{ margin: 0 }}>Change names, prices, location limits and what each plan lists. It updates the website, the checkout and the limits right away.</p></div></div>
    <TrialSettings />
    <div className="ad-plans">{rows.map((r) => { const save12 = r.price_month * 12 - r.price_year, pct = r.price_month ? Math.round((save12 / (r.price_month * 12)) * 100) : 0; return (
      <section key={r.id} className={`panel ad-plan${r.popular ? ' pop' : ''}`}>
        <div className="panel-head"><h2>{r.name || '—'}</h2>{r.popular && <span className="tag ok">Most popular</span>}</div>
        <div className="ad-fields">
          <div className="field"><label htmlFor={`pl-n-${r.id}`}>Name</label><input type="text" id={`pl-n-${r.id}`} value={r.name} onChange={(e) => set(r.id, { name: e.target.value })} /></div>
          <div className="field"><label htmlFor={`pl-m-${r.id}`}>Monthly ($)</label><input id={`pl-m-${r.id}`} type="number" min={0} step={0.01} value={r.price_month} onChange={(e) => set(r.id, { price_month: +e.target.value })} /></div>
          <div className="field"><label htmlFor={`pl-y-${r.id}`}>Yearly ($)</label><input id={`pl-y-${r.id}`} type="number" min={0} step={0.01} value={r.price_year} onChange={(e) => set(r.id, { price_year: +e.target.value })} /></div>
          <div className="field"><label htmlFor={`pl-l-${r.id}`}>Locations</label><input id={`pl-l-${r.id}`} type="number" min={1} max={1000} value={r.locations} onChange={(e) => set(r.id, { locations: +e.target.value })} /></div>
        </div>
        <p className={`ad-note${save12 < 0 ? ' bad' : ''}`}>{save12 >= 0 ? <>Yearly = {dollars(Math.round((r.price_year / 12) * 100) / 100)}/month · saves {dollars(Math.round(save12))} ({pct}%)</> : <>Yearly costs more than 12 months — check the prices.</>}</p>
        <div className="field"><label htmlFor={`pl-b-${r.id}`}>Short description</label><input type="text" id={`pl-b-${r.id}`} value={r.blurb} onChange={(e) => set(r.id, { blurb: e.target.value })} /></div>
        <div className="field"><label htmlFor={`pl-f-${r.id}`}>Features (one per line)</label><textarea id={`pl-f-${r.id}`} rows={4} value={r.features.join('\n')} onChange={(e) => set(r.id, { features: e.target.value.split('\n') })} /></div>
        <label className="inline"><input type="checkbox" checked={r.popular} onChange={(e) => set(r.id, { popular: e.target.checked })} /> Show as “Most popular”</label>
        <div className="ad-plan-foot"><small>{r.updated_at ? `Updated ${ago(r.updated_at)}` : ''}</small><button className="btn primary" disabled={saving === r.id} onClick={() => save(r)}>{saving === r.id ? 'Saving…' : `Save ${r.name}`}</button></div>
      </section>); })}</div>
    <p className="hint">Existing businesses keep their plan; only the price shown and the location limits change. A business with a custom limit (set under Businesses → Plan) keeps it.</p>
  </>);
}

/** Free trial every new business gets: length (0 = no trial) and which plan it unlocks. */
function TrialSettings() {
  const toast = useToast();
  const [f, setF] = useState<{ days: number; plan: PlanId } | null>(null);
  const [stats, setStats] = useState<{ on: number; ended: number } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    supabase.from('app_settings').select('trial_days, trial_plan').maybeSingle().then(({ data }) => setF({ days: data?.trial_days ?? 14, plan: (data?.trial_plan ?? 'premium') as PlanId }));
    supabase.from('organizations').select('plan_until').eq('plan_source', 'trial').then(({ data }) => {
      const now = Date.now(), rows = data ?? [];
      setStats({ on: rows.filter((r) => r.plan_until && new Date(r.plan_until).getTime() > now).length, ended: rows.filter((r) => !r.plan_until || new Date(r.plan_until).getTime() <= now).length });
    });
  }, []);
  if (!f) return null;
  const save = async () => {
    if (!(f.days >= 0 && f.days <= 365)) return toast('Use 0 to 365 days.', 'error', 'Not saved');
    setBusy(true);
    const { error } = await supabase.from('app_settings').update({ trial_days: Math.round(f.days), trial_plan: f.plan }).eq('id', true);
    setBusy(false);
    if (error) return toast(errText(error), 'error', 'Not saved');
    Object.assign(TRIAL, { days: Math.round(f.days), plan: f.plan });
    toast(f.days > 0 ? `New businesses get ${f.days} days of ${PLANS[f.plan].name}. Businesses already on a trial keep their end date.` : 'New businesses start on Starter with no trial.', 'ok', 'Free trial saved');
  };
  return (
    <section className="panel ad-trial">
      <div className="panel-head"><h2>Free trial</h2>{stats && <span className="tag plain">{stats.on} on a trial now · {stats.ended} trials ended</span>}</div>
      <p className="hint">Every plan has this free trial: owners pick Starter, Plus or Premium when they sign up (or on Plan &amp; billing) and get that plan free, no card. One trial per business; they can switch plans during it. When it ends they move to Starter; nothing is deleted. Extend or end one business's trial under Businesses → open it → Plan.</p>
      <div className="ad-fields">
        <div className="field"><label htmlFor="tr-days">Trial length (days, 0 = no trial)</label><input id="tr-days" type="number" min={0} max={365} value={f.days} onChange={(e) => setF({ ...f, days: +e.target.value })} /></div>
        <div className="field"><label htmlFor="tr-plan">Default plan (if they don't pick one)</label><select id="tr-plan" value={f.plan} onChange={(e) => setF({ ...f, plan: e.target.value as PlanId })}>
          {(['plus', 'premium'] as PlanId[]).map((p) => <option key={p} value={p}>{PLANS[p].name} (up to {PLANS[p].locations} locations)</option>)}</select></div>
        <div className="field ad-trial-save"><button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save trial'}</button></div>
      </div>
    </section>);
}

// ---------------------------------------------------------------- activity log

interface Audit { id: number; admin_email: string | null; action: string; target_type: string | null; target_name: string | null; detail: Record<string, unknown> | null; created_at: string }
const ACTION: Record<string, string> = {
  'plan.edit': 'Edited a plan', 'business.suspend': 'Suspended a business', 'business.reactivate': 'Reactivated a business', 'business.plan': 'Changed a business plan', 'business.trial': 'Changed a free trial', 'trial.settings': 'Changed the free trial',
  'coupon.create': 'Made a coupon', 'coupon.on': 'Turned a coupon on', 'coupon.off': 'Turned a coupon off',
  'user.block': 'Blocked a user', 'user.unblock': 'Unblocked a user', 'user.reset': 'Sent a password reset',
};
export function ActivityLog() {
  const toast = useToast();
  const [rows, setRows] = useState<Audit[] | null>(null);
  useEffect(() => { supabase.from('admin_audit').select('*').order('created_at', { ascending: false }).limit(300).then(({ data, error }) => { if (error) toast(errText(error), 'error', "Couldn't load"); else setRows(data as Audit[]); }); }, [toast]);
  if (!rows) return <Loading />;
  const detail = (a: Audit) => { const d = a.detail as { before?: Record<string, unknown>; after?: Record<string, unknown>; plan?: string; until?: string; months?: number; reason?: string } | null; if (!d) return '';
    if (d.before && d.after) return Object.keys(d.after).filter((k) => String(d.before![k]) !== String(d.after![k])).map((k) => `${k}: ${d.before![k]} → ${d.after![k]}`).join(' · ');
    if (d.plan) return `${PLANS[d.plan as PlanId]?.name ?? d.plan}${d.until ? ` until ${untilText(String(d.until))}` : ''}${d.months ? ` · ${d.months} months` : ''}`;
    return d.reason ?? ''; };
  return (<>
    <div className="ad-head"><div><h1>Activity log</h1><p className="hint" style={{ margin: 0 }}>Every change made from the admin panel: who, what and when.</p></div></div>
    <section className="panel">{rows.length ? <div className="ad-log">{rows.map((a) => (
      <div key={a.id} className="ad-log-row"><span className={`ad-log-dot ${a.action.split('.')[0]}`} />
        <div><b>{ACTION[a.action] ?? a.action}</b> {a.target_name && <span className="mono">{a.target_name}</span>}{detail(a) && <div className="hint" style={{ margin: 0 }}>{detail(a)}</div>}</div>
        <small>{a.admin_email ?? 'admin'} · {ago(a.created_at)}</small></div>))}</div>
      : <p className="empty-note">Nothing yet. Changes you make here will be listed.</p>}</section>
  </>);
}
