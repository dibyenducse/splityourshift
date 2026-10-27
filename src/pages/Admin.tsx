import { useEffect, useState } from 'react';
import { useAuth } from '../App';
import { supabase, errText } from '../lib/supabase';
import { loadBundle } from '../lib/api';
import { addDays, ago, mmdd, mondayOf, money, todayIso } from '../lib/time';
import { TYPE_LABEL, countWeek, hoursWeek, payFor, periodOf } from '../lib/rules';
import type { Bundle } from '../lib/types';
import { ConfirmButton, Loading, Sheet, StatusTag, useToast } from '../components/ui';
import { WeekGrid } from '../components/WeekGrid';
import { AppBar } from './AppShell';

interface Overview {
  daily: { day: string; visitors: number }[]; visitors: number; signup_views: number; signups: number; owners: number;
  hotels: number; gas: number; shops?: number; workers: number; workers_active: number; requests: number; requests_cancelled: number; published: number;
  pages: { path: string; views: number }[];
}
interface Account { id: string; name: string; owner_name: string | null; owner_email: string | null; types: string | null; locations: number; workers: number; created_at: string; last_active_at: string | null; status: string }

export default function AdminApp() {
  const { signOut } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState<'overview' | 'accounts'>('overview');
  const [days, setDays] = useState(14);
  const [ov, setOv] = useState<Overview | null>(null);
  const [accts, setAccts] = useState<Account[] | null>(null);
  const [open, setOpen] = useState<Account | null>(null);
  const [account, setAccount] = useState(false);

  useEffect(() => { supabase.rpc('admin_overview', { p_days: days }).then(({ data, error }) => { if (error) toast(errText(error), 'error', "Couldn't load"); else setOv(data as Overview); }); }, [days, toast]);
  const loadAccts = () => supabase.rpc('admin_accounts').then(({ data, error }) => { if (error) toast(errText(error), 'error', "Couldn't load"); else setAccts(data as Account[]); });
  useEffect(() => { loadAccts(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const tabs = <div className="subtabs">
    <button className={`btn small${tab === 'overview' && !open ? ' primary' : ''}`} onClick={() => { setTab('overview'); setOpen(null); }}>Overview</button>
    <button className={`btn small${tab === 'accounts' && !open ? ' primary' : ''}`} onClick={() => { setTab('accounts'); setOpen(null); }}>Owner accounts</button>
    {open && <button className="btn small primary">{open.name}</button>}
  </div>;

  let body;
  if (open) body = <AccountView a={open} onBack={() => setOpen(null)} reload={loadAccts} />;
  else if (tab === 'accounts') body = (
    <section className="panel"><div className="panel-head"><h2>Owner accounts</h2><span className="hint" style={{ margin: 0 }}>{accts?.length ?? 0} total</span></div>
      {!accts ? <Loading /> : <div className="table-wrap"><table className="data"><thead><tr><th>Business</th><th>Owner</th><th>Type</th><th className="num">Locations</th><th className="num">Workers</th><th>Joined</th><th>Last active</th><th>Status</th><th /></tr></thead>
        <tbody>{accts.map((a) => <tr key={a.id}><td>{a.name}</td><td>{a.owner_name || '—'}<div className="hint" style={{ margin: 0 }}>{a.owner_email}</div></td><td>{a.types || '—'}</td>
          <td className="num">{a.locations}</td><td className="num">{a.workers}</td><td>{new Date(a.created_at).toLocaleDateString()}</td><td>{a.last_active_at ? ago(a.last_active_at) : '—'}</td>
          <td>{a.status === 'active' ? <span className="tag ok">Active</span> : <span className="tag bad">Suspended</span>}</td>
          <td><button className="btn small" onClick={() => setOpen(a)}>Open</button></td></tr>)}
          {!accts.length && <tr><td colSpan={9}>No owners have signed up yet.</td></tr>}</tbody></table></div>}
    </section>);
  else body = !ov ? <Loading /> : <OverviewView ov={ov} days={days} setDays={setDays} />;

  return (
    <>
      <AppBar subtitle="Admin panel" onAccount={() => setAccount(true)} who={<b>Admin</b>} />
      <div className="wrap"><div className="layout">{tabs}{body}</div></div>
      {account && <Sheet eyebrow="My account" title="Admin" onClose={() => setAccount(false)}>
        <div className="sec"><p>You can see every owner, worker and request, but you can't change anyone's schedule.</p></div>
        <div className="actions"><button className="btn" onClick={signOut}>Log out</button></div></Sheet>}
    </>
  );
}

function OverviewView({ ov, days, setDays }: { ov: Overview; days: number; setDays: (n: number) => void }) {
  const W = 560, H = 190, pl = 34, pb = 22, pt = 8;
  const vals = ov.daily.map((d) => d.visitors);
  const max = Math.max(10, Math.ceil(Math.max(...vals, 0) / 10) * 10);
  const bw = (W - pl) / Math.max(1, vals.length);
  const y = (v: number) => pt + (H - pt - pb) * (1 - v / max);
  const ticks = [0, max / 2, max];
  const every = Math.ceil(vals.length / 7);
  const funnel: [string, number][] = [['Visited the site', ov.visitors], ['Opened sign-up', ov.signup_views], ['Created an owner account', ov.signups], ['Scheduled shifts', ov.published]];
  const top = Math.max(1, ov.visitors);
  return (<>
    <div className="actions">{[7, 14, 30, 90].map((d) => <button key={d} className={`btn small${days === d ? ' primary' : ''}`} onClick={() => setDays(d)}>Last {d} days</button>)}</div>
    <div className="tiles">
      <div className="tile"><div className="k">Visitors, last {days} days</div><div className="v">{ov.visitors.toLocaleString()}</div><div className="s">unique per day, admins not counted</div></div>
      <div className="tile"><div className="k">New owner sign-ups</div><div className="v">{ov.signups}</div><div className="s">{ov.signup_views} opened the sign-up page</div></div>
      <div className="tile"><div className="k">Owner accounts</div><div className="v">{ov.owners}</div><div className="s">{ov.hotels} hotel · {ov.gas} gas station · {ov.shops ?? 0} shop locations</div></div>
      <div className="tile"><div className="k">Workers</div><div className="v">{ov.workers}</div><div className="s">{ov.workers_active} with a login</div></div>
      <div className="tile"><div className="k">Time-off requests</div><div className="v">{ov.requests}</div><div className="s">{ov.requests_cancelled} cancelled by workers</div></div>
    </div>
    <div className="cols">
      <section className="panel chart"><div className="panel-head"><h2>Daily visitors</h2></div><p className="hint">Unique visitors per day.</p>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Daily visitors">
          {ticks.map((t) => <g key={t}><line className="gridl" x1={pl} x2={W} y1={y(t)} y2={y(t)} /><text x={pl - 6} y={y(t) + 3} textAnchor="end">{t}</text></g>)}
          {ov.daily.map((d, i) => { const x = pl + i * bw + Math.min(3, bw * 0.15), w = Math.max(1, bw - Math.min(6, bw * 0.3)); return <g key={d.day}>
            <rect className={`bar${i === vals.length - 1 ? ' last' : ''}`} x={x} y={y(d.visitors)} width={w} height={y(0) - y(d.visitors)} rx={2}><title>{mmdd(d.day)}: {d.visitors} visitors</title></rect>
            {i % every === every - 1 && <text x={x + w / 2} y={H - 6} textAnchor="middle">{mmdd(d.day)}</text>}</g>; })}
        </svg></section>
      <section className="panel"><div className="panel-head"><h2>Sign-up funnel</h2></div><p className="hint">Where visitors drop off.</p>
        <div className="funnel">{funnel.map(([n, v]) => <div key={n} className="fstep"><span>{n}</span><b>{v.toLocaleString()}</b><div className="track"><div className="fill" style={{ width: `${Math.max(1.5, (v / top) * 100)}%` }} /></div></div>)}</div></section>
    </div>
    <section className="panel"><div className="panel-head"><h2>Most visited pages</h2></div>
      <div className="table-wrap"><table className="data"><thead><tr><th>Page</th><th className="num">Views</th></tr></thead>
        <tbody>{ov.pages.map((p) => <tr key={p.path}><td>{p.path === '/' ? '/ (home)' : p.path}</td><td className="num">{p.views}</td></tr>)}
          {!ov.pages.length && <tr><td colSpan={2}>No visits recorded yet.</td></tr>}</tbody></table></div></section>
  </>);
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
    <section className="panel"><div className="panel-head"><h2>Workers</h2></div>
      <div className="table-wrap"><table className="data"><thead><tr><th>Name</th><th>Login</th><th>Email</th><th>Phone</th><th className="num">Shifts this week</th><th className="num">Hours</th><th className="num">Rate</th><th className="num">Pay this period</th></tr></thead>
        <tbody>{b.emps.map((w) => <tr key={w.id}><td>{w.name}</td><td><StatusTag s={w.status} /></td><td>{w.email || '—'}</td><td>{w.phone || '—'}</td>
          <td className="num">{countWeek(b, w.id, week)}/{w.max_shifts}</td><td className="num">{hoursWeek(b, w.id, week)}</td><td className="num">{money(w.rate)}</td><td className="num">{money(payFor(b, w, weeks).gross)}</td></tr>)}</tbody></table></div></section>
    <section className="panel"><div className="panel-head"><h2>Time-off requests</h2></div>
      <div className="table-wrap"><table className="data"><thead><tr><th>Worker</th><th>Shift</th><th>Reason</th><th>Status</th><th>Sent</th></tr></thead>
        <tbody>{b.reqs.map((r) => <tr key={r.id}><td>{b.emps.find((e) => e.id === r.employee_id)?.name ?? '?'}</td><td>{r.label}</td><td>{r.reason || '—'}</td><td>{r.status}</td><td>{ago(r.created_at)}</td></tr>)}
          {!b.reqs.length && <tr><td colSpan={5}>No requests.</td></tr>}</tbody></table></div></section>
    <div className="actions"><button className="btn icon" onClick={() => setWeek(addDays(week, -7))} aria-label="Previous week">‹</button><b>Week of {mmdd(week)}</b><button className="btn icon" onClick={() => setWeek(addDays(week, 7))} aria-label="Next week">›</button></div>
    <div className="boards"><WeekGrid b={b} week={week} editable={false} /></div>
  </>);
}
