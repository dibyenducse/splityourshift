// Clock-in / clock-out phone reminders.
// GET  → the public key browsers need to subscribe to push notifications.
// POST → sends the reminders that are due now (called every 5 minutes by pg_cron; safe to call more often,
//        because due_reminders() records each reminder so it is only sent once).
// Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, SITE_URL (set by .github/workflows/supabase.yml).
import { createClient } from 'npm:@supabase/supabase-js@2.117.3';
import webpush from 'npm:web-push@3.6.7';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const publicKey = Deno.env.get('VAPID_PUBLIC_KEY') ?? '';
  if (req.method === 'GET') return json({ publicKey });

  try {
    const privateKey = Deno.env.get('VAPID_PRIVATE_KEY');
    if (!publicKey || !privateKey) return json({ error: 'Push keys are not set up yet.' }, 500);
    webpush.setVapidDetails(Deno.env.get('VAPID_SUBJECT') || 'mailto:support@splityourshift.app', publicKey, privateKey);
    const site = (Deno.env.get('SITE_URL') ?? '').replace(/\/?$/, '/');

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
    const { data: due, error } = await admin.rpc('due_reminders');
    if (error) throw error;

    let sent = 0, removed = 0;
    for (const r of (due ?? []) as { user_id: string; kind: string; title: string; body: string }[]) {
      const { data: subs } = await admin.from('push_subscriptions').select('id, endpoint, p256dh, auth').eq('user_id', r.user_id);
      for (const s of subs ?? []) {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            JSON.stringify({ title: r.title, body: r.body, tag: `clock-${r.kind}`, url: `${site}#/app` }),
            { TTL: 60 * 60 },
          );
          sent++;
        } catch (e) {
          const code = (e as { statusCode?: number }).statusCode;
          if (code === 404 || code === 410) { await admin.from('push_subscriptions').delete().eq('id', s.id); removed++; }
        }
      }
    }
    return json({ due: due?.length ?? 0, sent, removed });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
