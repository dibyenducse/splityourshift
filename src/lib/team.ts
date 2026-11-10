import { supabase } from './supabase';
import { siteUrl } from './api';

export interface JoinLink { code: string; active: boolean; created_at: string }

/** The shareable sign-up link for a join code. */
export const joinUrl = (code: string) => `${siteUrl()}#/join/${code}`;

/** The business's join link (made the first time). `reset` makes a new one and the old link stops working. */
export async function loadJoinLink(orgId: string, reset = false): Promise<JoinLink> {
  const { data, error } = await supabase.rpc('join_link', { p_org: orgId, p_reset: reset });
  if (error) throw error;
  return data as JoinLink;
}
export async function setJoinActive(orgId: string, active: boolean) {
  const { error } = await supabase.rpc('join_link_active', { p_org: orgId, p_active: active });
  if (error) throw error;
}

/** A join code picked up before logging in (e.g. "Continue with Google" on the join page); used once the user is in. */
export const pendingJoin = {
  set: (c: string) => { try { localStorage.setItem('sys-join', c); } catch { /* private mode */ } },
  take: () => { try { const c = localStorage.getItem('sys-join'); localStorage.removeItem('sys-join'); return c; } catch { return null; } },
};

// ---------------------------------------------------------------- import from a photo
export type Day = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export const DAYS: Day[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export interface Imported {
  kind: 'schedule' | 'staff_list' | 'other';
  week_start: string;
  people: { name: string; phone: string; email: string }[];
  shifts: { name: string; day: Day; start: string; end: string }[];
  note: string;
}

/** Photos are made smaller (longest side 2000 px, JPEG) before upload; PDFs are sent as they are. */
async function fileToBase64(file: File): Promise<{ data: string; media_type: string }> {
  const asB64 = (blob: Blob) => new Promise<string>((ok, bad) => {
    const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] ?? ''); r.onerror = () => bad(r.error); r.readAsDataURL(blob);
  });
  if (file.type === 'application/pdf') return { data: await asB64(file), media_type: 'application/pdf' };
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    const g = c.getContext('2d')!; g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise<Blob | null>((ok) => c.toBlob(ok, 'image/jpeg', 0.88));
    if (blob) return { data: await asB64(blob), media_type: 'image/jpeg' };
  } catch { /* e.g. HEIC the browser can't open: send it as is and let the server say */ }
  return { data: await asB64(file), media_type: file.type || 'image/jpeg' };
}

/** Whether photo import is switched on (the server has a Claude key). Asked once. */
let ready: Promise<boolean> | null = null;
export function importReady(): Promise<boolean> {
  ready ??= supabase.functions.invoke('import-schedule', { body: { ping: true } }).then(({ data }) => Boolean(data?.ready), () => false);
  return ready;
}

export async function importFromFile(orgId: string, locationId: string | null, file: File): Promise<Imported> {
  const body = { org_id: orgId, location_id: locationId, ...(await fileToBase64(file)) };
  const { data, error } = await supabase.functions.invoke('import-schedule', { body });
  if (error) {
    const ctx = (error as { context?: Response }).context;
    let msg = '';
    try { const j = ctx ? await ctx.json() : null; msg = j?.error ?? ''; } catch { /* not JSON */ }
    throw new Error(msg || "We couldn't read that file. Try again in a minute.");
  }
  return data as Imported;
}

/** "07:30" → 7.5 */
export const hourOf = (t: string) => { const [h, m] = t.split(':').map(Number); return (h || 0) + (m || 0) / 60; };
/** Loose name key for matching "maria g." to "Maria Garcia". */
export const nameKey = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
