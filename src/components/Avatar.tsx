import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAuth } from '../App';
import { supabase, errText } from '../lib/supabase';
import { useToast } from './ui';

export type MenuIcon = 'switch' | 'account' | 'plan' | 'video' | 'timeoff' | 'home';
export interface MenuItem { label: string; hint?: string; onClick: () => void; primary?: boolean; icon?: MenuIcon }
const ICON: Record<MenuIcon | 'logout', string> = {
  switch: 'M7 7h11l-3-3M17 17H6l3 3', account: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  plan: 'M3 7h18v10H3zM3 11h18M7 15h3', video: 'M4 5h16v14H4zM10 9l5 3-5 3z', timeoff: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4M9 15l6 0',
  home: 'M3 11l9-7 9 7M5 10v10h14V10', logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
};
const Ico = ({ k }: { k: MenuIcon | 'logout' }) => <svg className="pm-ico" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={ICON[k]} /></svg>;

const initials = (name: string) => name.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';
const hueOf = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

export function Avatar({ name, url, size = 36 }: { name: string; url?: string | null; size?: number }) {
  return url
    ? <img className="avatar" src={url} alt="" width={size} height={size} style={{ width: size, height: size }} />
    : <span className="avatar" aria-hidden="true" style={{ width: size, height: size, fontSize: size * 0.4, ['--h' as string]: hueOf(name) }}>{initials(name)}</span>;
}

/** Shrinks a photo to a 256 px square JPEG before upload. */
async function squareJpeg(file: File): Promise<Blob> {
  const img = await createImageBitmap(file);
  const s = Math.min(img.width, img.height), c = document.createElement('canvas');
  c.width = c.height = 256;
  c.getContext('2d')!.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 256, 256);
  return new Promise((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad(new Error("Couldn't read that photo."))), 'image/jpeg', 0.86));
}

/** Upload / remove the signed-in user's profile photo (Storage "avatars" bucket + the user's metadata). */
export function useProfilePhoto() {
  const { me, refresh } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const upload = useCallback(async (f: File | undefined) => {
    if (!f || !me) return;
    if (!f.type.startsWith('image/')) return toast('Pick a photo (JPG, PNG or WebP).', 'error', 'Not a photo');
    setBusy(true);
    try {
      const blob = await squareJpeg(f);
      const path = `${me.userId}/avatar-${Date.now()}.jpg`;
      const { error } = await supabase.storage.from('avatars').upload(path, blob, { contentType: 'image/jpeg', upsert: true });
      if (error) throw error;
      const url = supabase.storage.from('avatars').getPublicUrl(path).data.publicUrl;
      const { error: e2 } = await supabase.auth.updateUser({ data: { avatar_url: url } });
      if (e2) throw e2;
      await refresh(); toast('Your new photo is saved.', 'ok', 'Photo');
    } catch (e) { toast(errText(e), 'error', "Couldn't save the photo"); }
    setBusy(false);
  }, [me, refresh, toast]);
  const remove = useCallback(async () => {
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ data: { avatar_url: null } });
    if (error) toast(errText(error), 'error', 'Not saved'); else { await refresh(); toast('Photo removed.', 'ok', 'Photo'); }
    setBusy(false);
  }, [refresh, toast]);
  return { url: me?.avatarUrl ?? null, busy, upload, remove };
}

/**
 * Profile photo in the top-right corner. Opens a navigation menu: the items the page passes, then Log out.
 * The menu is fixed to the viewport and kept inside it, so it never runs off a phone screen.
 */
export function ProfileMenu({ name, role, items }: { name: string; role: string; items: MenuItem[] }) {
  const { me, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);
  const box = useRef<HTMLDivElement>(null), btn = useRef<HTMLButtonElement>(null);

  const place = useCallback(() => {
    const r = btn.current?.getBoundingClientRect(); if (!r) return;
    const vw = document.documentElement.clientWidth, vh = window.innerHeight, gap = 12;
    const width = Math.min(300, vw - gap * 2);
    const left = Math.max(gap, Math.min(r.right - width, vw - width - gap)); // line up with the photo's right edge, stay on screen
    const top = r.bottom + 8;
    setPos({ top, left, width, maxHeight: Math.max(160, vh - top - gap) });
  }, []);
  useLayoutEffect(() => { if (open) place(); }, [open, place]);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', close);
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => {
      document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', close);
      window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true);
    };
  }, [open, place]);
  const go = (fn: () => void) => () => { setOpen(false); fn(); };

  return (
    <div className="pmenu" ref={box}>
      <button ref={btn} className="pm-btn" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} title="Your profile and settings">
        <Avatar name={name} url={me?.avatarUrl} /></button>
      {open && pos && <div className="pm-pop" role="menu" style={{ top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.maxHeight }}>
        <div className="pm-head">
          <Avatar name={name} url={me?.avatarUrl} size={48} />
          <div><b>{name}</b><span>{role}</span><small>{me?.email}</small></div>
        </div>
        {items.map((it) => <button key={it.label} role="menuitem" className={`pm-item${it.primary ? ' primary' : ''}${it.icon ? ' has-ico' : ''}`} onClick={go(it.onClick)}>
          {it.icon && <Ico k={it.icon} />}<span className="pm-txt">{it.label}{it.hint && <small>{it.hint}</small>}</span></button>)}
        <div className="pm-foot"><button role="menuitem" className="pm-logout" onClick={go(signOut)}><Ico k="logout" />Log out</button></div>
      </div>}
    </div>
  );
}
