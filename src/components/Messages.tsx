import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { supabase, errText } from '../lib/supabase';
import { ago } from '../lib/time';
import { useToast } from './ui';

export interface Contact { user_id: string; name: string; role: 'owner' | 'worker'; hue: number; last_body: string | null; last_at: string | null; last_from_me: boolean | null; unread: number }
interface Msg { id: string; sender: string; recipient: string; body: string; created_at: string; read_at: string | null }

/** Unread messages for me in this business, kept live. */
export function useUnreadMessages(orgId: string | undefined, userId: string | undefined) {
  const [n, setN] = useState(0);
  const uid = useId();
  const load = useCallback(async () => {
    if (!orgId || !userId) return;
    const { count } = await supabase.from('messages').select('id', { count: 'exact', head: true }).eq('org_id', orgId).eq('recipient', userId).is('read_at', null);
    setN(count ?? 0);
  }, [orgId, userId]);
  useEffect(() => {
    if (!orgId || !userId) return;
    load();
    const ch = supabase.channel(`msg-n-${userId}-${uid}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages', filter: `recipient=eq.${userId}` }, () => load())
      .subscribe();
    const t = setInterval(load, 60_000);
    return () => { supabase.removeChannel(ch); clearInterval(t); };
  }, [orgId, userId, load, uid]);
  return { unread: n, reloadUnread: load };
}

const initials = (s: string) => s.split(/\s+/).filter(Boolean).slice(0, 2).map((x) => x[0]!.toUpperCase()).join('');
const timeOf = (iso: string) => {
  const d = new Date(iso), today = new Date();
  return d.toDateString() === today.toDateString() ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
};

/** Messages: people on the left (or first on a phone), the conversation on the right. */
export function MessagesView({ orgId, userId, withUser, onRead, disabled }: { orgId: string; userId: string; withUser?: string | null; onRead?: () => void; disabled?: boolean }) {
  const toast = useToast();
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [open, setOpen] = useState<string | null>(withUser ?? null);
  const [q, setQ] = useState('');
  const uid = useId();
  const loadContacts = useCallback(async () => {
    const { data, error } = await supabase.rpc('message_contacts', { p_org: orgId });
    if (error) toast(errText(error), 'error', "Couldn't load messages"); else setContacts(data as Contact[]);
  }, [orgId, toast]);
  useEffect(() => { loadContacts(); }, [loadContacts]);
  useEffect(() => { if (withUser) setOpen(withUser); }, [withUser]);
  useEffect(() => {
    const ch = supabase.channel(`msg-list-${userId}-${uid}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `recipient=eq.${userId}` }, () => loadContacts())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [userId, loadContacts, uid]);

  const cur = contacts?.find((c) => c.user_id === open) ?? null;
  const shown = (contacts ?? []).filter((c) => !q.trim() || c.name.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <section className={`panel msg-wrap${open ? ' has-open' : ''}`}>
      <div className="msg-list">
        <div className="msg-list-h"><h2>Messages</h2>
          {(contacts?.length ?? 0) > 6 && <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people…" aria-label="Search people" />}</div>
        {!contacts ? <p className="hint">Loading…</p> : !contacts.length
          ? <p className="empty-note">Nobody to message yet. People show up here once they have a login.</p>
          : <div className="msg-people">{shown.map((c) => (
            <button key={c.user_id} className={`msg-person${open === c.user_id ? ' on' : ''}${c.unread ? ' unread' : ''}`} onClick={() => setOpen(c.user_id)}>
              <span className="msg-av" style={{ ['--h' as string]: c.hue }}>{initials(c.name)}</span>
              <span className="msg-who"><b>{c.name}{c.role === 'owner' && <span className="tag plain">Manager</span>}</b>
                <small>{c.last_body ? `${c.last_from_me ? 'You: ' : ''}${c.last_body}` : 'No messages yet'}</small></span>
              <span className="msg-meta">{c.last_at && <small>{ago(c.last_at)}</small>}{c.unread > 0 && <span className="pip">{c.unread}</span>}</span>
            </button>))}</div>}
      </div>
      <div className="msg-thread">
        {cur ? <Thread key={cur.user_id} orgId={orgId} userId={userId} other={cur} onBack={() => setOpen(null)} disabled={disabled}
          onChange={() => { loadContacts(); onRead?.(); }} />
          : <div className="msg-empty"><span aria-hidden="true">💬</span><p>Pick someone to message.{contacts?.some((c) => c.role === 'owner') ? ' Your manager is on the list.' : ''}</p></div>}
      </div>
    </section>
  );
}

function Thread({ orgId, userId, other, onBack, onChange, disabled }: { orgId: string; userId: string; other: Contact; onBack: () => void; onChange: () => void; disabled?: boolean }) {
  const toast = useToast();
  const [msgs, setMsgs] = useState<Msg[] | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const uid = useId();
  const load = useCallback(async () => {
    const { data, error } = await supabase.from('messages').select('id, sender, recipient, body, created_at, read_at').eq('org_id', orgId)
      .or(`and(sender.eq.${userId},recipient.eq.${other.user_id}),and(sender.eq.${other.user_id},recipient.eq.${userId})`)
      .order('created_at', { ascending: false }).limit(200);
    if (error) return toast(errText(error), 'error', "Couldn't load");
    const list = (data as Msg[]).reverse(); setMsgs(list);
    if (list.some((m) => m.recipient === userId && !m.read_at)) {
      await supabase.from('messages').update({ read_at: new Date().toISOString() }).eq('org_id', orgId).eq('sender', other.user_id).eq('recipient', userId).is('read_at', null);
      onChange();
    }
  }, [orgId, userId, other.user_id, toast]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const ch = supabase.channel(`msg-t-${userId}-${other.user_id}-${uid}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `recipient=eq.${userId}` }, (p) => { if ((p.new as Msg).sender === other.user_id) load(); })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [userId, other.user_id, load, uid]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [msgs?.length]);

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    const body = text.trim(); if (!body || busy) return;
    setBusy(true);
    const { data, error } = await supabase.rpc('send_message', { p_org: orgId, p_to: other.user_id, p_body: body });
    setBusy(false);
    if (error) return toast(errText(error), 'error', 'Not sent');
    setText('');
    setMsgs((m) => [...(m ?? []), { id: String(data), sender: userId, recipient: other.user_id, body, created_at: new Date().toISOString(), read_at: null }]);
    onChange();
  };
  let lastDay = '';
  return (<>
    <div className="msg-thread-h"><button className="btn icon msg-back" onClick={onBack} aria-label="Back to people">‹</button>
      <span className="msg-av" style={{ ['--h' as string]: other.hue }}>{initials(other.name)}</span>
      <div><b>{other.name}</b><small>{other.role === 'owner' ? 'Manager' : 'Worker'}</small></div></div>
    <div className="msg-scroll" aria-live="polite">
      {!msgs ? <p className="hint">Loading…</p> : !msgs.length ? <p className="msg-hint">Say hi to {other.name.split(' ')[0]}. Only the two of you see this conversation.</p>
        : msgs.map((m) => {
          const day = new Date(m.created_at).toDateString(), sep = day !== lastDay; lastDay = day; const mine = m.sender === userId;
          return (<div key={m.id}>
            {sep && <div className="msg-day">{new Date(m.created_at).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}</div>}
            <div className={`msg-b ${mine ? 'me' : 'them'}`}><p>{m.body}</p><small>{timeOf(m.created_at)}{mine && m.read_at ? ' · Seen' : ''}</small></div></div>);
        })}
      <div ref={end} />
    </div>
    <form className="msg-compose" onSubmit={send}>
      <textarea value={text} rows={1} maxLength={2000} placeholder={`Message ${other.name.split(' ')[0]}…`} aria-label={`Message ${other.name}`} disabled={disabled}
        onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
      <button className="btn primary" type="submit" disabled={!text.trim() || busy || disabled}>{busy ? 'Sending…' : 'Send'}</button>
    </form>
  </>);
}
