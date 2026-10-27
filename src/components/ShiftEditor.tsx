import { ampm, shiftLong, norm } from '../lib/time';
import { coverage, type Row } from '../lib/rules';

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const LENGTHS = Array.from({ length: 15 }, (_, i) => i + 2);

/** Editable list of shift rows (start + length) with a 24-hour coverage bar. */
export function ShiftEditor({ rows, onChange, idPrefix }: { rows: Row[]; onChange: (rows: Row[]) => void; idPrefix: string }) {
  const set = (i: number, patch: Partial<Row>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const add = () => { const last = rows[rows.length - 1]; onChange([...rows, { start_hour: last ? norm(last.start_hour + last.hours) : 7, hours: last ? last.hours : 8 }]); };
  return (
    <div className="stack">
      {rows.map((r, i) => (
        <div className="srow" key={r.id ?? `n${i}`}>
          <div className="field"><label htmlFor={`${idPrefix}-start-${i}`}>Shift {i + 1} starts</label>
            <select id={`${idPrefix}-start-${i}`} value={r.start_hour} onChange={(e) => set(i, { start_hour: +e.target.value })}>{HOURS.map((h) => <option key={h} value={h}>{ampm(h)}</option>)}</select></div>
          <div className="field"><label htmlFor={`${idPrefix}-len-${i}`}>Length</label>
            <select id={`${idPrefix}-len-${i}`} value={r.hours} onChange={(e) => set(i, { hours: +e.target.value })}>{LENGTHS.map((n) => <option key={n} value={n}>{n} hours</option>)}</select></div>
          <button type="button" className="btn icon" onClick={() => onChange(rows.filter((_, j) => j !== i))} aria-label={`Remove shift ${i + 1}`} disabled={rows.length < 2}>×</button>
          <span className="lbl">{shiftLong(r.start_hour, r.hours)}</span>
        </div>
      ))}
      <div><button type="button" className="btn small" onClick={add}>+ Add a shift</button></div>
      <Coverage rows={rows} />
    </div>
  );
}

export function Coverage({ rows }: { rows: Row[] }) {
  const c = coverage(rows);
  const gaps = c.filter((x) => x === 0).length, dbl = c.filter((x) => x > 1).length;
  return (
    <div className="cov">
      <div className="cov-bar" aria-hidden="true">{c.map((n, h) => <span key={h} className={n === 0 ? 'c0' : n > 1 ? 'c2' : ''} title={`${ampm(h)}: ${n} on shift`} />)}</div>
      <div className="cov-ticks"><span>12 am</span><span>6 am</span><span>12 pm</span><span>6 pm</span></div>
      <div className="cov-legend">
        <span><i style={{ background: 'var(--ok)' }} />1 person</span>
        <span><i style={{ background: 'var(--warn)' }} />2+ people ({dbl} h)</span>
        <span><i style={{ background: 'var(--bad-soft)', border: '1px dashed var(--bad)' }} />Closed / nobody ({gaps} h)</span>
      </div>
    </div>
  );
}
