import type { Org } from './types';

export type PlanId = 'free' | 'plus' | 'premium';
export type Billing = 'monthly' | 'yearly';
export interface Plan { id: PlanId; name: string; price: number; /** paid once a year */ yearly: number; locations: number | null; blurb: string; features: string[] }

/** The three plans. Change prices or limits here and in supabase (plan_locations). Yearly costs less than 12 months. */
export const PLANS: Record<PlanId, Plan> = {
  free: { id: 'free', name: 'Starter', price: 19, yearly: 199, locations: 2, blurb: 'One or two hotels, gas stations or shops',
    features: ['Up to 2 locations', 'Drag-and-drop schedule, swaps, time off', 'Time clock and payroll', 'Shift reports and task lists'] },
  plus: { id: 'plus', name: 'Plus', price: 39, yearly: 399, locations: 5, blurb: 'A growing group under one account',
    features: ['Up to 5 locations', 'Everything in Starter', 'Share workers between locations', 'Payroll for each business'] },
  premium: { id: 'premium', name: 'Premium', price: 59, yearly: 599, locations: 10, blurb: 'For groups with many locations',
    features: ['Up to 10 locations', 'Everything in Plus', 'Priority support', 'More than 10? Contact us'] },
};
export const PLAN_ORDER: PlanId[] = ['free', 'plus', 'premium'];

/** Price per month: the monthly price, or the yearly price spread over 12 months. */
export const perMonth = (p: Plan, b: Billing) => (b === 'yearly' ? Math.round((p.yearly / 12) * 100) / 100 : p.price);
/** What paying yearly saves compared with 12 monthly payments. */
export const yearlySave = (p: Plan) => p.price * 12 - p.yearly;
export const dollars = (n: number) => '$' + (n % 1 ? n.toFixed(2) : String(n));

/** The plan in force now: a paid plan that has ended counts as Starter. */
export function planOf(org: Pick<Org, 'plan' | 'plan_until'> | null | undefined): PlanId {
  const p = (org?.plan ?? 'free') as PlanId;
  if (p === 'free') return 'free';
  return !org?.plan_until || new Date(org.plan_until).getTime() > Date.now() ? p : 'free';
}
/** How many locations this business may have: support's custom limit, or the plan's. */
export const locLimitOf = (org: Pick<Org, 'plan' | 'plan_until' | 'location_limit'> | null | undefined) => org?.location_limit ?? PLANS[planOf(org)].locations;
export const locLimitText = (p: PlanId) => PLANS[p].locations === null ? 'unlimited locations' : `up to ${PLANS[p].locations} location${PLANS[p].locations === 1 ? '' : 's'}`;
/** Best yearly saving across the plans, as a whole percent (for the switch label). */
export const bestSavePct = () => Math.max(...(['free', 'plus', 'premium'] as PlanId[]).map((id) => Math.round((yearlySave(PLANS[id]) / (PLANS[id].price * 12)) * 100)));
export const untilText = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';

/** A plan picked on the home page before signing up; opened once the owner is in. */
export const wantPlan = { set: (p: string) => { try { localStorage.setItem('sys-plan', p); } catch { /* private */ } },
  take: () => { try { const p = localStorage.getItem('sys-plan'); localStorage.removeItem('sys-plan'); return p; } catch { return null; } } };
