// Sends a worker their login invite (or a password-reset link if they already have a login).
// Only the owner of the worker's business can call it.
// Secrets (Supabase dashboard → Edge Functions → Secrets): SITE_URL, e.g. https://dibyenducse.github.io/splityourshift/
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
    const { data: { user } } = jwt ? await admin.auth.getUser(jwt) : { data: { user: null } };
    if (!user) return json({ error: 'Please log in again.' }, 401);

    const { employee_id } = await req.json();
    const { data: emp } = await admin
      .from('employees')
      .select('id, name, email, user_id, org_id, organizations!inner(owner_id, name)')
      .eq('id', employee_id)
      .single();
    // deno-lint-ignore no-explicit-any
    const org = emp && (emp as any).organizations;
    if (!emp || !org || org.owner_id !== user.id) return json({ error: 'Only the owner can invite this worker.' }, 403);
    if (!emp.email) return json({ error: 'Add an email address to this worker first.' }, 400);

    const redirectTo = site; // the app reads the invite/reset tokens from the URL and opens "Set your password"
    const stamp = { invited_at: new Date().toISOString() };

    if (emp.user_id) {
      const { data: u } = await admin.auth.admin.getUserById(emp.user_id);
      // Never set a password yet: send a fresh invite instead of a reset.
      if (u?.user && !u.user.last_sign_in_at) {
        const { error } = await admin.auth.admin.inviteUserByEmail(emp.email, { redirectTo, data: { name: emp.name, org: org.name } });
        if (!error) { await admin.from('employees').update(stamp).eq('id', emp.id); return json({ sent: 'invite' }); }
      }
      const { error } = await admin.auth.resetPasswordForEmail(emp.email, { redirectTo });
      if (error) throw error;
      return json({ sent: 'reset' });
    }

    const { data, error } = await admin.auth.admin.inviteUserByEmail(emp.email, { redirectTo, data: { name: emp.name, org: org.name } });
    if (error) {
      // The email already has a login (for example they work for another owner too): link it.
      const { data: existing } = await admin.rpc('auth_user_id_by_email', { p_email: emp.email });
      if (!existing) throw error;
      await admin.from('employees').update({ user_id: existing, ...stamp }).eq('id', emp.id);
      return json({ sent: 'linked' });
    }
    await admin.from('employees').update({ user_id: data.user.id, ...stamp }).eq('id', emp.id);
    return json({ sent: 'invite' });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
