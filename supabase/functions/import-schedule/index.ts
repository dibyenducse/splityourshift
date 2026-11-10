// Reads a photo or PDF of a schedule (or a staff list) and returns the people and shifts in it.
// The owner checks the result in the app before anything is saved.
// Secret (Supabase dashboard → Edge Functions → Secrets): ANTHROPIC_API_KEY.
import { createClient } from 'npm:@supabase/supabase-js@2.117.3';
import Anthropic from 'npm:@anthropic-ai/sdk@1.3.0';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const PER_DAY = 25; // imports per business per day
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'week_start', 'people', 'shifts', 'note'],
  properties: {
    kind: { type: 'string', enum: ['schedule', 'staff_list', 'other'] },
    week_start: { type: 'string', description: 'The Monday of the week shown, as YYYY-MM-DD, or "" if no date is shown.' },
    people: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['name', 'phone', 'email'],
        properties: { name: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' } },
      },
    },
    shifts: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['name', 'day', 'start', 'end'],
        properties: {
          name: { type: 'string' },
          day: { type: 'string', enum: DAYS },
          start: { type: 'string', description: '24-hour time HH:MM' },
          end: { type: 'string', description: '24-hour time HH:MM; may be earlier than start for overnight shifts' },
        },
      },
    },
    note: { type: 'string', description: 'One short sentence about anything you could not read, or "".' },
  },
};

const SYSTEM = `You read photos and scans of work schedules and staff lists from small businesses (hotels, motels, gas stations, shops) and turn them into data.
Rules:
- people: every distinct worker named. Use the spelling written, with normal capitalization. If a name clearly means one of the business's existing workers (a nickname, first name only, or a small typo), use the existing worker's name exactly. phone and email are "" unless written next to the name.
- shifts: one entry per worker per day they work. Times in 24-hour HH:MM. Read shift codes or column headers (e.g. "7-3", "3-11", "11-7", "AM", "PM", "Night") into times; use the business's shift times listed below when a code matches one of them. A shift that ends after midnight keeps the day it starts on.
- Skip cells marked off, OFF, X, -, PTO, vacation or blank.
- kind: "schedule" if it shows who works when, "staff_list" if it only lists people, "other" if it is neither (then return empty lists).
- Never invent people or shifts you can't see. If something is unreadable, leave it out and say so in note.`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    // The app asks first whether import is switched on (a Claude key is set), and hides the button if not.
    if (body?.ping) return json({ ready: Boolean(Deno.env.get('ANTHROPIC_API_KEY')) });
    const url = Deno.env.get('SUPABASE_URL')!;
    const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const admin = createClient(url, service, { auth: { persistSession: false } });
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: { user } } = jwt ? await admin.auth.getUser(jwt) : { data: { user: null } };
    if (!user) return json({ error: 'Please log in again.' }, 401);

    const { org_id, location_id, data, media_type } = body;
    const { data: org } = await admin.from('organizations').select('id, owner_id').eq('id', org_id).single();
    if (!org || org.owner_id !== user.id) return json({ error: 'Only the owner can import a schedule.' }, 403);
    if (typeof data !== 'string' || !data.length) return json({ error: 'Choose a photo or PDF first.' }, 400);
    if (data.length > 14_000_000) return json({ error: 'That file is too big. Use a photo or PDF under 10 MB.' }, 400);
    const isPdf = media_type === 'application/pdf';
    if (!isPdf && !IMAGE_TYPES.includes(media_type)) return json({ error: 'Use a JPG, PNG or WebP photo, or a PDF.' }, 400);

    if (!Deno.env.get('ANTHROPIC_API_KEY')) {
      return json({ error: 'Import from a photo isn\'t switched on yet. Please contact support@splityourshift.com.', code: 'not_configured' }, 503);
    }
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const { count } = await admin.from('ai_imports').select('id', { count: 'exact', head: true }).eq('org_id', org.id).gte('created_at', since);
    if ((count ?? 0) >= PER_DAY) return json({ error: `You've imported ${PER_DAY} files today. Try again tomorrow.` }, 429);

    // What the business already has, so names and shift codes can be matched.
    const [{ data: emps }, { data: slots }] = await Promise.all([
      admin.from('employees').select('name').eq('org_id', org.id),
      location_id
        ? admin.from('shift_slots').select('start_hour, hours').eq('location_id', location_id).eq('active', true).is('only_date', null).order('start_hour')
        : Promise.resolve({ data: [] as { start_hour: number; hours: number }[] }),
    ]);
    const hh = (h: number) => `${String(h % 24).padStart(2, '0')}:00`;
    const context = `Existing workers: ${(emps ?? []).map((e) => e.name).join(', ') || 'none yet'}.
This location's shifts: ${(slots ?? []).map((s) => `${hh(s.start_hour)}-${hh(s.start_hour + s.hours)}`).join(', ') || 'not set'}.
Read the attached ${isPdf ? 'PDF' : 'image'}.`;

    const client = new Anthropic();
    const file = isPdf
      ? { type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data } }
      : { type: 'image' as const, source: { type: 'base64' as const, media_type, data } };
    // fallbacks: if the model declines, the API retries on Anthropic's recommended fallback model.
    // deno-lint-ignore no-explicit-any
    const params: any = {
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: 'user', content: [file, { type: 'text', text: context }] }],
    };
    let msg;
    try {
      msg = await client.beta.messages.create(params);
    } catch (e) {
      await admin.from('ai_imports').insert({ org_id: org.id, user_id: user.id, ok: false });
      if (e instanceof Anthropic.RateLimitError) return json({ error: 'Too many imports right now. Try again in a minute.' }, 429);
      if (e instanceof Anthropic.BadRequestError) return json({ error: 'We couldn\'t read that file. Try a clearer photo or a different file.' }, 400);
      if (e instanceof Anthropic.APIError) return json({ error: 'The reader is busy. Try again in a minute.' }, 502);
      throw e;
    }
    await admin.from('ai_imports').insert({ org_id: org.id, user_id: user.id, ok: msg.stop_reason === 'end_turn' });
    if (msg.stop_reason === 'refusal') return json({ error: 'We couldn\'t read that file. Try a photo of just the schedule.' }, 422);
    if (msg.stop_reason === 'max_tokens') return json({ error: 'That schedule is too long to read at once. Try one week per photo.' }, 422);
    // deno-lint-ignore no-explicit-any
    const text = msg.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
    let out;
    try { out = JSON.parse(text); } catch { return json({ error: 'We couldn\'t read that file. Try a clearer photo.' }, 422); }
    return json(out);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
