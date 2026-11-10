-- Messages: one-to-one chat inside a business (owner ↔ workers, and workers with each other).
-- Only the two people in a conversation can read it. Sending goes through send_message() so both must be in the business.

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations on delete cascade,
  sender uuid not null references auth.users on delete cascade,
  recipient uuid not null references auth.users on delete cascade,
  body text not null check (length(btrim(body)) between 1 and 2000),
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index if not exists messages_inbox on public.messages (recipient, read_at);
create index if not exists messages_pair on public.messages (org_id, least(sender, recipient), greatest(sender, recipient), created_at desc);
alter table public.messages enable row level security;
drop policy if exists "the two people read" on public.messages;
create policy "the two people read" on public.messages for select using (sender = auth.uid() or recipient = auth.uid());
drop policy if exists "recipient marks read" on public.messages;
create policy "recipient marks read" on public.messages for update using (recipient = auth.uid()) with check (recipient = auth.uid());
revoke insert, update, delete on public.messages from anon, authenticated;
grant select on public.messages to authenticated;
grant update (read_at) on public.messages to authenticated;
alter publication supabase_realtime add table public.messages;

-- Is this login part of the business (the owner, or a worker with a login)?
create or replace function public.org_user(p_org uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from organizations where id = p_org and owner_id = p_user)
      or exists (select 1 from employees where org_id = p_org and user_id = p_user)
$$;

create or replace function public.send_message(p_org uuid, p_to uuid, p_body text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_body text := btrim(coalesce(p_body, ''));
begin
  if auth.uid() is null or not org_user(p_org, auth.uid()) then raise exception 'Please log in again.'; end if;
  if p_to = auth.uid() then raise exception 'Pick someone else to message.'; end if;
  if not org_user(p_org, p_to) then raise exception 'This person can''t get messages yet: they need a login first.'; end if;
  if v_body = '' then raise exception 'Type a message first.'; end if;
  if length(v_body) > 2000 then raise exception 'That message is too long (2000 characters at most).'; end if;
  insert into messages (org_id, sender, recipient, body) values (p_org, auth.uid(), p_to, v_body) returning id into v_id;
  return v_id;
end $$;
revoke execute on function public.send_message(uuid, uuid, text) from public, anon;
grant execute on function public.send_message(uuid, uuid, text) to authenticated;

-- People I can message in this business, with the last message and how many I haven't read.
create or replace function public.message_contacts(p_org uuid)
returns table (user_id uuid, name text, role text, hue int, last_body text, last_at timestamptz, last_from_me boolean, unread int)
language sql stable security definer set search_path = public as $$
  with people as (
    select o.owner_id as uid, coalesce(nullif(o.owner_name, ''), 'Manager') as name, 'owner'::text as role, 30 as hue, 0 as ord
      from organizations o where o.id = p_org
    union all
    select e.user_id, e.name, 'worker', e.hue::int, 1
      from employees e where e.org_id = p_org and e.user_id is not null
        and e.user_id <> (select owner_id from organizations where id = p_org)
  )
  select p.uid, p.name, p.role, p.hue, l.body, l.created_at, l.sender = auth.uid(),
    (select count(*)::int from messages m where m.org_id = p_org and m.sender = p.uid and m.recipient = auth.uid() and m.read_at is null)
  from people p
  left join lateral (select m.body, m.created_at, m.sender from messages m
    where m.org_id = p_org and ((m.sender = auth.uid() and m.recipient = p.uid) or (m.sender = p.uid and m.recipient = auth.uid()))
    order by m.created_at desc limit 1) l on true
  where org_user(p_org, auth.uid()) and p.uid <> auth.uid()
  order by l.created_at desc nulls last, p.ord, p.name
$$;
revoke execute on function public.message_contacts(uuid) from public, anon;
grant execute on function public.message_contacts(uuid) to authenticated;
