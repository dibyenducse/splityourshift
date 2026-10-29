import { supabase } from './supabase';
import { addDays } from './time';
import { cellKey, defAvail, type Changes } from './rules';
import type { Avail, Bundle, Emp, LedgerRow, Loc, LoginStatus, Note, Org, Req, Slot, TimeEntry, TimeFix } from './types';

export type Role = 'admin' | 'owner' | 'worker' | 'new';
export interface Me { role: Role; userId: string; email: string; orgId?: string; empId?: string }

export async function whoAmI(): Promise<Me | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const base = { userId: user.id, email: user.email ?? '' };
  const { data: adm } = await supabase.from('platform_admins').select('user_id').eq('user_id', user.id).maybeSingle();
  if (adm) return { ...base, role: 'admin' };
  const { data: org } = await supabase.from('organizations').select('id').eq('owner_id', user.id).order('created_at').limit(1).maybeSingle();
  if (org) {
    // An owner who also works shifts has a worker profile linked to their own login.
    const { data: own } = await supabase.from('employees').select('id').eq('org_id', org.id).eq('user_id', user.id).limit(1).maybeSingle();
    return { ...base, role: 'owner', orgId: org.id, empId: own?.id };
  }
  const { data: emp } = await supabase.from('employees').select('id, org_id').eq('user_id', user.id).order('created_at').limit(1).maybeSingle();
  if (emp) return { ...base, role: 'worker', orgId: emp.org_id, empId: emp.id };
  return { ...base, role: 'new' };
}

/** Links (or creates) the owner's own worker profile. `empId` = an existing worker on the staff list who is the owner. */
export async function myWorkerProfile(orgId: string, empId?: string): Promise<string> {
  const { data, error } = await supabase.rpc('my_worker_profile', { p_org: orgId, p_emp: empId ?? null });
  if (error) throw error;
  return data as string;
}

function must<T>(res: { data: T | null; error: unknown }): T {
  if (res.error) throw res.error;
  return res.data as T;
}

/** Loads one business. `full` = owner/admin (rates, phones, login status); workers get coworker names only. */
export async function loadBundle(orgId: string, week: string, full: boolean, myEmpId?: string): Promise<Bundle> {
  const from = addDays(week, -21), to = addDays(week, 34);
  const [org, locs, slots] = await Promise.all([
    supabase.from('organizations').select('*').eq('id', orgId).single().then(must<Org>),
    supabase.from('locations').select('*').eq('org_id', orgId).order('sort').order('created_at').then(must<Loc[]>),
    supabase.from('shift_slots').select('*').eq('org_id', orgId).eq('active', true).order('start_hour').then(must<Slot[]>),
  ]);
  let rows: Partial<Emp>[];
  if (full) rows = must(await supabase.from('employees').select('*').eq('org_id', orgId).order('name'));
  else {
    const co = must(await supabase.from('coworkers').select('id, org_id, name, hue').eq('org_id', orgId).order('name')) as Partial<Emp>[];
    const mine = myEmpId ? must(await supabase.from('employees').select('*').eq('id', myEmpId).maybeSingle()) as Partial<Emp> | null : null;
    rows = co.map((c) => (mine && c.id === mine.id ? mine : c));
  }
  const ids = rows.map((r) => r.id!);
  const locIds = locs.map((l) => l.id);
  const [links, avail, asg, reqs, ledger, status, entries, fixes] = await Promise.all([
    locIds.length ? supabase.from('employee_locations').select('employee_id, location_id').in('location_id', locIds).then(must<{ employee_id: string; location_id: string }[]>) : [],
    ids.length ? supabase.from('availability').select('*').in('employee_id', ids).then(must<(Avail & { employee_id: string })[]>) : [],
    supabase.from('assignments').select('slot_id, work_date, employee_id').eq('org_id', orgId).gte('work_date', from).lte('work_date', to).then(must<{ slot_id: string; work_date: string; employee_id: string }[]>),
    supabase.from('time_off_requests').select('*').eq('org_id', orgId).order('created_at', { ascending: false }).limit(300).then(must<Req[]>),
    supabase.from('ledger').select('*').eq('org_id', orgId).order('created_at', { ascending: false }).then(must<LedgerRow[]>),
    full ? supabase.rpc('login_status', { p_org: orgId }).then(must<{ employee_id: string; status: LoginStatus }[]>) : [],
    supabase.from('time_entries').select('*').eq('org_id', orgId).gte('work_date', addDays(from, -14)).lte('work_date', to).order('clock_in').then(must<TimeEntry[]>),
    supabase.from('time_fix_requests').select('*').eq('org_id', orgId).order('created_at', { ascending: false }).limit(200).then(must<TimeFix[]>),
  ]);
  const emps: Emp[] = rows.map((r) => {
    const a = defAvail();
    for (const x of avail.filter((v) => v.employee_id === r.id)) a[x.dow] = { dow: x.dow, mode: x.mode, from_hour: x.from_hour, to_hour: x.to_hour };
    return {
      id: r.id!, org_id: orgId, user_id: r.user_id ?? null, name: r.name ?? '', email: r.email ?? null, phone: r.phone ?? null,
      max_shifts: r.max_shifts ?? 5, rate: Number(r.rate ?? 0), hue: r.hue ?? 200, lang: r.lang ?? 'en', invited_at: r.invited_at ?? null,
      locs: links.filter((l) => l.employee_id === r.id).map((l) => l.location_id), avail: a,
      status: (status as { employee_id: string; status: LoginStatus }[]).find((s) => s.employee_id === r.id)?.status ?? 'none',
    };
  });
  const assign: Record<string, string> = {};
  for (const x of asg) assign[cellKey(x.slot_id, x.work_date)] = x.employee_id;
  return { org, locs, slots, emps, assign, reqs, ledger, entries, fixes };
}

export async function applyChanges(orgId: string, changes: Changes) {
  const p_changes = Object.entries(changes).map(([k, v]) => { const [slot_id, work_date] = k.split('|'); return { slot_id, work_date, employee_id: v }; });
  const { error } = await supabase.rpc('apply_changes', { p_org: orgId, p_changes });
  if (error) throw error;
}

export async function loadNotes(): Promise<Note[]> {
  const { data } = await supabase.from('notifications').select('id, text, request_id, read_at, created_at').order('created_at', { ascending: false }).limit(60);
  return (data ?? []) as Note[];
}
export async function markNotesRead(ids: string[]) {
  if (ids.length) await supabase.from('notifications').update({ read_at: new Date().toISOString() }).in('id', ids);
}

export async function sendInvite(employeeId: string): Promise<string> {
  const { data, error } = await supabase.functions.invoke('invite-worker', { body: { employee_id: employeeId } });
  if (error) {
    // functions.invoke hides the JSON body on non-2xx; read it for a readable message.
    const ctx = (error as { context?: Response }).context;
    try { const body = ctx ? await ctx.json() : null; if (body?.error) throw new Error(body.error); } catch (e) { if (e instanceof Error && e.message) throw e; }
    throw error;
  }
  return (data as { sent: string }).sent;
}

export const siteUrl = () => window.location.origin + window.location.pathname;
