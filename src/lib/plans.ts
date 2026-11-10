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

/** Row of the plan_catalog table (edited by the admin in Plans & pricing). */
export interface CatalogRow { id: PlanId; name: string; price_month: number; price_year: number; locations: number; blurb: string; features: string[]; popular: boolean; sort: number; updated_at?: string }
/** Which plan to highlight ("Most popular"). */
export let POPULAR: PlanId = 'plus';
/** Copy the admin's catalog into PLANS (the defaults above are used until it loads, or if it can't). */
export function applyCatalog(rows: CatalogRow[]) {
  for (const r of rows) {
    if (!PLANS[r.id]) continue;
    Object.assign(PLANS[r.id], { name: r.name, price: Number(r.price_month), yearly: Number(r.price_year), locations: r.locations, blurb: r.blurb, features: r.features ?? [] });
    if (r.popular) POPULAR = r.id;
  }
  const order = [...rows].sort((a, b) => a.sort - b.sort).map((r) => r.id).filter((id) => PLANS[id]);
  if (order.length === 3) PLAN_ORDER.splice(0, 3, ...order);
}
/** Free trial for new businesses (the admin sets it in Plans & pricing). */
export const TRIAL: { days: number; plan: PlanId } = { days: 14, plan: 'premium' };
/** Days left of this business's free trial, or null when it isn't on one. 0 = the trial ended. */
export function trialLeft(org: Pick<Org, 'plan_source' | 'plan_until'> | null | undefined): number | null {
  if (org?.plan_source !== 'trial' || !org.plan_until) return null;
  return Math.max(0, Math.ceil((new Date(org.plan_until).getTime() - Date.now()) / 86_400_000));
}
/** This business can still start its one free trial (on any plan). */
export const trialAvailable = (org: Pick<Org, 'plan' | 'plan_until' | 'plan_source' | 'trial_started_at'> | null | undefined) =>
  TRIAL.days > 0 && !!org && !org.trial_started_at && org.plan_source !== 'trial' && planOf(org) === 'free';
/** Button text: "Start 14-day free trial". */
export const trialLabel = () => `Start ${TRIAL.days}-day free trial`;
/** The plan picked before signing up ("plus|monthly"), without using it up. */
export const peekPlan = (): PlanId | null => { try { const p = (localStorage.getItem('sys-plan') ?? '').split('|')[0]; return p === 'free' || p === 'plus' || p === 'premium' ? p : null; } catch { return null; } };
export async function loadPlanCatalog(): Promise<CatalogRow[]> {
  const { supabase } = await import('./supabase');
  const { data: t } = await supabase.from('app_settings').select('trial_days, trial_plan').maybeSingle();
  if (t) Object.assign(TRIAL, { days: t.trial_days, plan: t.trial_plan });
  const { data, error } = await supabase.from('plan_catalog').select('*').order('sort');
  if (error || !data?.length) return [];
  applyCatalog(data as CatalogRow[]);
  return data as CatalogRow[];
}
