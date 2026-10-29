import { useEffect, useRef } from 'react';
import { DAY_LONG, addDays, mmdd, rangeTitle, shiftLong, shiftShort, todayIso } from '../lib/time';
import { TYPE_LABEL, absEnd, absStart, availFor, cellKey, empOf, parseCell, valid, type Changes, type Result } from '../lib/rules';
import type { Bundle, Loc } from '../lib/types';
import { ConfirmButton } from './ui';

interface GridProps {
  b: Bundle; week: string; editable: boolean; meId?: string; onlyLocs?: string[];
  onCell?: (k: string) => void; onEditLoc?: (l: Loc) => void; onClearWeek?: (l: Loc) => void;
}

export const PrintIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ verticalAlign: '-2px' }}>
    <path d="M6 9V3h12v6" /><rect x="3" y="9" width="18" height="8" rx="2" /><path d="M6 14h12v7H6z" /></svg>);

/** Prints one location's week (or every location when no id is given), using the print styles in styles.css. */
export function printBoards(locId?: string) {
  document.querySelectorAll('.print-me').forEach((x) => x.classList.remove('print-me'));
  if (locId) { document.querySelector(`.board[data-loc="${locId}"]`)?.classList.add('print-me'); document.body.classList.add('print-one'); }
  const done = () => { document.body.classList.remove('print-one'); document.querySelectorAll('.print-me').forEach((x) => x.classList.remove('print-me')); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();
  setTimeout(done, 1000);
}

/** One board per location: shifts down the side, days across, like the paper schedule. */
export function WeekGrid({ b, week, editable, meId, onlyLocs, onCell, onEditLoc, onClearWeek }: GridProps) {
  const today = todayIso();
  const ranges: Record<string, [number, number][]> = {};
  for (const k in b.assign) if (valid(b, k)) (ranges[b.assign[k]] ||= []).push([absStart(b, k), absEnd(b, k)]);
  const pending = new Set(b.reqs.filter((r) => r.status === 'pending' && r.slot_id).map((r) => cellKey(r.slot_id!, r.work_date)));
  const locs = b.locs.filter((l) => !onlyLocs || onlyLocs.includes(l.id));
  if (!locs.length) return <p className="empty-note">No locations yet.</p>;
  return (
    <>
      {locs.map((l) => {
        const slots = b.slots.filter((s) => s.location_id === l.id).sort((x, y) => x.start_hour - y.start_hour || x.sort - y.sort);
        const filled = slots.reduce((n, s) => n + DAY_LONG.filter((_, d) => b.assign[cellKey(s.id, addDays(week, d))]).length, 0);
        const open = slots.length * 7 - filled;
        const lens = [...new Set(slots.map((s) => s.hours))];
        return (
          <section className="board" key={l.id} data-loc={l.id}>
            <div className="board-head">
              <h2>{l.name}</h2><span className="ltype">{TYPE_LABEL[l.type] ?? 'Other'}</span>
              <span className="print-only meta">Week of {rangeTitle(week, addDays(week, 6))}</span>
              <span className="meta">{lens.length === 1 ? `${slots.length} × ${lens[0]}-hour shifts` : `${slots.length} shifts`}</span>
              {open > 0 && <span className="open">{open} open</span>}
              <span className="board-tools">
                <button className="mini" onClick={() => printBoards(l.id)} aria-label={`Print ${l.name} schedule`}><PrintIcon /> Print</button>
                {editable && onEditLoc && <button className="mini" onClick={() => onEditLoc(l)}>Edit shifts</button>}
                {editable && onClearWeek && filled > 0 && <ConfirmButton className="mini danger-text" label="Clear week" confirmLabel="Click again to clear" onConfirm={() => onClearWeek(l)} />}
              </span>
            </div>
            <div className="table-wrap">
              <table className="grid">
                <thead><tr><th className="corner">Shift</th>
                  {DAY_LONG.map((d, i) => { const iso = addDays(week, i); return (
                    <th key={d} className={iso === today ? 'today' : ''}><span className="dname">{d}</span><span className="ddate">{mmdd(iso)}{iso === today ? ' · today' : ''}</span></th>); })}
                </tr></thead>
                <tbody>
                  {slots.map((s) => (
                    <tr key={s.id}>
                      <th className="sh" scope="row"><b>{shiftShort(s.start_hour, s.hours)}</b><small>{shiftLong(s.start_hour, s.hours)} · {s.hours}h</small></th>
                      {DAY_LONG.map((_, d) => {
                        const k = cellKey(s.id, addDays(week, d));
                        const w = empOf(b, b.assign[k]);
                        let inner;
                        if (w) {
                          const st = absStart(b, k), en = absEnd(b, k);
                          const dbl = (ranges[w.id] || []).some(([a, z]) => z === st || a === en);
                          const cls = meId ? (w.id === meId ? ' me' : ' dim') : '';
                          inner = (
                            <div className={`chip${cls}`} style={{ ['--h' as string]: w.hue }} {...(editable ? { 'data-drag': '', 'data-wid': w.id, 'data-key': k } : {})}>
                              {w.name}
                              {dbl && <span className="flag" title="Back-to-back double shift">2×</span>}
                              {pending.has(k) && <span className="flag" title="Asked for this shift off">off?</span>}
                              {(() => { const e = b.entries.find((x) => x.employee_id === w.id && x.slot_id === s.id && x.work_date === parseCell(k).date);
                                return e ? (e.clock_out ? <span className="flag ok" title="Clocked in and out">✓</span> : <span className="flag on" title="On the clock now">● on</span>) : null; })()}
                              {editable && !availFor(b, w, k) && <span className="flag" title="This worker said they can't work at this time (their availability)">unavailable</span>}
                            </div>);
                        } else inner = <span className="ph">Open</span>;
                        return (
                          <td key={d} className="cell" {...(editable ? { tabIndex: 0, 'data-cell': k } : {})}
                            onClick={editable && onCell ? () => onCell(k) : undefined}
                            onKeyDown={editable && onCell ? (e) => { if (e.key === 'Enter') onCell(k); } : undefined}
                            aria-label={`${d}: ${w ? w.name : 'open'}`}>{inner}</td>);
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
      <p className="grid-key">
        <span><span className="flag">2×</span> double shift (back to back)</span>
        <span><span className="flag on">● on</span> on the clock now</span>
        <span><span className="flag ok">✓</span> clocked in and out</span>
        <span><span className="flag">off?</span> asked for this shift off</span>
      </p>
    </>
  );
}

/**
 * Drag-and-drop for the owner's schedule. Sources: elements with data-drag + data-wid (+ data-key when dragged from a cell).
 * Targets: td[data-cell]; the #roster panel or the remove bar removes a shift. Works with mouse and touch (long-press).
 */
export function useDragDrop(opts: {
  enabled: boolean;
  check: (changes: Changes) => Result;
  nameOf: (wid: string) => string;
  occupant: (k: string) => string | undefined;
  label: (k: string) => string;
  onDrop: (changes: Changes, wid: string, from: string | null, to: string | 'trash') => void;
  onStart?: () => void;
}) {
  const ref = useRef(opts);
  ref.current = opts;
  useEffect(() => {
    if (!opts.enabled) return;
    let drag: null | { wid: string; from: string | null; src: HTMLElement; x: number; y: number; lx: number; ly: number; active: boolean; touch: boolean; timer?: number; over: string | null; state: Record<string, { cls: string; msg: string | null }> } = null;
    let suppress = false;
    const ghost = document.createElement('div'); ghost.className = 'ghost'; ghost.hidden = true; document.body.appendChild(ghost);
    const trash = document.createElement('div'); trash.className = 'trash'; trash.hidden = true; trash.textContent = 'Drop here to remove from shift'; document.body.appendChild(trash);

    const changesFor = (target: string): Changes | null => {
      if (!drag || drag.from === target) return null;
      const o = ref.current;
      if (drag.from) return { [target]: drag.wid, [drag.from]: o.occupant(target) ?? null };
      if (o.occupant(target) === drag.wid) return null;
      return { [target]: drag.wid };
    };
    const start = () => {
      if (!drag) return;
      drag.active = true; ref.current.onStart?.();
      document.body.classList.add('dragging');
      if (drag.src.classList.contains('chip')) drag.src.classList.add('lifting');
      trash.hidden = !drag.from;
      document.querySelectorAll<HTMLElement>('td[data-cell]').forEach((td) => {
        const ch = changesFor(td.dataset.cell!); if (!ch) return;
        const r = ref.current.check(ch);
        const cls = r.errors.length ? 'drop-bad' : r.warnings.length ? 'drop-warn' : 'drop-ok';
        td.classList.add(cls);
        drag!.state[td.dataset.cell!] = { cls, msg: r.errors[0]?.msg ?? r.warnings[0]?.msg ?? null };
      });
      ghost.hidden = false; move();
    };
    const move = () => {
      if (!drag) return;
      const o = ref.current;
      ghost.style.transform = `translate(${drag.lx + 14}px, ${drag.ly + 14}px)`;
      const under = document.elementFromPoint(drag.lx, drag.ly) as HTMLElement | null;
      const td = under?.closest<HTMLElement>('td[data-cell]');
      const overTrash = !!(under && drag.from && (under.closest('.trash') || under.closest('#roster')));
      document.querySelectorAll('td.cell.hover').forEach((x) => x.classList.remove('hover'));
      trash.classList.toggle('hover', overTrash);
      let sub = drag.from ? 'Drop on a shift to move or trade' : 'Drop on a shift', cls = '';
      if (td) {
        td.classList.add('hover');
        const st = drag.state[td.dataset.cell!];
        if (!st) sub = 'Same spot';
        else {
          cls = st.cls.replace('drop-', '');
          const occ = o.occupant(td.dataset.cell!);
          sub = st.msg || (occ ? (drag.from ? `Trade with ${o.nameOf(occ)}` : `Replace ${o.nameOf(occ)}`) : o.label(td.dataset.cell!));
        }
      } else if (overTrash) { sub = 'Remove from this shift'; cls = 'bad'; }
      ghost.className = 'ghost ' + cls;
      ghost.innerHTML = '';
      ghost.append(o.nameOf(drag.wid)); const sm = document.createElement('small'); sm.textContent = sub; ghost.append(sm);
      drag.over = td ? td.dataset.cell! : overTrash ? 'trash' : null;
    };
    const end = (drop: boolean) => {
      if (!drag) return;
      clearTimeout(drag.timer);
      const d = drag; drag = null;
      if (!d.active) return;
      suppress = true; setTimeout(() => { suppress = false; }, 0);
      document.body.classList.remove('dragging');
      ghost.hidden = true; trash.hidden = true; trash.classList.remove('hover');
      document.querySelectorAll('td.cell').forEach((td) => td.classList.remove('drop-ok', 'drop-warn', 'drop-bad', 'hover'));
      d.src.classList.remove('lifting');
      if (!drop || !d.over) return;
      if (d.over === 'trash') { if (d.from) ref.current.onDrop({ [d.from]: null }, d.wid, d.from, 'trash'); return; }
      drag = d; const ch = changesFor(d.over); drag = null;
      if (ch) ref.current.onDrop(ch, d.wid, d.from, d.over);
    };
    const down = (e: PointerEvent) => {
      if (e.button > 0 || drag) return;
      const t = e.target as HTMLElement;
      const src = t.closest<HTMLElement>('[data-drag]');
      if (!src || t.closest('button') || src.closest('.sheet')) return;
      drag = { wid: src.dataset.wid!, from: src.dataset.key ?? null, src, x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, active: false, touch: e.pointerType !== 'mouse', over: null, state: {} };
      if (drag.touch) drag.timer = window.setTimeout(() => { if (drag && !drag.active) { start(); try { navigator.vibrate?.(15); } catch { /* no vibration */ } } }, 260);
    };
    const mv = (e: PointerEvent) => {
      if (!drag) return;
      drag.lx = e.clientX; drag.ly = e.clientY;
      if (!drag.active) {
        const dist = Math.hypot(e.clientX - drag.x, e.clientY - drag.y);
        if (!drag.touch && dist > 5) start();
        else if (drag.touch && dist > 10) { clearTimeout(drag.timer); drag = null; }
        return;
      }
      e.preventDefault(); move();
    };
    const up = () => end(true);
    const cancel = () => end(false);
    const touchmove = (e: TouchEvent) => { if (drag?.active) e.preventDefault(); };
    const click = (e: MouseEvent) => { if (suppress) { e.preventDefault(); e.stopPropagation(); } };
    const ctx = (e: MouseEvent) => { if ((e.target as HTMLElement).closest('[data-drag]')) e.preventDefault(); };
    document.addEventListener('pointerdown', down);
    document.addEventListener('pointermove', mv);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', cancel);
    document.addEventListener('touchmove', touchmove, { passive: false });
    document.addEventListener('click', click, true);
    document.addEventListener('contextmenu', ctx);
    return () => {
      document.removeEventListener('pointerdown', down);
      document.removeEventListener('pointermove', mv);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', cancel);
      document.removeEventListener('touchmove', touchmove);
      document.removeEventListener('click', click, true);
      document.removeEventListener('contextmenu', ctx);
      ghost.remove(); trash.remove();
    };
  }, [opts.enabled]);
}
