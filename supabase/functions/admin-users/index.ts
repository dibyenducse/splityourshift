// Admin actions on logins: block (ban), unblock, and send a password-reset email.
// Only a SplitYourShift admin (platform_admins) can call it. Every action is written to admin_audit.
// Secrets: SITE_URL (where the reset link opens), set by the "Set up database" workflow.
import { createClient } from 'npm:@supabase/supabase-js@2.117.3';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const site = (Deno.env.get('SITE_URL') ?? '').replace(/\/?$/, '/');
    const admin = createClient(url, service, { auth: { persistSession: false } });

    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: { user: me } } = jwt ? await admin.auth.getUser(jwt) : { data: { user: null } };
    if (!me) return json({ error: 'Please log in again.' }, 401);
    const { data: isAdmin } = await admin.from('platform_admins').select('user_id').eq('user_id', me.id).maybeSingle();
    if (!isAdmin) return json({ error: 'Only the SplitYourShift admin can do this.' }, 403);

    const { action, user_id, reason } = await req.json() as { action: 'block' | 'unblock' | 'reset'; user_id: string; reason?: string };
    if (!user_id || !['block', 'unblock', 'reset'].includes(action)) return json({ error: 'Pick a user and an action.' }, 400);
    const { data: { user: target }, error: ge } = await admin.auth.admin.getUserById(user_id);
    if (ge || !target) return json({ error: 'That user was not found.' }, 404);
    const { data: targetAdmin } = await admin.from('platform_admins').select('user_id').eq('user_id', user_id).maybeSingle();
    if (action === 'block' && (targetAdmin || user_id === me.id)) return json({ error: "Admins can't be blocked here." }, 400);

    let result = '';
    if (action === 'block') {
      const { error } = await admin.auth.admin.updateUserById(user_id, { ban_duration: '876000h' }); // about 100 years
      if (error) throw error;
      result = `${target.email} is blocked and can't log in.`;
    } else if (action === 'unblock') {
      const { error } = await admin.auth.admin.updateUserById(user_id, { ban_duration: 'none' });
      if (error) throw error;
      result = `${target.email} can log in again.`;
    } else {
      if (!target.email) return json({ error: 'This login has no email address (phone only).' }, 400);
      const { error } = await admin.auth.resetPasswordForEmail(target.email, { redirectTo: site });
      if (error) throw error;
      result = `Password reset email sent to ${target.email}.`;
    }
    await admin.from('admin_audit').insert({
      admin_id: me.id, admin_email: me.email, action: `user.${action}`, target_type: 'user', target_id: user_id, target_name: target.email ?? target.phone ?? user_id,
      detail: reason ? { reason } : null,
    });
    return json({ ok: true, message: result });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
