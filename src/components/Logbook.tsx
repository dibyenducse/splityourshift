import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase, errText } from '../lib/supabase';
import { addDays, shiftLong, todayIso } from '../lib/time';
import { empOf } from '../lib/rules';
import type { Bundle, Slot } from '../lib/types';
import { ConfirmButton, Sheet, useToast } from './ui';

export type ShiftName = 'Morning' | 'Evening' | 'Night';
const NAMES: ShiftName[] = ['Morning', 'Evening', 'Night'];
/** Morning 4 am–11 am starts, Evening 11 am–7 pm, Night otherwise (e.g. 11 pm night audit). */
export const shiftNameOf = (s: Pick<Slot, 'start_hour'>): ShiftName => (s.start_hour >= 4 && s.start_hour < 11 ? 'Morning' : s.start_hour >= 11 && s.start_hour < 19 ? 'Evening' : 'Night');

interface Report {
  id: string; location_id: string | null; slot_id: string | null; shift_name: ShiftName | null; work_date: string;
  employee_id: string; body: string; created_at: string; updated_at: string | null;
}
const longDate = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const posted = (t: string) => new Date(t).toLocaleString('en-US', { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const DRAFT = 'sys-report-draft';

/**
 * Shift report logbook (like a shared Google Doc): any worker opens a new page for a shift, picks the
 * location, shift and shift date, writes, and posts. Everyone reads past reports, newest first, with filters.
 * The owner reads; workers (and an owner in worker view) write.
 */
export function ShiftReportsBook({ b, empId, owner }: { b: Bundle; empId?: string; owner?: boolean }) {
  const toast = useToast();
  const [rows, setRows] = useState<Report[]>([]);
  const [more, setMore] = useState(false);
  const [fl, setFl] = useState({ loc: '', shift: '', date: '' });
  const [open, setOpen] = useState<Report | null>(null);
  const [writing, setWriting] = useState(false);
  const me = empId ? empOf(b, empId) : undefined;
  const canWrite = !owner && !!empId;
  const PAGE = 40;

  const shiftOf = (r: Report): ShiftName | null => r.shift_name ?? (r.slot_id ? (b.slots.find((s) => s.id === r.slot_id) ? shiftNameOf(b.slots.find((s) => s.id === r.slot_id)!) : null) : null);
  const title = (r: Report) => `${b.locs.find((l) => l.id === r.location_id)?.name ?? 'Report'}${shiftOf(r) ? ` – ${shiftOf(r)} Shift` : ''}`;

  const load = useCallback(async (append = false) => {
    let q = supabase.from('shift_reports').select('*').eq('org_id', b.org.id).order('created_at', { ascending: false }).limit(PAGE);
    if (fl.loc) q = q.eq('location_id', fl.loc);
    if (fl.date) q = q.eq('work_date', fl.date);
    if (fl.shift) q = q.eq('shift_name', fl.shift);
    if (append && rows.length) q = q.lt('created_at', rows[rows.length - 1].created_at);
    const { data, error } = await q;
    if (error) return toast(errText(error), 'error', "Couldn't load reports");
    const got = (data ?? []) as Report[];
    setRows(append ? [...rows, ...got] : got); setMore(got.length === PAGE);
  }, [b.org.id, fl, rows, toast]);
  useEffect(() => { load(); }, [fl.loc, fl.date, fl.shift, b.org.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const ch = supabase.channel(`book-${b.org.id}-${empId ?? 'owner'}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'shift_reports', filter: `org_id=eq.${b.org.id}` }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [b.org.id, empId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="panel book" id="shift-reports">
      <div className="panel-head"><h2>Shift reports</h2>
        {canWrite && <button className="btn primary" onClick={() => setWriting(true)}>+ New report</button>}</div>
      <p className="hint">{owner ? 'The logbook your workers write at the end of each shift, newest first. You get a notification for each new report.'
        : 'Open a new page for your shift, write what the next shift and your manager should know, and post it. Read the reports before yours to catch up.'}</p>
      <div className="book-filters">
        {b.locs.length > 1 && <select value={fl.loc} onChange={(e) => setFl({ ...fl, loc: e.target.value })} aria-label="Filter by location">
          <option value="">All locations</option>{b.locs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>}
        <select value={fl.shift} onChange={(e) => setFl({ ...fl, shift: e.target.value })} aria-label="Filter by shift">
          <option value="">All shifts</option>{NAMES.map((n) => <option key={n} value={n}>{n}</option>)}</select>
        <input type="date" value={fl.date} onChange={(e) => setFl({ ...fl, date: e.target.value })} aria-label="Filter by shift date" />
        {(fl.loc || fl.shift || fl.date) && <button className="btn small" onClick={() => setFl({ loc: '', shift: '', date: '' })}>Clear filters</button>}
      </div>
      <div className="book-list">{rows.length ? rows.map((r) => (
        <button key={r.id} className="book-item" onClick={() => setOpen(r)}>
          <span className="bi-head"><b>{title(r)}</b><span className="tag ok">Posted</span></span>
          <span className="bi-date">{longDate(r.work_date)} · by {empOf(b, r.employee_id)?.name ?? 'someone'}</span>
          <span className="bi-text">{r.body}</span>
          <span className="bi-date">Posted {posted(r.created_at)}{r.updated_at ? ' · edited' : ''}</span>
        </button>)) : <p className="empty-note">{fl.loc || fl.shift || fl.date ? 'No reports match these filters.' : 'No shift reports yet.'}</p>}</div>
      {more && <div className="actions"><button className="btn" onClick={() => load(true)}>Show older reports</button></div>}
      {open && <ReportSheet b={b} r={open} title={title(open)} mine={canWrite && open.employee_id === empId} onClose={() => setOpen(null)} onChanged={() => { setOpen(null); load(); }} />}
      {writing && me && <NewReport b={b} empId={me.id} onClose={() => setWriting(false)} onPosted={() => { setWriting(false); load(); }} />}
    </section>
  );
}

/** One report, full page, like the logbook's paper format. The writer can edit or delete their own. */
function ReportSheet({ b, r, title, mine, onClose, onChanged }: { b: Bundle; r: Report; title: string; mine: boolean; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [edit, setEdit] = useState(false);
  const [text, setText] = useState(r.body);
  const save = async () => {
    if (!text.trim()) return toast('The report is empty.', 'error', 'Not saved');
    const { error } = await supabase.from('shift_reports').update({ body: text, updated_at: new Date().toISOString() }).eq('id', r.id);
    if (error) return toast(errText(error), 'error', 'Not saved');
    toast('Report updated.', 'ok', 'Saved'); onChanged();
  };
  const del = async () => {
    const { error } = await supabase.from('shift_reports').delete().eq('id', r.id);
    if (error) return toast(errText(error), 'error', 'Not deleted');
    toast('Report deleted.', 'ok', 'Deleted'); onChanged();
  };
  return (
    <Sheet eyebrow="Shift report" title={title} onClose={onClose}>
      <div className="report-page">
        <div className="rp-head"><div><b>{title}</b><small>{longDate(r.work_date)}</small></div><span className="tag ok">Posted</span></div>
        <div className="rp-by">Reported by: <b>{empOf(b, r.employee_id)?.name ?? 'someone'}</b></div>
        <h4>Shift Report</h4>
        {edit ? <Editor value={text} onChange={setText} /> : <div className="rp-body">{r.body}</div>}
        <div className="rp-foot">Posted: {posted(r.created_at)}{r.updated_at ? ` · edited ${posted(r.updated_at)}` : ''}</div>
      </div>
      {mine && <div className="actions">{edit ? <><button className="btn primary" onClick={save}>Save changes</button><button className="btn" onClick={() => { setEdit(false); setText(r.body); }}>Cancel</button></>
        : <><button className="btn" onClick={() => setEdit(true)}>Edit</button><ConfirmButton className="btn danger" label="Delete" confirmLabel="Tap again to delete" onConfirm={del} /></>}</div>}
    </Sheet>
  );
}

/** A big, plain writing area that grows with the text (like a document page). */
function Editor({ value, onChange, autoFocus }: { value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const t = ref.current; if (t) { t.style.height = 'auto'; t.style.height = `${Math.max(t.scrollHeight, 260)}px`; } }, [value]);
  return <textarea ref={ref} className="doc-editor" value={value} onChange={(e) => onChange(e.target.value)} autoFocus={autoFocus} spellCheck
    placeholder={'Write your shift report here.\n\nWhat happened during the shift, guest requests, problems, what the next shift should check or follow up on…'} aria-label="Report" />;
}

/** New report: location, shift, shift date, then write. The draft is kept on this device until posted. */
function NewReport({ b, empId, onClose, onPosted }: { b: Bundle; empId: string; onClose: () => void; onPosted: () => void }) {
  const toast = useToast();
  const me = empOf(b, empId)!;
  const locs = b.locs.filter((l) => me.locs.includes(l.id)).length ? b.locs.filter((l) => me.locs.includes(l.id)) : b.locs;
  const saved = (() => { try { return JSON.parse(localStorage.getItem(DRAFT) ?? 'null') as { loc: string; shift: string; date: string; body: string } | null; } catch { return null; } })();
  const hour = new Date().getHours();
  const guess: ShiftName = hour >= 4 && hour < 11 ? 'Night' : hour < 19 ? 'Morning' : 'Evening'; // the shift that is ending about now
  const [f, setF] = useState(() => saved ?? { loc: locs[0]?.id ?? '', shift: guess, date: guess === 'Night' && hour < 12 ? addDays(todayIso(), -1) : todayIso(), body: '' });
  const [busy, setBusy] = useState(false);
  useEffect(() => { try { localStorage.setItem(DRAFT, JSON.stringify(f)); } catch { /* private mode */ } }, [f]);
  const slots = useMemo(() => b.slots.filter((s) => s.location_id === f.loc), [b.slots, f.loc]);
  const slotFor = slots.find((s) => shiftNameOf(s) === f.shift);
  const post = async () => {
    if (!f.loc) return toast('Pick the location.', 'error', 'Missing');
    if (!f.body.trim()) return toast('Write the report first.', 'error', 'Empty report');
    setBusy(true);
    const { error } = await supabase.from('shift_reports').insert({ org_id: b.org.id, location_id: f.loc, slot_id: slotFor?.id ?? null, shift_name: f.shift, work_date: f.date, employee_id: empId, body: f.body });
    setBusy(false);
    if (error) return toast(errText(error), 'error', 'Not posted');
    try { localStorage.removeItem(DRAFT); } catch { /* private mode */ }
    toast('Posted. The next shift and your manager can read it.', 'ok', 'Shift report'); onPosted();
  };
  return (
    <Sheet eyebrow="Shift report" title="New report" onClose={onClose}>
      <div className="newrep-fields">
        <div className="field"><label htmlFor="nr-loc">Location</label>
          <select id="nr-loc" value={f.loc} onChange={(e) => setF({ ...f, loc: e.target.value })}>{locs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>
        <div className="field"><label htmlFor="nr-shift">Shift</label>
          <select id="nr-shift" value={f.shift} onChange={(e) => setF({ ...f, shift: e.target.value })}>
            {NAMES.map((n) => { const s = slots.find((x) => shiftNameOf(x) === n); return <option key={n} value={n}>{n}{s ? ` (${shiftLong(s.start_hour, s.hours)})` : ''}</option>; })}</select></div>
        <div className="field"><label htmlFor="nr-date">Shift date</label>
          <input id="nr-date" type="date" value={f.date} onChange={(e) => e.target.value && setF({ ...f, date: e.target.value })} />
          {f.shift === 'Night' && <span className="hint">A night shift belongs to the day it started (Sunday 11 pm – Monday 7 am is Sunday).</span>}</div>
      </div>
      <div className="doc-page">
        <div className="rp-head"><div><b>{b.locs.find((l) => l.id === f.loc)?.name} – {f.shift} Shift</b><small>{longDate(f.date)}</small></div></div>
        <div className="rp-by">Reported by: <b>{me.name}</b></div>
        <Editor value={f.body} onChange={(body) => setF({ ...f, body })} autoFocus />
      </div>
      <div className="actions">
        <button className="btn primary" disabled={busy || !f.body.trim()} onClick={post}>{busy ? 'Posting…' : 'Post report'}</button>
        <button className="btn" onClick={onClose}>Close (draft is kept)</button>
        {f.body && <ConfirmButton className="btn danger-text" label="Discard draft" confirmLabel="Tap again" onConfirm={() => { try { localStorage.removeItem(DRAFT); } catch { /* */ } onClose(); }} />}
      </div>
    </Sheet>
  );
}
