import { supabase } from './supabase';

const FLAG = 'sys-push-on';
export const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
export const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

export function pushIsOn() {
  try { return pushSupported() && Notification.permission === 'granted' && localStorage.getItem(FLAG) === '1'; } catch { return false; }
}

const b64ToBytes = (b64: string) => {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

/** Asks for permission and saves this phone's push address so shift reminders reach it. */
export async function enablePush(userId: string) {
  if (!pushSupported()) {
    throw new Error(isIOS() && !isStandalone()
      ? 'On iPhone: tap the Share button, choose "Add to Home Screen", open SplitYourShift from your home screen, then turn on reminders.'
      : "This browser can't show notifications. Try Chrome or Safari.");
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notifications are blocked. Allow them for this site in your browser settings, then try again.');
  const reg = await navigator.serviceWorker.ready;
  const { data, error } = await supabase.functions.invoke('send-reminders', { method: 'GET' });
  const key = (data as { publicKey?: string } | null)?.publicKey;
  if (error || !key) throw new Error('Reminders are not set up on the server yet. Ask the site admin to run "Set up database".');
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) }));
  const j = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  const { error: e2 } = await supabase.from('push_subscriptions').upsert({ user_id: userId, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth }, { onConflict: 'endpoint' });
  if (e2) throw e2;
  try { localStorage.setItem(FLAG, '1'); } catch { /* storage unavailable */ }
}

export function registerServiceWorker() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
}
