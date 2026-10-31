import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useAuth } from '../App';
import { supabase, errText } from '../lib/supabase';
import { useToast } from './ui';

export interface MenuItem { label: string; hint?: string; onClick: () => void; primary?: boolean }

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

/** Profile photo in the top-right corner. Opens a menu with the account's settings, view switch and log out. */
export function ProfileMenu({ name, role, items, extra }: { name: string; role: string; items: MenuItem[]; extra?: ReactNode }) {
  const { me, refresh, signOut } = useAuth();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null), file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', close);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close); };
  }, [open]);

  const upload = async (f: File | undefined) => {
    if (!f || !me) return;
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
  };
  const removePhoto = async () => {
    const { error } = await supabase.auth.updateUser({ data: { avatar_url: null } });
    if (error) toast(errText(error), 'error', 'Not saved'); else { await refresh(); toast('Photo removed.', 'ok', 'Photo'); }
  };
  const go = (fn: () => void) => () => { setOpen(false); fn(); };

  return (
    <div className="pmenu" ref={box}>
      <button className="pm-btn" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} title="Your profile and settings">
        <Avatar name={name} url={me?.avatarUrl} /></button>
      {open && <div className="pm-pop" role="menu">
        <div className="pm-head">
          <button className="pm-photo" onClick={() => file.current?.click()} disabled={busy} title="Change photo"><Avatar name={name} url={me?.avatarUrl} size={52} /><span className="pm-edit">{busy ? '…' : 'Edit'}</span></button>
          <div><b>{name}</b><span>{role}</span><small>{me?.email}</small></div>
        </div>
        <input ref={file} type="file" accept="image/*" hidden onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ''; }} />
        {extra}
        {items.map((it) => <button key={it.label} role="menuitem" className={`pm-item${it.primary ? ' primary' : ''}`} onClick={go(it.onClick)}>{it.label}{it.hint && <small>{it.hint}</small>}</button>)}
        <button role="menuitem" className="pm-item" onClick={go(() => file.current?.click())}>{me?.avatarUrl ? 'Change photo' : 'Add a profile photo'}</button>
        {me?.avatarUrl && <button role="menuitem" className="pm-item" onClick={go(removePhoto)}>Remove photo</button>}
        <button role="menuitem" className="pm-item danger-text" onClick={go(signOut)}>Log out</button>
      </div>}
    </div>
  );
}
