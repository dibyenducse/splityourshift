import { PLANS, bestSavePct, dollars, perMonth, yearlySave, type Billing, type PlanId } from '../lib/plans';

/** Monthly / Yearly switch in one box; yearly shows what it saves. */
export function BillingToggle({ value, onChange }: { value: Billing; onChange: (b: Billing) => void }) {
  return (
    <div className="billing-toggle" role="radiogroup" aria-label="Billing">
      {(['monthly', 'yearly'] as const).map((b) => (
        <button key={b} type="button" role="radio" aria-checked={value === b} className={value === b ? 'on' : ''} onClick={() => onChange(b)}>
          <b>{b === 'monthly' ? 'Monthly' : 'Yearly'}</b>
          <small>{b === 'monthly' ? 'Pay every month' : `Save up to ${bestSavePct()}%`}</small>
        </button>))}
    </div>
  );
}

/** Big price for a plan card: per month, and for yearly the total billed once a year. */
export function PlanPrice({ id, billing }: { id: PlanId; billing: Billing }) {
  const p = PLANS[id];
  return (<>
    <div className="amt">{dollars(perMonth(p, billing))}<small>/month</small></div>
    <div className="amt-sub">{billing === 'yearly'
      ? <><s>{dollars(p.price)}</s> · {dollars(p.yearly)} billed yearly · <b className="save">save {dollars(Math.round(yearlySave(p)))}</b></>
      : <>billed monthly · or {dollars(perMonth(p, 'yearly'))}/month yearly</>}</div>
  </>);
}
