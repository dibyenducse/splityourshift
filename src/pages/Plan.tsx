import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../App';
import { supabase, errText } from '../lib/supabase';
import type { Org } from '../lib/types';
import { Loading, useToast } from '../components/ui';
import { ProfileMenu } from '../components/Avatar';
import { AppBar } from './AppShell';
import { PLANS, PLAN_ORDER, POPULAR, dollars, locLimitOf, locLimitText, perMonth, planOf, TRIAL, trialAvailable, trialLabel, trialLeft, untilText, yearlySave, type Billing, type PlanId } from '../lib/plans';
import { BillingToggle, PlanPrice } from '../components/PlanBits';

interface Redemption { id: string; code: string; plan: PlanId; months: number; plan_until: string; created_at: string }

/**
 * Plan & billing for the owner: the current plan, the three plans, and a checkout for the chosen one.
 * There is no card payment yet: a paid plan is unlocked with a coupon code (or by support).
 */
export default function PlanPage() {
  const { me, refresh } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const [qs] = useSearchParams();
  const [org, setOrg] = useState<Org | null>(null);
  const [locs, setLocs] = useState(0);
  const [hist, setHist] = useState<Redemption[]>([]);
  const [pick, setPick] = useState<PlanId | null>((['plus', 'premium'].includes(qs.get('plan') ?? '') ? qs.get('plan') : null) as PlanId | null);
  const [billing, setBilling] = useState<Billing>(qs.get('billing') === 'yearly' ? 'yearly' : 'monthly');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!me?.orgId) return;
    const [{ data: o }, { count }, { data: r }] = await Promise.all([
      supabase.from('organizations').select('*').eq('id', me.orgId).maybeSingle(),
      supabase.from('locations').select('id', { count: 'exact', head: true }).eq('org_id', me.orgId),
      supabase.from('coupon_redemptions').select('*').eq('org_id', me.orgId).order('created_at', { ascending: false }),
    ]);
    setOrg(o as Org); setLocs(count ?? 0); setHist((r ?? []) as Redemption[]);
  }, [me?.orgId]);
  useEffect(() => { load(); }, [load]);
  // On a trial, or before using it: the plan buttons start or switch the trial instead of opening checkout.
  useEffect(() => { if (org && ((trialLeft(org) ?? 0) > 0 || trialAvailable(org))) setPick(null); }, [org]);

  if (!me || me.role !== 'owner') return <Loading text="Plan & billing is for business owners." />;
  if (!org) return <Loading />;
  const cur = planOf(org), plan = PLANS[cur];
  const lim = locLimitOf(org);
  const ended = (org.plan ?? 'free') !== 'free' && cur === 'free';
  const need = qs.get('need') === 'locations';
  const sel = pick ? PLANS[pick] : null;

  const onTrial = (trialLeft(org) ?? 0) > 0, canTrial = trialAvailable(org);
  const startTrial = async (id: PlanId) => {
    setBusy(true);
    const { data, error } = await supabase.rpc('start_trial', { p_plan: id });
    setBusy(false);
    if (error) return toast(errText(error), 'error', 'Trial not started');
    const r = data as { plan: PlanId; until: string };
    toast(onTrial ? `Your trial is now ${PLANS[r.plan].name}, still until ${untilText(r.until)}.` : `${PLANS[r.plan].name} is free until ${untilText(r.until)}. Every feature is on.`, 'ok', onTrial ? 'Trial switched' : 'Free trial started');
    setPick(null); await load(); refresh();
  };
  const redeem = async () => {
    if (!code.trim()) return toast('Type your coupon code.', 'error', 'Missing');
    setBusy(true);
    const { data, error } = await supabase.rpc('redeem_coupon', { p_code: code });
    setBusy(false);
    if (error) return toast(errText(error), 'error', 'Coupon not applied');
    const r = data as { plan: PlanId; months: number; until: string };
    toast(`${PLANS[r.plan].name} is on for ${r.months} month${r.months > 1 ? 's' : ''}, until ${untilText(r.until)}.`, 'ok', 'Coupon applied');
    setCode(''); setPick(null); await load(); refresh();
  };

  return (
    <>
      <AppBar subtitle="Plan & billing" onAccount={() => {}} who="" extra={<button className="btn" onClick={() => nav('/app')}>‹ Back</button>}
        profile={<ProfileMenu name={org.owner_name || me.email} role={`Owner · ${org.name}`} items={[{ label: 'Account settings', onClick: () => nav('/app/account') }, { label: 'Back to my schedule', onClick: () => nav('/app') }]} />} />
      <div className="wrap account plan-page">
        <h1 className="acct-title">Plan &amp; billing</h1>
        {need && <div className="banner warn"><p><b>Your plan includes {lim} locations.</b> {cur === 'premium' || org.location_limit ? <>For more, email <a href="mailto:support@splityourshift.com?subject=More%20locations">support@splityourshift.com</a> and we'll set it up.</> : 'Choose a bigger plan to add another hotel, gas station or shop.'}</p></div>}
        {ended && <div className="banner warn"><p><b>{org.plan_source === 'trial' ? `Your free trial ended on ${untilText(org.plan_until)}.` : `Your ${PLANS[(org.plan ?? 'free') as PlanId].name} plan ended on ${untilText(org.plan_until)}.`}</b> Everything is still here. To add locations beyond Starter again, choose a plan below.</p></div>}

        <section className="panel plan-now">
          <div><span className="kicker">Your plan</span><h2>{plan.name}{trialLeft(org) ? <span className="tag ok trial-tag">Free trial</span> : null}<small> · {dollars(plan.price)}/month or {dollars(plan.yearly)}/year</small></h2>
            <p className="hint" style={{ margin: 0 }}>{trialLeft(org) ? `Free trial: ${trialLeft(org)} day${trialLeft(org) === 1 ? '' : 's'} left, until ${untilText(org.plan_until)}. Every feature is on. Choose a plan before it ends to keep your locations.` : cur === 'free' ? 'Starter: up to 2 locations, every feature.' : org.plan_until ? `Active until ${untilText(org.plan_until)}${org.plan_source === 'coupon' ? ' (coupon)' : ''}.` : org.plan_source === 'early_access' ? 'Early access: no end date.' : 'No end date.'}</p></div>
          <div className="plan-meter"><b>{locs}</b> of {lim ?? '∞'} location{lim === 1 ? '' : 's'} used{org.location_limit ? ' (custom limit)' : ''}
            {lim !== null && <span className="bar"><i style={{ width: `${Math.min(100, (locs / lim) * 100)}%` }} /></span>}</div>
        </section>

        <div className="plan-toggle-row"><BillingToggle value={billing} onChange={setBilling} /></div>
        <div className="plan-grid">
          {PLAN_ORDER.map((id) => { const p = PLANS[id], isCur = id === cur && !trialLeft(org);
            return (<div key={id} className={`plan-card${id === POPULAR ? ' pop' : ''}${pick === id ? ' on' : ''}`}>
              {id === POPULAR && <span className="tag ok plan-pop">Most popular</span>}
              <h3>{p.name}</h3><PlanPrice id={id} billing={billing} />
              <p className="hint" style={{ margin: 0 }}>{p.blurb}</p>
              <ul>{p.features.map((x) => <li key={x}>{x}</li>)}</ul>
              {onTrial ? (org.plan ?? 'free') === id
                  ? <button className="btn" disabled>Your trial plan</button>
                  : <button className="btn primary" disabled={busy} onClick={() => startTrial(id)}>Switch trial to {p.name}</button>
                : canTrial ? <button className="btn primary" disabled={busy} onClick={() => startTrial(id)}>{trialLabel()}</button>
                : isCur ? <button className="btn" disabled>Current plan</button>
                : id === 'free' ? <span className="hint" style={{ margin: 0, textAlign: 'center' }}>Included with every account</span>
                : <button className={`btn${pick === id ? ' primary' : ''}`} onClick={() => setPick(id)}>{pick === id ? 'Selected' : `Choose ${p.name}`}</button>}
              {(onTrial || canTrial) && <small className="trial-note">{canTrial ? `Free for ${TRIAL.days} days, no card needed.` : 'Same trial end date.'}{id !== 'free' && <> <button type="button" className="mini" onClick={() => setPick(id)}>Buy {p.name} now</button></>}</small>}
            </div>); })}
        </div>

        {sel && <section className="panel checkout" id="checkout">
          <div className="panel-head"><h2>Checkout · {sel.name} · {billing === 'yearly' ? 'Yearly' : 'Monthly'}</h2><button className="btn small" onClick={() => setPick(null)}>Cancel</button></div>
          <div className="co-grid">
            <div className="co-sum">
              <BillingToggle value={billing} onChange={setBilling} />
              <div className="co-line"><span>{sel.name} plan · {sel.locations === null ? 'unlimited locations' : `up to ${sel.locations} locations`}</span><b>{dollars(perMonth(sel, billing))}/month</b></div>
              <div className="co-line"><span>Billed</span><span>{billing === 'yearly' ? 'Once a year' : 'Every month'}</span></div>
              {billing === 'yearly' && <div className="co-line save"><span>You save with yearly</span><b>−{dollars(Math.round(yearlySave(sel)))}</b></div>}
              <div className="co-line total"><span>{billing === 'yearly' ? 'Total per year' : 'Total per month'}</span><b>{dollars(billing === 'yearly' ? sel.yearly : sel.price)}.00</b></div>
              <p className="hint" style={{ margin: 0 }}>US dollars. Cancel any time; your data stays.</p>
            </div>
            <div className="co-pay">
              <div className="co-coupon">
                <label htmlFor="co-code"><b>Have a coupon code?</b></label>
                <div className="co-row"><input id="co-code" type="text" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="e.g. SYS-7KQ4-M2XD" autoComplete="off" spellCheck={false}
                  onKeyDown={(e) => { if (e.key === 'Enter') redeem(); }} />
                  <button className="btn primary" disabled={busy || !code.trim()} onClick={redeem}>{busy ? 'Applying…' : 'Apply'}</button></div>
                <span className="hint" style={{ margin: 0 }}>A coupon unlocks its plan for the months it says. No card needed.</span>
              </div>
              <div className="co-card" aria-disabled="true">
                <b>Pay by card</b>
                <p className="hint" style={{ margin: 0 }}>Card payment is coming soon. For now, use a coupon code, or email <a href={`mailto:support@splityourshift.com?subject=${encodeURIComponent(`${sel.name} plan (${billing}) for ${org.name}`)}`}>support@splityourshift.com</a> and we'll set up your plan.</p>
              </div>
            </div>
          </div>
        </section>}

        {hist.length > 0 && <section className="panel"><div className="panel-head"><h2>Coupons used</h2></div>
          <div className="table-wrap"><table className="data"><thead><tr><th>Code</th><th>Plan</th><th>Months</th><th>Used</th><th>Plan until</th></tr></thead>
            <tbody>{hist.map((h) => <tr key={h.id}><td><code>{h.code}</code></td><td>{PLANS[h.plan].name}</td><td>{h.months}</td><td>{untilText(h.created_at)}</td><td>{untilText(h.plan_until)}</td></tr>)}</tbody></table></div></section>}
      </div>
    </>
  );
}
