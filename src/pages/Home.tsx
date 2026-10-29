import { Link, useNavigate } from 'react-router-dom';
import { Logo } from '../components/ui';
import { useAuth } from '../App';

export function SiteNav() {
  const { me } = useAuth();
  const nav = useNavigate();
  const jump = (id: string) => { nav('/'); setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' }), 30); };
  return (
    <header className="topbar"><div className="wrap"><div className="inner" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px 16px', width: '100%' }}>
      <Link className="brand" to="/"><Logo /><span><b>SplitYourShift</b></span></Link>
      <nav className="navlinks" aria-label="Main">
        <a className="opt" href="#features" onClick={(e) => { e.preventDefault(); jump('features'); }}>Features</a>
        <a className="opt" href="#how" onClick={(e) => { e.preventDefault(); jump('how'); }}>How it works</a>
        <a className="opt" href="#pricing" onClick={(e) => { e.preventDefault(); jump('pricing'); }}>Pricing</a>
        <a className="opt" href="#about" onClick={(e) => { e.preventDefault(); jump('about'); }}>About</a>
        {me ? <Link className="btn primary" to="/app">Open my schedule</Link>
          : <><Link className="btn" to="/login">Log in</Link><Link className="btn primary" to="/signup">Sign up free</Link></>}
      </nav>
    </div></div></header>
  );
}

const chip = (name: string, hue: number, dbl = false) => (
  <div className="chip" style={{ ['--h' as string]: hue }}>{name}{dbl && <span className="flag" title="Double shift: two shifts back to back">2×</span>}</div>);
const T = 245, K = 330, S = 90, D = 15, C = 160;

export default function Home() {
  return (
    <>
      <SiteNav />
      <section className="hero wrap"><div className="inner">
        <div>
          <div className="kicker">For hotels, motels, gas stations &amp; shops</div>
          <h1>The paper schedule, <em>without the paper.</em></h1>
          <p className="lead">Drag your people into shifts, and SplitYourShift stops the mistakes: no sixth shift for someone capped at five, nobody at two desks at once. When someone needs a day off, you see who can cover in two clicks.</p>
          <div className="actions"><Link className="btn primary big" to="/signup">Start free</Link><Link className="btn big" to="/login">Log in</Link></div>
          <p className="note">Free for 1 location and up to 10 workers. No card needed.</p>
        </div>
        <div className="mock" aria-label="Example schedule">
          <div className="mock-head"><b>Sunrise Inn</b><span className="ltype">Hotel</span><span className="tag plain">Example week</span></div>
          <p className="mock-key"><span className="flag">2×</span> double shift: the same person works two shifts back to back</p>
          <div className="tablewrap"><table><thead><tr><th className="sh" /><th>Mon</th><th>Tue</th><th>Wed</th><th>Thu</th></tr></thead><tbody>
            <tr><th className="sh">7–3</th><td>{chip('Tiffany', T)}</td><td>{chip('Tiffany', T)}</td><td>{chip('Tammy K.', K)}</td><td>{chip('Shea', S, true)}</td></tr>
            <tr><th className="sh">3–11</th><td>{chip('Dibbo', D, true)}</td><td>{chip('Dibbo', D)}</td><td>{chip('Corey', C, true)}</td><td>{chip('Shea', S, true)}</td></tr>
            <tr><th className="sh">11–7</th><td>{chip('Dibbo', D, true)}</td><td>{chip('Tiffany', T)}</td><td>{chip('Corey', C, true)}</td><td className="drop" /></tr>
          </tbody></table></div>
          <div className="floating f1">Corey → Thu 11–7<small>Corey already has 5 of 5 shifts this week.</small></div>
          <div className="floating f2">Traded<small>Tiffany ↔ Corey, both stay at 5</small></div>
        </div>
      </div></section>

      <section className="band alt wrap" id="problem"><div className="inner">
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
          <div className="feat"><h3>Drag-and-drop week</h3><p>One grid per location. Shifts down the side, days across, same as your paper sheet. Works on a phone too.</p></div>
          <div className="feat"><h3>Shift limits that hold</h3><p>Set each worker's weekly maximum. Trying to add one more shows an error instead of an overtime surprise.</p><div className="eg">Corey: 5/5 shifts. Can't add Thu 11–7.</div></div>
          <div className="feat"><h3>Swap in two clicks</h3><p>Pick who takes the shift and see their week. Tap the shift to trade back and both schedules update.</p><div className="eg">Tiffany Tue 11–7 ↔ Corey Wed 11–7</div></div>
          <div className="feat"><h3>Shifts owed</h3><p>If someone covers without a trade, SplitYourShift remembers it and suggests the payback next week.</p><div className="eg">Shea owes Dibbo 1 shift</div></div>
          <div className="feat"><h3>Time-off requests</h3><p>Workers ask from their phone. You approve and go straight to finding cover, or deny. They can cancel while it's pending.</p></div>
          <div className="feat"><h3>Your team sees their shifts</h3><p>Each worker gets their own login with their shifts, hours and estimated pay. They can look but can't change anything.</p></div>
          <div className="feat"><h3>Pay worked out</h3><p>Set each person's hourly rate and pick weekly or every-2-weeks pay. See everyone's hours, overtime and gross pay, including extra shifts they covered.</p><div className="eg">Tiffany · 80 h × $15.50 = $1,240.00</div></div>
          <div className="feat"><h3>Availability first</h3><p>Workers mark the days and hours they can work. If you drag someone into a time they said they can't, you get a warning.</p><div className="eg">Tammy K.: 6 am – 4 pm only</div></div>
        </div>
      </div></section>

      <section className="band alt wrap" id="how"><div className="inner">
        <h2>Set up in about 10 minutes</h2>
        <p className="sub">No training needed. If you can fill in the paper sheet, you can use this.</p>
        <ol className="how">
          <li><h3>Tell us what you run</h3><p>Hotel, gas station or shop. Add more locations later, and share workers between them.</p></li>
          <li><h3>Pick your shift pattern</h3><p>We suggest the usual one (like 7–3, 3–11, 11–7). Change start times or make 10- or 12-hour shifts.</p></li>
          <li><h3>Drag your team in</h3><p>Add names, drag them into the week. Workers get an email invite to see their shifts.</p></li>
        </ol>
      </div></section>

      <section className="band ink wrap" id="fit"><div className="inner">
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

      <section className="band wrap" id="pricing"><div className="inner">
        <h2>Simple pricing</h2>
        <p className="sub">Pay per location, not per worker. Everything is free during early access.</p>
        <div className="prices">
          <div className="price"><h3>Free</h3><div className="amt">$0</div><ul><li>1 location</li><li>Up to 10 workers</li><li>Drag-and-drop schedule, swaps, time off</li></ul><Link className="btn" to="/signup">Start free</Link></div>
          <div className="price pro"><h3>Pro</h3><div className="amt">$39<small> / location / month</small></div><ul><li>Unlimited workers</li><li>Multiple hotels and gas stations</li><li>Shift history and payback ledger</li><li>Payroll estimate, weekly or biweekly</li></ul><Link className="btn primary" to="/signup">Start free during early access</Link></div>
        </div>
      </div></section>

      <section className="band alt wrap" id="about"><div className="inner">
        <h2>About us</h2>
        <p className="about-text">SplitYourShift started from a real front-desk schedule: two hotels, three shifts a day, eleven people and a printed sheet. We're building the tool those owners asked for: simple enough for the whole team, and strict enough to stop scheduling mistakes.</p>
      </div></section>

      <section className="band wrap" id="faq"><div className="inner">
        <h2>Questions</h2>
        <div className="faq" style={{ marginTop: 18 }}>
          <details><summary>Do my workers need to download an app?</summary><p>No. They get an email with a link, choose a password, and log in from any phone browser with their email or phone number.</p></details>
          <details><summary>Can workers change the schedule?</summary><p>No. Workers can see their shifts and the schedule, set their availability, ask for time off and cancel a request that's still pending. Only the owner moves people.</p></details>
          <details><summary>I run a motel, a gas station and a shop. Can I use one account?</summary><p>Yes. Add each location with its own shift pattern. A worker can be in both, and their weekly limit counts shifts at both.</p></details>
          <details><summary>What if a shift isn't 8 hours?</summary><p>Set any start time and any length from 2 to 16 hours, including overnight shifts.</p></details>
          <details><summary>Where is my data kept?</summary><p>In a secure cloud database (Supabase, hosted in the US). Each business only sees its own data, and workers only see what their owner shares.</p></details>
        </div>
      </div></section>

      <section className="band ink wrap"><div className="inner ctaband">
        <div><h2>Make next week's schedule in 10 minutes</h2><p style={{ margin: '8px 0 0' }}>Start with your real shifts. It's free.</p></div>
        <div className="actions"><Link className="btn primary big" to="/signup">Sign up free</Link><Link className="btn big" to="/login">Log in</Link></div>
      </div></section>

      <footer className="site wrap"><div className="inner"><span>© {new Date().getFullYear()} SplitYourShift · Shift scheduling for hotels, gas stations and shops</span>
        <span className="actions"><Link className="mini" to="/login">Log in</Link><Link className="mini" to="/signup">Sign up</Link></span></div></footer>
    </>
  );
}
