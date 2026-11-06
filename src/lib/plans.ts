import type { Org } from './types';

export type PlanId = 'free' | 'plus' | 'premium';
export type Billing = 'monthly' | 'yearly';
export interface Plan { id: PlanId; name: string; price: number; /** paid once a year */ yearly: number; locations: number | null; blurb: string; features: string[] }

/** The three plans. Change prices or limits here and in supabase (plan_locations). Yearly = 10 months' price. */
export const PLANS: Record<PlanId, Plan> = {
  free: { id: 'free', name: 'Starter', price: 0, yearly: 0, locations: 1, blurb: 'One hotel, gas station or shop',
    features: ['1 location', 'Drag-and-drop schedule, swaps, time off', 'Time clock and payroll', 'Shift reports and task lists'] },
  plus: { id: 'plus', name: 'Plus', price: 39, yearly: 390, locations: 3, blurb: 'A few locations under one account',
    features: ['Up to 3 locations', 'Everything in Starter', 'Share workers between locations', 'Payroll for each business'] },
  premium: { id: 'premium', name: 'Premium', price: 99, yearly: 990, locations: null, blurb: 'For groups with more than 3 locations',
    features: ['Unlimited locations', 'Everything in Plus', 'Priority support'] },
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
export const locLimitText = (p: PlanId) => PLANS[p].locations === null ? 'unlimited locations' : `${PLANS[p].locations} location${PLANS[p].locations === 1 ? '' : 's'}`;
export const untilText = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';

/** A plan picked on the home page before signing up; opened once the owner is in. */
export const wantPlan = { set: (p: string) => { try { localStorage.setItem('sys-plan', p); } catch { /* private */ } },
  take: () => { try { const p = localStorage.getItem('sys-plan'); localStorage.removeItem('sys-plan'); return p; } catch { return null; } } };
