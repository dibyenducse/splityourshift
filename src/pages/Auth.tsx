import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { authLanding, authLandingError, errText, landingTokens, supabase } from '../lib/supabase';
import { siteUrl } from '../lib/api';
import { useToast } from '../components/ui';
import { useAuth } from '../App';
import { SiteNav } from './Home';

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
          <div className="field"><label htmlFor="li-id">Email or phone number</label>
            <input type="text" id="li-id" value={id} onChange={(e) => setId(e.target.value)} autoComplete="username" placeholder="you@email.com or (555) 123-4567" /></div>
          <div className="field"><label htmlFor="li-pass">Password</label>
            <input type="password" id="li-pass" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" /></div>
          {err && <div className="reason bad">{err}</div>}
          <div className="actions">
            <button className="btn primary" type="submit" disabled={busy}>{busy ? 'Logging in…' : 'Log in'}</button>
            <button type="button" className="mini" onClick={forgot}>Forgot password?</button>
          </div>
          <p className="hint" style={{ margin: 0 }}>New business? <Link to="/signup">Create an owner account</Link>. Workers: use the invite link your manager sent you.</p>
        </form>
      </div></section>
    </>
  );
}

export function Signup() {
  const nav = useNavigate();
  const { refresh } = useAuth();
  const [f, setF] = useState({ name: '', business: '', email: '', password: '' });
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
            <p className="hint" style={{ margin: 0 }}>You make the schedule. Your workers get their own logins to see it; they don't sign up here.</p>
            <div className="twocol">
              <div className="field"><label htmlFor="su-name">Your name</label><input type="text" id="su-name" value={f.name} onChange={set('name')} autoComplete="name" /></div>
              <div className="field"><label htmlFor="su-biz">Business name</label><input type="text" id="su-biz" value={f.business} onChange={set('business')} placeholder="e.g. Patel Hospitality" /></div>
            </div>
            <div className="twocol">
              <div className="field"><label htmlFor="su-email">Email</label><input type="email" id="su-email" value={f.email} onChange={set('email')} autoComplete="email" /></div>
              <div className="field"><label htmlFor="su-pass">Password</label><input type="password" id="su-pass" value={f.password} onChange={set('password')} autoComplete="new-password" /><span className="hint" style={{ margin: 0 }}>At least 8 characters.</span></div>
            </div>
            {err && <div className="reason bad">{err}</div>}
            <div className="actions"><button className="btn primary" type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button>
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
