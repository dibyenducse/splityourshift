import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase, errText } from '../lib/supabase';
import { addDays, shiftLong, todayIso } from '../lib/time';
import { empOf, slotById } from '../lib/rules';
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

/** The reporting day in the business's time zone: 7:00 AM starts a new day (6:59 AM still counts as yesterday). */
export const reportDayNow = (tz: string) => new Date(Date.now() - 7 * 36e5).toLocaleDateString('en-CA', { timeZone: tz || 'America/Chicago' });

/**
 * Shift report logbook, by location. The writing form is at the top (workers); below it, every report posted
 * since 7:00 AM today at the worker's locations. Earlier days are in History (filter by date and location).
 * Workers only see and post at locations they're assigned to; the owner sees all and only reads.
 */
export function ShiftReportsBook({ b, empId, owner }: { b: Bundle; empId?: string; owner?: boolean }) {
  const toast = useToast();
  const [view, setView] = useState<'today' | 'history'>('today');
  const [rows, setRows] = useState<Report[]>([]);
  const [more, setMore] = useState(false);
  const [fl, setFl] = useState({ loc: '', shift: '', date: '' });
  const [open, setOpen] = useState<Report | null>(null);
  const me = empId ? empOf(b, empId) : undefined;
  const canWrite = !owner && !!me;
  const locs = owner ? b.locs : b.locs.filter((l) => me?.locs.includes(l.id));
  const today = reportDayNow(b.org.time_zone);
  const PAGE = 40;

  const shiftOf = (r: Report): ShiftName | null => r.shift_name ?? (r.slot_id ? (slotById(b, r.slot_id) ? shiftNameOf(slotById(b, r.slot_id)!) : null) : null);
  const title = (r: Report) => `${b.locs.find((l) => l.id === r.location_id)?.name ?? 'Report'}${shiftOf(r) ? ` – ${shiftOf(r)} Shift` : ''}`;

  const load = useCallback(async (append = false) => {
    const ids = (fl.loc ? [fl.loc] : locs.map((l) => l.id));
    if (!ids.length) { setRows([]); setMore(false); return; }
    let q = supabase.from('shift_reports').select('*').eq('org_id', b.org.id).in('location_id', ids).order('created_at', { ascending: false }).limit(PAGE);
    if (view === 'today') q = q.eq('report_day', today);
    else { q = fl.date ? q.eq('report_day', fl.date) : q.lt('report_day', today); if (fl.shift) q = q.eq('shift_name', fl.shift); }
    if (append && rows.length) q = q.lt('created_at', rows[rows.length - 1].created_at);
    const { data, error } = await q;
    if (error) return toast(errText(error), 'error', "Couldn't load reports");
    const got = (data ?? []) as Report[];
    setRows(append ? [...rows, ...got] : got); setMore(got.length === PAGE);
  }, [b.org.id, fl, rows, toast, view, today, locs]);
  useEffect(() => { load(); }, [view, fl.loc, fl.date, fl.shift, b.org.id, today]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const ch = supabase.channel(`book-${b.org.id}-${empId ?? 'owner'}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'shift_reports', filter: `org_id=eq.${b.org.id}` }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [b.org.id, empId, view]); // eslint-disable-line react-hooks/exhaustive-deps

  const list = (
    <div className="book-list">{rows.length ? rows.map((r) => (
      <button key={r.id} className="book-item" onClick={() => setOpen(r)}>
        <span className="bi-head"><b>{title(r)}</b><span className="tag ok">Posted</span></span>
        <span className="bi-date">Shift of {longDate(r.work_date)} · by {empOf(b, r.employee_id)?.name ?? 'someone'}</span>
        <span className="bi-text">{r.body}</span>
        <span className="bi-date">Posted {posted(r.created_at)}{r.updated_at ? ' · edited' : ''}</span>
      </button>)) : <p className="empty-note">{view === 'today' ? 'No reports yet today (since 7:00 AM).' : fl.date || fl.loc || fl.shift ? 'No reports match these filters.' : 'No earlier reports yet.'}</p>}</div>);

  return (
    <section className="panel book" id="shift-reports">
      <div className="panel-head"><h2>Shift reports</h2>
        <div className="seg" role="tablist" aria-label="Reports">
          <button role="tab" aria-selected={view === 'today'} className={view === 'today' ? 'on' : ''} onClick={() => setView('today')}>Today</button>
          <button role="tab" aria-selected={view === 'history'} className={view === 'history' ? 'on' : ''} onClick={() => setView('history')}>History</button></div></div>
      {!locs.length && <p className="empty-note">You aren't assigned to a location yet, so there are no shift reports to show. Ask your manager to add you to one.</p>}
      {view === 'today' && locs.length > 0 && <>
        {canWrite && <ReportForm b={b} empId={me!.id} locs={locs} onPosted={() => load()} />}
        <h3 className="book-day">Today's reports <small>{longDate(today)} · since 7:00 AM{locs.length > 1 ? ` · ${locs.map((l) => l.name).join(', ')}` : ` · ${locs[0].name}`}</small></h3>
        {list}
      </>}
      {view === 'history' && locs.length > 0 && <>
        <p className="hint">Reports from earlier days. A day runs from 7:00 AM to 6:59 AM the next morning ({b.org.time_zone.split('/')[1]?.replace('_', ' ') ?? b.org.time_zone} time).</p>
        <div className="book-filters">
          {locs.length > 1 && <select value={fl.loc} onChange={(e) => setFl({ ...fl, loc: e.target.value })} aria-label="Filter by location">
            <option value="">All my locations</option>{locs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>}
          <select value={fl.shift} onChange={(e) => setFl({ ...fl, shift: e.target.value })} aria-label="Filter by shift">
            <option value="">All shifts</option>{NAMES.map((n) => <option key={n} value={n}>{n}</option>)}</select>
          <input type="date" max={addDays(today, -1)} value={fl.date} onChange={(e) => setFl({ ...fl, date: e.target.value })} aria-label="Filter by reporting day" />
          {(fl.loc || fl.shift || fl.date) && <button className="btn small" onClick={() => setFl({ loc: '', shift: '', date: '' })}>Clear filters</button>}
        </div>
        {list}
        {more && <div className="actions"><button className="btn" onClick={() => load(true)}>Show older reports</button></div>}
      </>}
      {open && <ReportSheet b={b} r={open} title={title(open)} mine={canWrite && open.employee_id === empId} onClose={() => setOpen(null)} onChanged={() => { setOpen(null); load(); }} />}
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

/** The writing form, always open at the top: location, shift, shift date, then write and post. Draft kept on this device. */
function ReportForm({ b, empId, locs, onPosted }: { b: Bundle; empId: string; locs: Bundle['locs']; onPosted: () => void }) {
  const toast = useToast();
  const me = empOf(b, empId)!;
  const saved = (() => { try { return JSON.parse(localStorage.getItem(DRAFT) ?? 'null') as { loc: string; shift: string; date: string; body: string } | null; } catch { return null; } })();
  const hour = new Date().getHours();
  const guess: ShiftName = hour >= 4 && hour < 11 ? 'Night' : hour < 19 ? 'Morning' : 'Evening'; // the shift that is ending about now
  const fresh = { loc: locs[0]?.id ?? '', shift: guess, date: guess === 'Night' && hour < 12 ? addDays(todayIso(), -1) : todayIso(), body: '' };
  const [f, setF] = useState(() => (saved && locs.some((l) => l.id === saved.loc) ? saved : fresh));
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
    setF({ ...fresh, loc: f.loc, shift: f.shift, date: f.date });
    toast('Posted. The next shift and your manager can read it.', 'ok', 'Shift report'); onPosted();
  };
  return (
    <div className="doc-page report-form">
      <div className="newrep-fields">
        {locs.length > 1 && <div className="field"><label htmlFor="nr-loc">Location</label>
          <select id="nr-loc" value={f.loc} onChange={(e) => setF({ ...f, loc: e.target.value })}>{locs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>}
        <div className="field"><label htmlFor="nr-shift">Shift</label>
          <select id="nr-shift" value={f.shift} onChange={(e) => setF({ ...f, shift: e.target.value as ShiftName })}>
            {NAMES.map((n) => { const s = slots.find((x) => shiftNameOf(x) === n); return <option key={n} value={n}>{n}{s ? ` (${shiftLong(s.start_hour, s.hours)})` : ''}</option>; })}</select></div>
        <div className="field"><label htmlFor="nr-date">Shift date</label>
          <input id="nr-date" type="date" value={f.date} onChange={(e) => e.target.value && setF({ ...f, date: e.target.value })} /></div>
      </div>
      <div className="rp-head"><div><b>{locs.find((l) => l.id === f.loc)?.name} – {f.shift} Shift</b><small>{longDate(f.date)} · Reported by {me.name}</small></div></div>
      <Editor value={f.body} onChange={(body) => setF({ ...f, body })} />
      {f.shift === 'Night' && <span className="hint">A night shift belongs to the day it started (Sunday 11 pm – Monday 7 am is Sunday).</span>}
      <div className="actions" style={{ margin: 0 }}>
        <button className="btn primary" disabled={busy || !f.body.trim()} onClick={post}>{busy ? 'Posting…' : 'Post report'}</button>
        {f.body && <ConfirmButton className="btn danger-text" label="Clear" confirmLabel="Tap again to clear" onConfirm={() => setF({ ...f, body: '' })} />}
      </div>
    </div>
  );
}
