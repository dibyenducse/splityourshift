import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../App';
import { supabase } from '../lib/supabase';
import { loadNotes, markNotesRead } from '../lib/api';
import { ago, weekTitle } from '../lib/time';
import type { Note } from '../lib/types';
import { Loading, Logo, Sheet } from '../components/ui';
import OwnerApp from './Owner';
import WorkerApp from './Worker';
import AdminApp from './Admin';
import Onboarding from './Onboarding';

/** Top bar shared by all three account types. */
export function AppBar({ subtitle, week, setWeek, extra, notes, onNotes, onAccount, who }: {
  subtitle: string; week?: string; setWeek?: (w: string) => void; extra?: ReactNode;
  notes?: Note[]; onNotes?: () => void; onAccount: () => void; who: ReactNode;
}) {
  const unread = notes?.filter((n) => !n.read_at).length ?? 0;
  const step = (n: number) => { if (week && setWeek) { const d = new Date(week + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); setWeek(d.toISOString().slice(0, 10)); } };
  return (
    <header className="topbar"><div className="wrap">
      <Link className="brand" to="/" title="Go to the home page"><Logo /><span><b>SplitYourShift</b><small>{subtitle}</small></span></Link>
      {week && setWeek && <div className="weeknav">
        <button className="btn icon" onClick={() => step(-7)} aria-label="Previous week">‹</button>
        <div className="label">{weekTitle(week)}</div>
        <button className="btn icon" onClick={() => step(7)} aria-label="Next week">›</button>
      </div>}
      <div className="actions">
        {extra}
        {onNotes && <button className="btn" onClick={onNotes} aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}>Notifications{unread > 0 && <span className="pip">{unread}</span>}</button>}
        <button className="btn" onClick={onAccount}><span className="who">{who}</span></button>
      </div>
    </div></header>
  );
}

/** Notification bell data + realtime refresh, shared by owner and worker. */
export function useNotes() {
  const { me } = useAuth();
  const [notes, setNotes] = useState<Note[]>([]);
  const reload = useCallback(async () => setNotes(await loadNotes()), []);
  useEffect(() => {
    if (!me) return;
    reload();
    const ch = supabase.channel(`notes-${me.userId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications', filter: `recipient=eq.${me.userId}` }, () => reload())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [me, reload]);
  return { notes, reload };
}

export function NotesSheet({ notes, onClose, reload, render }: { notes: Note[]; onClose: () => void; reload: () => void; render?: (n: Note) => ReactNode }) {
  return (
    <Sheet eyebrow="Notifications" title="Updates for you" onClose={onClose}>
      <div className="actions"><button className="btn small" onClick={async () => { await markNotesRead(notes.filter((n) => !n.read_at).map((n) => n.id)); reload(); }}>Mark all as read</button></div>
      <div className="stack">
        {notes.length ? notes.map((n) => (
          <div key={n.id} className={`item${n.read_at ? '' : ' unread'}`}><div>{n.text}</div><small>{ago(n.created_at)}</small>{render?.(n)}</div>
        )) : <p className="empty-note">Nothing yet. Time-off requests and schedule changes show up here.</p>}
      </div>
    </Sheet>
  );
}

export default function AppShell() {
  const { me } = useAuth();
  if (!me) return <Loading />;
  if (me.role === 'admin') return <AdminApp />;
  if (me.role === 'owner') return <OwnerApp />;
  if (me.role === 'worker') return <WorkerApp />;
  return <Onboarding mode="new" />;
}
