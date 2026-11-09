import { Link, useNavigate } from 'react-router-dom';
import { Logo } from '../components/ui';
import { useAuth } from '../App';
import { useEffect, useState } from 'react';
import { PLANS, PLAN_ORDER, POPULAR, wantPlan, type Billing } from '../lib/plans';
import { BillingToggle, PlanPrice } from '../components/PlanBits';

export function SiteNav() {
  const { me } = useAuth();
  const nav = useNavigate();
  const jump = (id: string) => { nav('/'); setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' }), 30); };
  return (
    <header className="topbar"><div className="wrap"><div className="inner" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px 16px', width: '100%' }}>
      <Link className="brand" to="/"><Logo /><span><b>SplitYourShift</b></span></Link>
      <nav className="navlinks" aria-label="Main">
        <a className="opt" href="#features" onClick={(e) => { e.preventDefault(); jump('features'); }}>Features</a>
        <a className="opt" href="#video" onClick={(e) => { e.preventDefault(); jump('video'); }}>How it works</a>
        <a className="opt" href="#pricing" onClick={(e) => { e.preventDefault(); jump('pricing'); }}>Pricing</a>
        <a className="opt" href="#about" onClick={(e) => { e.preventDefault(); jump('about'); }}>About</a>
        {me ? <Link className="btn primary" to="/app">Open my schedule</Link>
          : <><Link className="btn" to="/login">Log in</Link><Link className="btn primary" to="/signup">Get started</Link></>}
      </nav>
    </div></div></header>
  );
}

/** A name in the example schedule; `dbl` marks a back-to-back double shift, `sw` a swapped shift. */
const chip = (name: string, hue: number, o: { dbl?: boolean; sw?: boolean } = {}) => (
  <div className={`chip${o.dbl ? ' dbl' : ''}${o.sw ? ' sw' : ''}`} style={{ ['--h' as string]: hue }}
    title={[name, o.dbl && 'double shift (two shifts back to back)', o.sw && 'swapped shift'].filter(Boolean).join(' · ')}>
    <span className="chip-row"><span className="cname">{name}</span>{o.sw && <span className="flag swap">⇄</span>}{o.dbl && <span className="flag">2×</span>}</span></div>);
/** Set this to the YouTube link once the tutorial is uploaded there; a "Watch on YouTube" link then shows under the video. */
const YOUTUBE_URL = '';
const MEDIA = import.meta.env.BASE_URL + 'media/';

const T = 245, K = 330, S = 90, M = 15, C = 160, P = 200;

/** Fade sections up as they scroll into view (skipped when the visitor prefers less motion). */
function useReveal() {
  useEffect(() => {
    const els = Array.from(document.querySelectorAll('.reveal'));
    if (!('IntersectionObserver' in window) || matchMedia('(prefers-reduced-motion: reduce)').matches) { els.forEach((e) => e.classList.add('in')); return; }
    document.documentElement.classList.add('js-reveal');
    const io = new IntersectionObserver((xs) => xs.forEach((x) => { if (x.isIntersecting) { x.target.classList.add('in'); io.unobserve(x.target); } }), { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, []);
}

const PERKS: [string, string][] = [
  ['M7 2h10v20H7zM11 18h2', 'Works on any phone'],
  ['M12 3v12M7 10l5 5 5-5M5 21h14', 'No app to download'],
  ['M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'Set up in about 10 minutes'],
  ['M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z', 'Each business sees only its own data'],
];

export default function Home() {
  useReveal();
  const { me } = useAuth();
  const nav = useNavigate();
  const [billing, setBilling] = useState<Billing>('monthly');
  const choose = (id: string) => { if (id === 'free') return nav(me ? '/app' : '/signup'); if (me) return nav(`/app/plan?plan=${id}&billing=${billing}`); wantPlan.set(`${id}|${billing}`); nav('/signup'); };
  return (
    <>
      <SiteNav />
      <section className="hero wrap"><div className="hero-glow" aria-hidden="true"><i /><i /><i /></div><div className="inner">
        <div>
          <div className="kicker">For hotels, motels, gas stations &amp; shops</div>
          <h1>The paper schedule, <em>without the paper.</em></h1>
          <p className="lead">Drag your people into shifts, and SplitYourShift stops the mistakes: no sixth shift for someone capped at five, nobody at two desks at once. When someone needs a day off, you see who can cover in two clicks.</p>
          <div className="actions"><Link className="btn primary big" to="/signup">Get started</Link>
            <a className="btn big" href="#video" onClick={(e) => { e.preventDefault(); document.getElementById('video')?.scrollIntoView({ behavior: 'smooth' }); }}>▶ Watch the 2-minute video</a></div>
          <p className="note">Set up in minutes. No card needed to start.</p>
        </div>
        <div className="mock" aria-label="Example schedule">
          <div className="mock-head"><b>Sunrise Inn</b><span className="ltype">Hotel</span><span className="tag plain">Example week</span></div>
          <p className="mock-key"><span><span className="flag">2×</span> double shift (back to back)</span><span><span className="flag swap">⇄</span> swapped shift</span></p>
          <div className="tablewrap"><table><thead><tr><th className="sh" /><th>Mon</th><th>Tue</th><th>Wed</th><th>Thu</th></tr></thead><tbody>
            <tr><th className="sh">7–3</th><td>{chip('Tiffany', T)}</td><td>{chip('Tiffany', T)}</td><td>{chip('Tammy K.', K)}</td><td>{chip('Shea', S, { dbl: true })}</td></tr>
            <tr><th className="sh">3–11</th><td>{chip('Marcus', M, { dbl: true })}</td><td>{chip('Marcus', M)}</td><td>{chip('Corey', C, { dbl: true })}</td><td>{chip('Shea', S, { dbl: true })}</td></tr>
            <tr><th className="sh">11–7</th><td>{chip('Marcus', M, { dbl: true })}</td><td>{chip('Tiffany', T, { sw: true })}</td><td>{chip('Corey', C, { dbl: true, sw: true })}</td><td>{chip('Priya', P)}</td></tr>
          </tbody></table></div>
          <div className="floating f1">Corey → Fri 7–3<small>Corey already has 5 of 5 shifts this week.</small></div>
          <div className="floating f2">⇄ Swapped<small>Tiffany Tue 11–7 ↔ Corey Wed 11–7</small></div>
        </div>
      </div></section>

      <section className="perks wrap" aria-label="Why it's easy"><div className="inner">
        {PERKS.map(([d, t]) => <div key={t} className="perk"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>{t}</div>)}
      </div></section>

      <section className="band wrap" id="video"><div className="inner reveal">
        <h2>See how it works in 2 minutes</h2>
        <p className="sub">Create your account, add your workers, make the week, clock in with one tap, and get payroll worked out. Step by step.</p>
        <div className="tut">
          <div className="tut-frame"><video className="tut-video" controls preload="none" playsInline poster={MEDIA + 'poster.jpg'} aria-label="SplitYourShift setup tutorial">
            <source src={MEDIA + 'tutorial.mp4'} type="video/mp4" />
            Your browser can't play this video. <a href={MEDIA + 'tutorial.mp4'}>Download it</a>.
          </video></div>
          <ol className="tut-steps">
            <li><b>Create your account</b><span>Name, business, email, password</span></li>
            <li><b>Pick your business and shifts</b><span>Hotel, gas station or shop; 7–3, 3–11, 11–7 or your own</span></li>
            <li><b>Add your workers</b><span>They get an email invite; no app to download</span></li>
            <li><b>Put names into the week</b><span>Tap a name, tap a shift. Limits are checked for you</span></li>
            <li><b>Time clock: one tap in, one tap out</b><span>Grace period, late and forgot-to-clock-out handled</span></li>
            <li><b>Payroll is worked out</b><span>Weekly, every 2 weeks or monthly, with overtime and payslips</span></li>
          </ol>
        </div>
        {YOUTUBE_URL && <p className="hint" style={{ marginTop: 12 }}><a href={YOUTUBE_URL} target="_blank" rel="noreferrer">Watch on YouTube ↗</a></p>}
      </div></section>

      <section className="band alt wrap" id="problem"><div className="inner reveal">
        <h2>Built for the owner who still writes the week on paper</h2>
        <p className="sub">Most small hotels, gas stations and shops run on a printed sheet, a group text and a lot of phone calls. SplitYourShift keeps that same simple grid and adds the checks you do in your head.</p>
        <div className="compare">
          <div><h3>Today</h3><ul><li>Week drawn by hand, photo sent to the group chat</li><li>Someone calls out at 10 pm and you phone around</li><li>"I covered for you last month" arguments</li><li>Hard to see who's over their hours</li></ul></div>
          <div className="after"><h3>With SplitYourShift</h3><ul><li>Drag names into a grid that looks like your sheet</li><li>Time-off requests arrive with a list of who can cover</li><li>Every cover is recorded and paid back next week</li><li>Shift limits are enforced before mistakes happen</li></ul></div>
        </div>
      </div></section>

      <section className="band wrap" id="features"><div className="inner">
        <h2>What it does</h2>
        <p className="sub">Everything an owner needs to run 24-hour shifts, and nothing a 10-person team won't use.</p>
        <div className="feats">
          <div className="feat reveal"><span className="feat-ico" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 5h16v14H4zM4 10h16M9 5v14" /></svg></span><h3>Drag-and-drop week</h3><p>One grid per location. Shifts down the side, days across, same as your paper sheet. Works on a phone too.</p></div>
          <div className="feat reveal"><span className="feat-ico" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z" /></svg></span><h3>Shift limits that hold</h3><p>Set each worker's weekly maximum. Trying to add one more shows an error instead of an overtime surprise.</p><div className="eg">Corey: 5/5 shifts. Can't add Thu 11–7.</div></div>
          <div className="feat reveal"><span className="feat-ico" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 7h11l-3-3M17 17H6l3 3" /></svg></span><h3>Swap in two clicks</h3><p>Pick who takes the shift and see their week. Tap the shift to trade back and both schedules update.</p><div className="eg">Tiffany Tue 11–7 ↔ Corey Wed 11–7</div></div>
          <div className="feat reveal"><span className="feat-ico" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 8v8M8 12h8M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z" /></svg></span><h3>Shifts owed</h3><p>If someone covers without a trade, SplitYourShift remembers it and suggests the payback next week.</p><div className="eg">Shea owes Dibbo 1 shift</div></div>
          <div className="feat reveal"><span className="feat-ico" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6h16v14H4zM4 10h16M8 3v4M16 3v4" /></svg></span><h3>Time-off requests</h3><p>Workers ask from their phone. You approve and go straight to finding cover, or deny. They can cancel while it's pending.</p></div>
          <div className="feat reveal"><span className="feat-ico" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21a7 7 0 0 1 14 0M17 11a3 3 0 1 0 0-6M22 21a6 6 0 0 0-4-5.6" /></svg></span><h3>Your team sees their shifts</h3><p>Each worker gets their own login with their shifts, hours and estimated pay. They can look but can't change anything.</p></div>
          <div className="feat reveal"><span className="feat-ico" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z" /></svg></span><h3>One-tap time clock</h3><p>Workers tap one green circle to clock in and again to clock out. You set the grace period; late arrivals, staying late and forgotten clock-outs are handled with simple choices.</p><div className="eg">Maria clocked in 7:02 am · within 10-min grace</div></div>
          <div className="feat reveal"><span className="feat-ico" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v20M17 6.5c0-1.9-2.2-3.5-5-3.5S7 4.6 7 6.5 9.2 10 12 10s5 1.6 5 3.5-2.2 3.5-5 3.5-5-1.6-5-3.5" /></svg></span><h3>Payroll done for you</h3><p>Weekly, every 2 weeks or monthly, for each business. Hours, overtime, bonuses, deductions and printable payslips. No time clock? Pay comes from the schedule, and you can edit any hours.</p><div className="eg">Tiffany · 80 h × $15.50 = $1,240.00</div></div>
          <div className="feat reveal"><span className="feat-ico" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 3h9l4 4v14H6zM9 12h7M9 16h7M9 8h3" /></svg></span><h3>Shift reports</h3><p>A logbook for every location. The night shift writes what happened; the morning shift and you read it, from anywhere.</p><div className="eg">Night: audit done, room 214 late checkout</div></div>
          <div className="feat reveal"><span className="feat-ico" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6l2 2 3-3M4 13l2 2 3-3M12 7h8M12 14h8M12 20h8" /></svg></span><h3>Task lists</h3><p>Give each shift its to-do list. Workers tick tasks off on their phone and you see who did what, and when.</p><div className="eg">7–3: count the cash drawer ✓</div></div>
          <div className="feat reveal"><span className="feat-ico" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 4h14v16H5zM9 12l2 2 4-4" /></svg></span><h3>Availability first</h3><p>Workers mark the days and hours they can work. If you drag someone into a time they said they can't, you get a warning.</p><div className="eg">Tammy K.: 6 am – 4 pm only</div></div>
        </div>
      </div></section>

      <section className="band ink wrap" id="fit"><div className="inner reveal">
        <h2 style={{ color: 'var(--on-ink)' }}>Made for small businesses that run on shifts</h2>
        <p style={{ margin: '10px 0 24px', maxWidth: '40em' }}>Pick one when you sign up and your shifts are set up for you.</p>
        <div className="fit">
          <div className="fitcard"><h3>Hotels &amp; motels</h3><p>Front desk, night audit, housekeeping.</p>
            <div className="pat"><span><b>7 am – 3 pm</b><em>morning</em></span><span><b>3 pm – 11 pm</b><em>evening</em></span><span><b>11 pm – 7 am</b><em>night audit</em></span></div></div>
          <div className="fitcard"><h3>Gas stations</h3><p>Cashiers, often open around the clock.</p>
            <div className="pat"><span><b>6 am – 2 pm</b><em>8 h</em></span><span><b>2 pm – 10 pm</b><em>8 h</em></span><span><b>10 pm – 6 am</b><em>8 h</em></span><span><b>or 10-hour shifts</b><em>overlap at rush</em></span></div></div>
          <div className="fitcard"><h3>Shops &amp; stores</h3><p>Convenience stores, groceries, retail, salons.</p>
            <div className="pat"><span><b>9 am – 3 pm</b><em>morning</em></span><span><b>3 pm – 9 pm</b><em>evening</em></span><span><b>or any opening hours</b><em>you choose</em></span></div></div>
        </div>
      </div></section>

      <section className="band wrap" id="pricing"><div className="inner reveal">
        <h2>Simple pricing</h2>
        <p className="sub">Pay per business, not per worker. Pay yearly and save; move up as you add locations.</p>
        <div className="plan-toggle-row"><BillingToggle value={billing} onChange={setBilling} /></div>
        <div className="prices three">
          {PLAN_ORDER.map((id) => { const p = PLANS[id]; return (
            <div key={id} className={`price${id === POPULAR ? ' pro' : ''}`}>{id === POPULAR && <span className="tag ok" style={{ alignSelf: 'flex-start' }}>Most popular</span>}
              <h3>{p.name}</h3><PlanPrice id={id} billing={billing} />
              <p className="hint" style={{ margin: 0 }}>{p.blurb}</p>
              <ul>{p.features.map((x) => <li key={x}>{x}</li>)}</ul>
              <button className={`btn${id === POPULAR ? ' primary' : ''}`} onClick={() => choose(id)}>{`Choose ${p.name}`}</button></div>); })}
        </div>
        <p className="hint" style={{ marginTop: 12 }}>Have a coupon code? Enter it under Plan &amp; billing after you sign up.</p>
      </div></section>

      <section className="band alt wrap" id="about"><div className="inner reveal">
        <h2>About us</h2>
        <p className="about-text">SplitYourShift started from a real front-desk schedule: two hotels, three shifts a day, eleven people and a printed sheet. We're building the tool those owners asked for: simple enough for the whole team, and strict enough to stop scheduling mistakes.</p>
      </div></section>

      <section className="band wrap" id="faq"><div className="inner reveal">
        <h2>Questions</h2>
        <div className="faq" style={{ marginTop: 18 }}>
          <details><summary>Which plan do I need?</summary><p>Starter covers up to 2 locations ($19 a month or $199 a year), Plus up to 5 ($39 or $399), and Premium up to 10 ($59 or $599). More than 10? Contact support@splityourshift.com. Every plan has the schedule, time clock, payroll, shift reports and task lists.</p></details>
          <details><summary>Do my workers need to download an app?</summary><p>No. They get an email with a link, choose a password, and log in from any phone browser with their email or phone number.</p></details>
          <details><summary>Do I have to use the time clock?</summary><p>No. Turn it on or off for each location. With it off, workers see no clock and payroll pays the scheduled shift hours; you can still edit anyone's hours.</p></details>
          <details><summary>Can workers change the schedule?</summary><p>No. Workers can see their shifts and the schedule, set their availability, ask for time off and cancel a request that's still pending. Only the owner moves people.</p></details>
          <details><summary>I run a motel, a gas station and a shop. Can I use one account?</summary><p>Yes. Add each location with its own shift pattern. A worker can be in both, and their weekly limit counts shifts at both.</p></details>
          <details><summary>What if a shift isn't 8 hours?</summary><p>Set any start time and any length from 2 to 16 hours, including overnight shifts.</p></details>
          <details><summary>Where is my data kept?</summary><p>In a secure cloud database (Supabase, hosted in the US). Each business only sees its own data, and workers only see what their owner shares.</p></details>
        </div>
      </div></section>

      <section className="band ink wrap cta-glow"><div className="inner ctaband reveal">
        <div><h2>Make next week's schedule in 10 minutes</h2><p style={{ margin: '8px 0 0' }}>Start with your real shifts. No card needed to start.</p></div>
        <div className="actions"><Link className="btn primary big" to="/signup">Get started</Link><Link className="btn big" to="/login">Log in</Link></div>
      </div></section>

      <footer className="site wrap"><div className="inner"><span>© {new Date().getFullYear()} SplitYourShift · Shift scheduling for hotels, gas stations and shops</span>
        <span className="actions"><Link className="mini" to="/login">Log in</Link><Link className="mini" to="/signup">Sign up</Link></span></div></footer>
    </>
  );
}
