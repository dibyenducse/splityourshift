import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { LoginStatus } from '../lib/types';

// ---------- toasts ----------
type ToastType = 'ok' | 'warn' | 'error';
interface ToastItem { id: number; msg: string; type: ToastType; title: string }
const ToastCtx = createContext<(msg: string, type?: ToastType, title?: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const toast = useCallback((msg: string, type: ToastType = 'ok', title = '') => {
    const id = ++seq.current;
    setItems((xs) => [...xs.slice(-2), { id, msg, type, title }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), type === 'error' ? 6500 : 4500);
  }, []);
  return (
    <ToastCtx.Provider value={toast}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((t) => <div key={t.id} className={`toast ${t.type}`}>{t.title && <b>{t.title}</b>}{t.msg}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------- side sheet ----------
export function Sheet({ eyebrow, title, onClose, children }: { eyebrow: string; title: ReactNode; onClose: () => void; children: ReactNode }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
        <div className="sheet-head">
          <div className="t"><div className="eyebrow">{eyebrow}</div><h3 id="sheet-title">{title}</h3></div>
          <button ref={closeRef} className="btn icon" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </>
  );
}

// ---------- bits ----------
export function Logo() {
  return <span className="logo" aria-hidden="true">{Array.from({ length: 9 }, (_, i) => <i key={i} />)}</span>;
}

export const STATUS_LABEL: Record<LoginStatus, [string, string]> = {
  active: ['ok', 'Active'], invited: ['warn', 'Invited'], expired: ['bad', 'Link expired'], none: ['plain', 'Not invited'],
};
export const StatusTag = ({ s }: { s: LoginStatus }) => <span className={`tag ${STATUS_LABEL[s][0]}`}>{STATUS_LABEL[s][1]}</span>;

/** A button that asks for a second click before doing something destructive. */
export function ConfirmButton({ label, confirmLabel, onConfirm, className = 'btn danger' }: { label: string; confirmLabel: string; onConfirm: () => void; className?: string }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => { if (!armed) return; const t = setTimeout(() => setArmed(false), 3000); return () => clearTimeout(t); }, [armed]);
  return <button className={`${className}${armed ? ' armed' : ''}`} onClick={() => (armed ? (setArmed(false), onConfirm()) : setArmed(true))}>{armed ? confirmLabel : label}</button>;
}

export function Loading({ text = 'Loading…' }: { text?: string }) {
  return <div className="loading">{text}</div>;
}
