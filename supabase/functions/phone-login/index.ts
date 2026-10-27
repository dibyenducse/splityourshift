// Lets a worker log in with their phone number + password.
// Looks up the email behind the phone on the server, so emails are never exposed to the browser.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const wrong = json({ error: 'Wrong phone number or password.' }, 400);
  try {
    const { phone, password } = await req.json();
    const digits = String(phone ?? '').replace(/\D/g, '');
    if (digits.length < 7 || !password) return wrong;

    const url = Deno.env.get('SUPABASE_URL')!;
    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
    const { data: rows } = await admin.from('employees').select('user_id').eq('phone_digits', digits).not('user_id', 'is', null).limit(1);
    if (!rows?.length) return wrong;
    const { data: u } = await admin.auth.admin.getUserById(rows[0].user_id);
    if (!u?.user?.email) return wrong;

    const anon = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { auth: { persistSession: false } });
    const { data, error } = await anon.auth.signInWithPassword({ email: u.user.email, password });
    if (error || !data.session) return wrong;
    return json({ access_token: data.session.access_token, refresh_token: data.session.refresh_token });
  } catch {
    return wrong;
  }
});
