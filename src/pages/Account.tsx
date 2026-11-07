import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../App';
import { supabase, errText } from '../lib/supabase';
import { siteUrl } from '../lib/api';
import { TZS, tzName } from '../lib/time';
import type { Org } from '../lib/types';
import { Loading, useToast } from '../components/ui';
import { Avatar, ProfileMenu, useProfilePhoto } from '../components/Avatar';
import { AvailabilityEditor } from '../components/Availability';
import { AppBar } from './AppShell';

/** The owner's choice between their owner and worker view, remembered on this device (see Owner.tsx). */
export const viewOf = () => { try { return localStorage.getItem('sys-view') === 'worker' ? 'worker' : 'owner'; } catch { return 'owner'; } };
export const setView = (v: 'owner' | 'worker') => { try { localStorage.setItem('sys-view', v); } catch { /* private mode */ } };

/** Account Settings: one page for owners, workers and admins. Each section saves on its own. */
export default function Account() {
  const { me } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const photo = useProfilePhoto();
  const file = useRef<HTMLInputElement>(null);
  const [org, setOrg] = useState<Org | null>(null);
  const [emp, setEmp] = useState<{ id: string; name: string; phone: string | null } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [f, setF] = useState({ name: '', phone: '', email: '', tz: 'America/Chicago', biz: '' });
  const [saved, setSaved] = useState(f);
  const [pw, setPw] = useState({ cur: '', a: '', b: '' });
  const [busy, setBusy] = useState('');

  const owner = me?.role === 'owner', worker = me?.role === 'worker', admin = me?.role === 'admin';
  const workerView = worker || (owner && !!me?.empId && viewOf() === 'worker');

  const load = async () => {
    if (!me) return;
    const { data: u } = await supabase.auth.getUser();
    const o = me.orgId ? (await supabase.from('organizations').select('*').eq('id', me.orgId).maybeSingle()).data as Org | null : null;
    const e = (await supabase.from('employees').select('id, name, phone').eq('user_id', me.userId).order('created_at').limit(1).maybeSingle()).data;
    setOrg(o); setEmp(e);
    const v = {
      name: (owner ? o?.owner_name : e?.name) || (u.user?.user_metadata?.name as string | undefined) || '',
      phone: e?.phone ?? '', email: u.user?.email ?? me.email, tz: o?.time_zone || 'America/Chicago', biz: o?.name ?? '',
    };
    setF(v); setSaved(v); setLoaded(true);
  };
  useEffect(() => { load(); }, [me?.userId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!me || !loaded) return <Loading />;

  const personalDirty = f.name !== saved.name || f.phone !== saved.phone;
  const savePersonal = async () => {
    if (!f.name.trim()) return toast('Enter your name.', 'error', 'Not saved');
    setBusy('personal');
    const r = admin ? await supabase.auth.updateUser({ data: { name: f.name.trim() } }) : await supabase.rpc('update_my_account', { p_name: f.name, p_phone: f.phone });
    setBusy('');
    if (r.error) return toast(errText(r.error), 'error', 'Not saved');
    toast('Your name and phone are saved.', 'ok', 'Saved'); load();
  };
  const saveEmail = async () => {
    const email = f.email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return toast('Enter a full email address, like name@example.com.', 'error', 'Not saved');
    if (email === saved.email.toLowerCase()) return;
    setBusy('email');
    const { error } = await supabase.auth.updateUser({ email }, { emailRedirectTo: siteUrl() });
    setBusy('');
    if (error) return toast(errText(error), 'error', 'Not saved');
    toast(`Check ${email} (and your current inbox) for a confirmation link. Your email changes after you confirm.`, 'ok', 'Confirm your new email');
    setF({ ...f, email: saved.email });
  };
  const savePassword = async () => {
    if (!pw.cur) return toast('Enter your current password.', 'error', 'Not saved');
    if (pw.a.length < 8) return toast('Use at least 8 characters for the new password.', 'error', 'Not saved');
    if (pw.a !== pw.b) return toast("The new passwords don't match.", 'error', 'Not saved');
    if (pw.a === pw.cur) return toast('Pick a password different from the current one.', 'error', 'Not saved');
    setBusy('pw');
    const check = await supabase.auth.signInWithPassword({ email: saved.email, password: pw.cur });
    if (check.error) { setBusy(''); return toast('Your current password is not right.', 'error', 'Not saved'); }
    const { error } = await supabase.auth.updateUser({ password: pw.a });
    setBusy('');
    if (error) return toast(errText(error), 'error', 'Not saved');
    setPw({ cur: '', a: '', b: '' }); toast('Your new password is saved.', 'ok', 'Password');
  };
  const saveOrg = async () => {
    if (!org) return;
    setBusy('org');
    const { error } = await supabase.from('organizations').update({ time_zone: f.tz, name: f.biz.trim() || org.name }).eq('id', org.id);
    setBusy('');
    if (error) return toast(errText(error), 'error', 'Not saved');
    toast(`Saved. Schedules, the time clock and reminders use ${tzName(f.tz)} time.`, 'ok', 'Saved'); load();
  };
  const back = () => nav('/app');
  const switchView = () => { setView(workerView ? 'owner' : 'worker'); nav('/app'); };

  const items = [
    ...(owner && me.empId ? [{ label: workerView ? 'Switch to owner view' : 'Switch to worker view', onClick: switchView, primary: true, icon: 'switch' as const }] : []),
    { label: workerView ? 'My shifts' : admin ? 'Admin panel' : 'Schedule', onClick: back, icon: 'home' as const },
  ];

  return (
    <>
      <AppBar subtitle="Account settings" onAccount={() => {}} who=""
        extra={<button className="btn" onClick={back}>‹ Back</button>}
        profile={<ProfileMenu name={f.name || me.email} role={admin ? 'SplitYourShift admin' : `${workerView ? (owner ? 'Owner, in worker view' : 'Worker') : 'Owner'} · ${org?.name ?? ''}`} items={items} />} />
      <div className="wrap account">
        <h1 className="acct-title">Account settings</h1>
        <p className="hint">{owner ? 'Your login, your owner profile and your business. Your name, email, password and photo are the same in the owner and worker views.' : 'Your login and your profile. Your manager sets your shifts, limit and pay rate.'}</p>

        <section className="panel">
          <div className="panel-head"><h2>Personal information</h2></div>
          <div className="acct-photo">
            <Avatar name={f.name || me.email} url={photo.url} size={72} />
            <div className="actions" style={{ margin: 0 }}>
              <button className="btn small" disabled={photo.busy} onClick={() => file.current?.click()}>{photo.busy ? 'Saving…' : photo.url ? 'Replace photo' : 'Upload a photo'}</button>
              {photo.url && <button className="btn small" disabled={photo.busy} onClick={photo.remove}>Remove photo</button>}
              <input ref={file} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => { photo.upload(e.target.files?.[0]); e.target.value = ''; }} />
            </div>
          </div>
          <div className="twocol">
            <div className="field"><label htmlFor="ac-name">Display name</label><input id="ac-name" type="text" maxLength={60} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoComplete="name" />
              {!admin && <span className="hint">{owner ? 'Shown as the owner and on your worker profile.' : 'Shown on the schedule.'}</span>}</div>
            {!admin && <div className="field"><label htmlFor="ac-phone">Phone (optional, for log-in)</label><input id="ac-phone" type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="(555) 123-4567" autoComplete="tel" />
              <span className="hint">{emp ? 'You can log in with this number and your password.' : 'Available once you have a worker profile.'}</span></div>}
          </div>
          <div className="actions">
            <button className="btn primary" disabled={!personalDirty || busy === 'personal'} onClick={savePersonal}>{busy === 'personal' ? 'Saving…' : 'Save'}</button>
            <button className="btn" disabled={!personalDirty} onClick={() => setF({ ...f, name: saved.name, phone: saved.phone })}>Cancel</button></div>
          <div className="field" style={{ marginTop: 14 }}><label htmlFor="ac-email">Email (log-in)</label>
            <div className="inline-field"><input id="ac-email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="email" />
              <button className="btn" disabled={f.email.trim().toLowerCase() === saved.email.toLowerCase() || busy === 'email'} onClick={saveEmail}>Change email</button></div>
            <span className="hint">We send a confirmation link; the change happens after you open it.</span></div>
        </section>

        <section className="panel">
          <div className="panel-head"><h2>Security</h2></div>
          <form className="twocol" onSubmit={(e) => { e.preventDefault(); savePassword(); }}>
            <input type="email" value={saved.email} autoComplete="username" readOnly hidden />
            <div className="field"><label htmlFor="ac-cur">Current password</label><input id="ac-cur" type="password" value={pw.cur} onChange={(e) => setPw({ ...pw, cur: e.target.value })} autoComplete="current-password" /></div>
            <div />
            <div className="field"><label htmlFor="ac-new">New password</label><input id="ac-new" type="password" value={pw.a} onChange={(e) => setPw({ ...pw, a: e.target.value })} autoComplete="new-password" />
              <span className="hint">At least 8 characters.</span></div>
            <div className="field"><label htmlFor="ac-new2">Type the new password again</label><input id="ac-new2" type="password" value={pw.b} onChange={(e) => setPw({ ...pw, b: e.target.value })} autoComplete="new-password" />
              {pw.b && pw.a !== pw.b && <span className="hint" style={{ color: 'var(--bad)' }}>Doesn't match yet.</span>}</div>
            <div className="actions" style={{ gridColumn: '1 / -1' }}>
              <button className="btn primary" type="submit" disabled={busy === 'pw' || !pw.cur || !pw.a || !pw.b}>{busy === 'pw' ? 'Saving…' : 'Change password'}</button>
              <button className="btn" type="button" disabled={!pw.cur && !pw.a && !pw.b} onClick={() => setPw({ cur: '', a: '', b: '' })}>Cancel</button></div>
          </form>
        </section>

        {!admin && <section className="panel">
          <div className="panel-head"><h2>{owner ? 'Preferences and business' : 'Preferences'}</h2></div>
          {owner && org ? <>
            <div className="twocol">
              <div className="field"><label htmlFor="ac-tz">Time zone</label>
                <select id="ac-tz" value={f.tz} onChange={(e) => setF({ ...f, tz: e.target.value })}>{TZS.map(([v, n]) => <option key={v} value={v}>{n} ({v.split('/')[1].replace('_', ' ')})</option>)}{!TZS.some(([v]) => v === f.tz) && <option value={f.tz}>{f.tz}</option>}</select>
                <span className="hint">Used for the schedule, the time clock, shift reminders and paydays, for you and your workers.</span></div>
              <div className="field"><label htmlFor="ac-biz">Business name</label><input id="ac-biz" type="text" value={f.biz} onChange={(e) => setF({ ...f, biz: e.target.value })} /></div>
            </div>
            <div className="actions">
              <button className="btn primary" disabled={(f.tz === saved.tz && f.biz === saved.biz) || busy === 'org'} onClick={saveOrg}>Save</button>
              <button className="btn" disabled={f.tz === saved.tz && f.biz === saved.biz} onClick={() => setF({ ...f, tz: saved.tz, biz: saved.biz })}>Cancel</button></div>
          </> : <div className="field"><span className="lbl">Time zone</span><p style={{ margin: '4px 0 0' }}><b>{tzName(f.tz)}</b> ({f.tz})</p>
            <span className="hint">Your shifts, clock times and reminders use {org?.name ?? 'your workplace'}'s time zone, set by your manager, so everyone sees the same times.</span></div>}
        </section>}

        {workerView && me.empId && <section className="panel">
          <div className="panel-head"><h2>My availability</h2></div>
          <p className="hint">When you can work each week. {owner ? 'You see it on your own row while scheduling.' : 'Your manager sees it while making the schedule.'} For a single day off, use Request time off instead.</p>
          <AvailabilityEditor empId={me.empId} />
        </section>}

        <div className="actions"><button className="btn" onClick={back}>‹ Back to {workerView ? 'my shifts' : admin ? 'the admin panel' : 'the schedule'}</button></div>
      </div>
    </>
  );
}
