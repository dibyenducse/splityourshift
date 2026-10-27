export const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const DAY_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// All schedule dates are plain local calendar dates ("YYYY-MM-DD"); math is done in UTC to avoid DST jumps.
export const toDate = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
export const isoOf = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (s: string, n: number) => { const d = toDate(s); d.setUTCDate(d.getUTCDate() + n); return isoOf(d); };
export const daysBetween = (a: string, b: string) => Math.round((toDate(b).getTime() - toDate(a).getTime()) / 864e5);
export const mmdd = (s: string) => { const d = toDate(s); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };
export const mondayOf = (s: string) => addDays(s, -((toDate(s).getUTCDay() + 6) % 7));
export const todayIso = () => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`; };
export const rangeTitle = (from: string, to: string) => {
  const a = toDate(from), b = toDate(to);
  const left = `${MONTHS[a.getUTCMonth()]} ${a.getUTCDate()}`;
  const right = a.getUTCMonth() === b.getUTCMonth() ? `${b.getUTCDate()}` : `${MONTHS[b.getUTCMonth()]} ${b.getUTCDate()}`;
  return `${left} – ${right}, ${b.getUTCFullYear()}`;
};
export const weekTitle = (w: string) => rangeTitle(w, addDays(w, 6));
export const norm = (h: number) => ((h % 24) + 24) % 24;
export const h12 = (h: number) => { h = norm(h); return h === 0 ? 12 : h > 12 ? h - 12 : h; };
export const ampm = (h: number) => `${h12(h)} ${norm(h) < 12 ? 'am' : 'pm'}`;
export const shiftShort = (start: number, hours: number) => `${h12(start)}–${h12(start + hours)}`;
export const shiftLong = (start: number, hours: number) => `${ampm(start)} – ${ampm(start + hours)}`;
export const ago = (t: string | number) => {
  const m = Math.round((Date.now() - new Date(t).getTime()) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
export const money = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
