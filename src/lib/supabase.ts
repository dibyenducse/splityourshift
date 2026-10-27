import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const configured = Boolean(url && key);

// Email links (invite, password reset, sign-up confirmation) land on the site with tokens in the URL hash.
// Read them before the router sees the hash, then swap the hash for an app route so tokens never stay in history.
const landingHash = typeof window !== 'undefined' ? window.location.hash : '';
const param = (n: string) => new URLSearchParams(landingHash.replace(/^#/, '')).get(n);
const linkType = param('type');
export const landingTokens = param('access_token')
  ? { access_token: param('access_token') ?? '', refresh_token: param('refresh_token') ?? '' } : null;
export const authLanding: 'invite' | 'recovery' | 'session' | 'error' | null =
  linkType === 'invite' || linkType === 'recovery' ? linkType : param('error_code') ? 'error' : landingTokens ? 'session' : null;
export const authLandingError = (param('error_description') ?? '').replace(/\+/g, ' ');
if (authLanding && typeof window !== 'undefined') {
  window.history.replaceState(null, '', window.location.pathname + window.location.search + (authLanding === 'session' ? '#/app' : '#/set-password'));
}

export const supabase = createClient(url || 'https://not-configured.supabase.co', key || 'not-configured', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, flowType: 'implicit' },
});

/** Turns a Supabase/Postgres error into a sentence for a toast. */
export function errText(e: unknown): string {
  if (!e) return 'Something went wrong. Try again.';
  const m = typeof e === 'string' ? e : (e as { message?: string }).message ?? String(e);
  return m.replace(/^.*?ERROR:\s*/, '').trim();
}
