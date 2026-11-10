import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { authLanding, authLandingError, authProviders, errText, landingTokens, supabase } from '../lib/supabase';
import { pendingJoin } from '../lib/team';
import { siteUrl } from '../lib/api';
import { useToast } from '../components/ui';
import { useAuth } from '../App';
import { PLANS, PLAN_ORDER, TRIAL, peekPlan, wantPlan, type PlanId } from '../lib/plans';
import { SiteNav } from './Home';

const GoogleG = () => (
  <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" /><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" /><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" /><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" /></svg>
);

/** "Continue with Google": shown only when Google sign-in is switched on in Supabase. `join` = a join code to use after signing in. */
export function GoogleButton({ label = 'Continue with Google', join }: { label?: string; join?: string }) {
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { authProviders().then((p) => setOn(Boolean(p.google))); }, []);
  if (!on) return null;
  const go = async () => {
    setBusy(true);
    if (join) pendingJoin.set(join);
    const { error } = await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: siteUrl() } });
    if (error) setBusy(false);
  };
  return (<>
    <button type="button" className="btn google-btn" onClick={go} disabled={busy}><GoogleG />{busy ? 'Opening Google…' : label}</button>
    <div className="or-line"><span>or</span></div>
  </>);
}

export function Login() {
  const nav = useNavigate();
  const toast = useToast();
  const { refresh } = useAuth();
  const [id, setId] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(''); setBusy(true);
    try {
      if (id.includes('@')) {
        const { error } = await supabase.auth.signInWithPassword({ email: id.trim(), password: pw });
        if (error) throw new Error(/confirm/i.test(error.message) ? 'Confirm your email first. Check your inbox for the link we sent.' : 'Wrong email or password.');
      } else {
        const { data, error } = await supabase.functions.invoke('phone-login', { body: { phone: id, password: pw } });
        if (error || !data?.access_token) throw new Error('Wrong phone number or password.');
        const { error: e2 } = await supabase.auth.setSession({ access_token: data.access_token, refresh_token: data.refresh_token });
        if (e2) throw e2;
      }
      await refresh();
      nav('/app');
    } catch (ex) { setErr(errText(ex)); } finally { setBusy(false); }
  };

  const forgot = async () => {
    if (!id.includes('@')) { setErr('Type your email above, then tap "Forgot password?". If you only have a phone number, ask your manager to send you a reset link.'); return; }
    await supabase.auth.resetPasswordForEmail(id.trim(), { redirectTo: siteUrl() });
    setErr('');
    toast("If that email has an account, we've sent a link to choose a new password.", 'ok', 'Check your inbox');
  };

  return (
    <>
      <SiteNav />
      <section className="auth wrap"><div className="inner" style={{ maxWidth: 520, gridTemplateColumns: '1fr' }}>
        <form className="card" onSubmit={submit} noValidate>
          <h2>Log in</h2>
          <p className="hint" style={{ margin: 0 }}>Owners use their email. Workers can use their email or phone number.</p>
          <GoogleButton />
          <div className="field"><label htmlFor="li-id">Email or phone number</label>
            <input type="text" id="li-id" value={id} onChange={(e) => setId(e.target.value)} autoComplete="username" placeholder="you@email.com or (555) 123-4567" /></div>
          <div className="field"><label htmlFor="li-pass">Password</label>
            <input type="password" id="li-pass" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" /></div>
          {err && <div className="reason bad">{err}</div>}
          <div className="actions">
            <button className="btn primary" type="submit" disabled={busy}>{busy ? 'Logging in…' : 'Log in'}</button>
            <button type="button" className="mini" onClick={forgot}>Forgot password?</button>
          </div>
          <p className="hint" style={{ margin: 0 }}>New business? <Link to="/signup">Create an owner account</Link>. Workers: use the join or invite link your manager sent you.</p>
        </form>
      </div></section>
    </>
  );
}

export function Signup() {
  const nav = useNavigate();
  const { refresh } = useAuth();
  const [f, setF] = useState({ name: '', business: '', email: '', password: '' });
  const [trialPlan, setTrialPlanState] = useState<PlanId>(() => peekPlan() ?? TRIAL.plan);
  const setTrialPlan = (p: PlanId) => { setTrialPlanState(p); wantPlan.set(`${p}|monthly`); };
  useEffect(() => { if (!peekPlan()) wantPlan.set(`${TRIAL.plan}|monthly`); }, []);
  const [err, setErr] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!f.business.trim()) return setErr('Add your business name.');
    if (!/^\S+@\S+\.\S+$/.test(f.email.trim())) return setErr('Add a valid email. You log in with it.');
    if (f.password.length < 8) return setErr('Use a password with at least 8 characters.');
    setErr(''); setBusy(true);
    const { data, error } = await supabase.auth.signUp({
      email: f.email.trim(), password: f.password,
      options: { data: { name: f.name.trim(), business: f.business.trim() }, emailRedirectTo: siteUrl() },
    });
    setBusy(false);
    if (error) return setErr(errText(error));
    if (data.session) { await refresh(); nav('/app'); } else setSent(true);
  };

  return (
    <>
      <SiteNav />
      <section className="auth wrap"><div className="inner" style={{ maxWidth: 620, gridTemplateColumns: '1fr' }}>
        {sent ? (
          <div className="card"><h2>Check your email</h2>
            <p className="hint" style={{ margin: 0 }}>We sent a confirmation link to <b>{f.email}</b>. Open it to finish creating your account, then you'll set up your shifts.</p></div>
        ) : (
          <form className="card" onSubmit={submit} noValidate>
            <div className="kicker">Step 1 of 4</div>
            <h2>Create your owner account</h2>
            <p className="hint" style={{ margin: 0 }}>You make the schedule. {TRIAL.days > 0 && <b>Free for {TRIAL.days} days, no card needed. </b>}Workers don't sign up here: you'll get a join link to send them.</p>
            {TRIAL.days > 0 && <fieldset className="trial-pick"><legend>Your {TRIAL.days}-day free trial</legend>
              <div className="trial-pick-row">{PLAN_ORDER.map((id) => <label key={id} className={trialPlan === id ? 'on' : ''}>
                <input type="radio" name="trial-plan" checked={trialPlan === id} onChange={() => setTrialPlan(id)} />
                <b>{PLANS[id].name}</b><small>up to {PLANS[id].locations} locations · then ${PLANS[id].price}/mo</small></label>)}</div></fieldset>}
            <GoogleButton label="Sign up with Google" />
            <div className="twocol">
              <div className="field"><label htmlFor="su-name">Your name</label><input type="text" id="su-name" value={f.name} onChange={set('name')} autoComplete="name" /></div>
              <div className="field"><label htmlFor="su-biz">Business name</label><input type="text" id="su-biz" value={f.business} onChange={set('business')} placeholder="e.g. Patel Hospitality" /></div>
            </div>
            <div className="twocol">
              <div className="field"><label htmlFor="su-email">Email</label><input type="email" id="su-email" value={f.email} onChange={set('email')} autoComplete="email" /></div>
              <div className="field"><label htmlFor="su-pass">Password</label><input type="password" id="su-pass" value={f.password} onChange={set('password')} autoComplete="new-password" /><span className="hint" style={{ margin: 0 }}>At least 8 characters.</span></div>
            </div>
            {err && <div className="reason bad">{err}</div>}
            <div className="actions"><button className="btn primary" type="submit" disabled={busy}>{busy ? 'Creating…' : TRIAL.days > 0 ? `Start my free ${PLANS[trialPlan].name} trial` : 'Create account'}</button>
              <span className="hint" style={{ margin: 0 }}>Already have one? <Link to="/login">Log in</Link></span></div>
          </form>
        )}
      </div></section>
    </>
  );
}

/** Landing page for invite and password-reset links. */
export function SetPassword() {
  const nav = useNavigate();
  const toast = useToast();
  const { refresh } = useAuth();
  const [ready, setReady] = useState<boolean | null>(null);
  const [email, setEmail] = useState('');
  const [a, setA] = useState(''); const [b, setB] = useState('');
  const [err, setErr] = useState('');
  const invite = authLanding === 'invite';

  useEffect(() => {
    let alive = true;
    const check = async () => {
      if (landingTokens?.access_token) await supabase.auth.setSession(landingTokens);
      const { data: { session } } = await supabase.auth.getSession();
      if (!alive) return;
      if (session) { setEmail(session.user.email ?? ''); setReady(true); } else setReady(false);
    };
    check();
    return () => { alive = false; };
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (a.length < 8) return setErr('Use at least 8 characters.');
    if (a !== b) return setErr("The two passwords don't match.");
    const { error } = await supabase.auth.updateUser({ password: a });
    if (error) return setErr(errText(error));
    if (invite) await supabase.rpc('worker_activated');
    await refresh();
    toast(invite ? 'Password saved. This is your schedule.' : 'New password saved. You are logged in.', 'ok', 'Welcome');
    nav('/app');
  };

  const card = (inner: React.ReactNode) => (
    <><SiteNav /><section className="auth wrap"><div className="inner" style={{ maxWidth: 560, gridTemplateColumns: '1fr' }}><div className="card">{inner}</div></div></section></>
  );
  if (authLanding === 'error') return card(<><h2>This link doesn't work anymore</h2>
    <p className="hint" style={{ margin: 0 }}>{authLandingError || 'It expired or was already used.'} Ask your manager to send a new invite, or use "Forgot password?" on the log-in page.</p>
    <div><Link className="btn primary" to="/login">Go to log in</Link></div></>);
  if (ready === null) return card(<p className="hint" style={{ margin: 0 }}>Opening your link…</p>);
  if (!ready) return card(<><h2>This link isn't valid</h2><p className="hint" style={{ margin: 0 }}>Open the newest email we sent you, or ask your manager to resend your invite.</p><div><Link className="btn primary" to="/login">Go to log in</Link></div></>);
  return card(
    <form className="stack" style={{ gap: 14 }} onSubmit={submit} noValidate>
      <h2>{invite ? 'Welcome! Choose your password' : 'Choose a new password'}</h2>
      <p className="hint" style={{ margin: 0 }}>{invite ? 'Your account is ready. Pick a password and you\'re in.' : 'Pick a new password for your login.'}</p>
      <div className="field"><label htmlFor="sp-email">Email</label><input type="email" id="sp-email" value={email} readOnly /></div>
      <div className="field"><label htmlFor="sp-pass">Password</label><input type="password" id="sp-pass" value={a} onChange={(e) => setA(e.target.value)} autoComplete="new-password" /><span className="hint" style={{ margin: 0 }}>At least 8 characters.</span></div>
      <div className="field"><label htmlFor="sp-pass2">Type it again</label><input type="password" id="sp-pass2" value={b} onChange={(e) => setB(e.target.value)} autoComplete="new-password" /></div>
      {err && <div className="reason bad">{err}</div>}
      <div><button className="btn primary" type="submit">{invite ? 'Set password and log in' : 'Save and log in'}</button></div>
    </form>
  );
}

/** A worker opens the owner's join link: sign up (or log in) and land on that business's staff list. */
export function Join() {
  const { code = '' } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { me, refresh } = useAuth();
  const [info, setInfo] = useState<{ business: string; active: boolean } | null | undefined>(undefined);
  const [f, setF] = useState({ name: '', email: '', phone: '', password: '' });
  const [err, setErr] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  useEffect(() => { supabase.rpc('join_info', { p_code: code }).then(({ data }) => setInfo((data as typeof info) ?? null), () => setInfo(null)); }, [code]);

  const joinNow = async () => {
    setBusy(true);
    const { error } = await supabase.rpc('join_by_code', { p_code: code, p_name: null, p_phone: null });
    setBusy(false);
    if (error) return setErr(errText(error));
    await refresh(); toast(`You're on the team at ${info?.business}. Your shifts show here once your manager schedules you.`, 'ok', 'Welcome'); nav('/app');
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!f.name.trim()) return setErr('Add your name, so your manager knows who you are.');
    if (!/^\S+@\S+\.\S+$/.test(f.email.trim())) return setErr('Add a valid email. You log in with it.');
    if (f.password.length < 8) return setErr('Use a password with at least 8 characters.');
    setErr(''); setBusy(true);
    const { data, error } = await supabase.auth.signUp({
      email: f.email.trim(), password: f.password,
      options: { data: { name: f.name.trim(), phone: f.phone.trim() || null, join_code: code }, emailRedirectTo: siteUrl() },
    });
    setBusy(false);
    if (error) {
      if (/registered|exists/i.test(error.message)) { pendingJoin.set(code); return setErr('That email already has an account. Log in below and you\'ll join right away.'); }
      return setErr(errText(error));
    }
    if (data.session) { await supabase.rpc('join_by_code', { p_code: code, p_name: f.name.trim(), p_phone: f.phone.trim() || null }); await refresh(); nav('/app'); }
    else setSent(true);
  };

  const card = (inner: React.ReactNode) => (
    <><SiteNav /><section className="auth wrap"><div className="inner" style={{ maxWidth: 560, gridTemplateColumns: '1fr' }}><div className="card join-card">{inner}</div></div></section></>
  );
  if (info === undefined) return card(<p className="hint" style={{ margin: 0 }}>Opening your link…</p>);
  if (!info || !info.active) return card(<><h2>This join link doesn't work anymore</h2>
    <p className="hint" style={{ margin: 0 }}>Ask your manager to send you the new link.</p><div><Link className="btn primary" to="/login">Go to log in</Link></div></>);
  const head = <><div className="kicker">Join your team</div><h2>Join {info.business} on SplitYourShift</h2>
    <p className="hint" style={{ margin: 0 }}>See your shifts, swap with coworkers, ask for time off and clock in from your phone. No app to download.</p></>;
  if (me) return card(<>{head}
    {me.role === 'owner' ? <p className="reason bad">You're logged in as a business owner ({me.email}). Log out first to join as a worker.</p>
      : <p style={{ margin: 0 }}>You're logged in as <b>{me.email}</b>.</p>}
    {err && <div className="reason bad">{err}</div>}
    {me.role !== 'owner' && <div className="actions"><button className="btn primary" disabled={busy} onClick={joinNow}>{busy ? 'Joining…' : `Join ${info.business}`}</button></div>}</>);
  if (sent) return card(<><h2>Check your email</h2>
    <p className="hint" style={{ margin: 0 }}>We sent a link to <b>{f.email}</b>. Open it to finish. You're already on {info.business}'s staff list, so your shifts will be there.</p></>);
  return card(
    <form className="stack" style={{ gap: 14 }} onSubmit={submit} noValidate>
      {head}
      <GoogleButton label="Join with Google" join={code} />
      <div className="twocol">
        <div className="field"><label htmlFor="jn-name">Your name</label><input type="text" id="jn-name" value={f.name} onChange={set('name')} autoComplete="name" placeholder="First and last name" /></div>
        <div className="field"><label htmlFor="jn-phone">Phone <small>(optional)</small></label><input type="tel" id="jn-phone" value={f.phone} onChange={set('phone')} autoComplete="tel" placeholder="(555) 123-4567" /></div>
      </div>
      <div className="twocol">
        <div className="field"><label htmlFor="jn-email">Email</label><input type="email" id="jn-email" value={f.email} onChange={set('email')} autoComplete="email" /></div>
        <div className="field"><label htmlFor="jn-pass">Password</label><input type="password" id="jn-pass" value={f.password} onChange={set('password')} autoComplete="new-password" /><span className="hint" style={{ margin: 0 }}>At least 8 characters.</span></div>
      </div>
      {err && <div className="reason bad">{err}</div>}
      <div className="actions"><button className="btn primary" type="submit" disabled={busy}>{busy ? 'Joining…' : `Join ${info.business}`}</button>
        <span className="hint" style={{ margin: 0 }}>Have an account? <Link to="/login" onClick={() => pendingJoin.set(code)}>Log in</Link> and you'll join right away.</span></div>
    </form>
  );
}
