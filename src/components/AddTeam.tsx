import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase, errText } from '../lib/supabase';
import { applyChanges } from '../lib/api';
import { addDays, mondayOf, shiftLong } from '../lib/time';
import { HUES, cellKey, type Changes } from '../lib/rules';
import type { Bundle, Slot } from '../lib/types';
import { DAYS, hourOf, importFromFile, joinUrl, loadJoinLink, nameKey, setJoinActive, type Imported, type JoinLink } from '../lib/team';
import { Sheet, useToast } from './ui';

const DAY_NAME: Record<string, string> = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
const t12 = (t: string) => { const h = hourOf(t), hh = Math.floor(h) % 24, m = Math.round((h - Math.floor(h)) * 60); return `${hh % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''} ${hh < 12 ? 'am' : 'pm'}`; };

/** Shift rows of the location that fit a written start/end (start within 1.5 hours), best first. */
function candidates(slots: Slot[], start: string, end: string): string[] {
  const s = hourOf(start); let dur = hourOf(end) - s; if (dur <= 0) dur += 24;
  return slots.map((x) => { const d = Math.abs((((x.start_hour % 24) - s + 36) % 24) - 12); return { id: x.id, d, sc: d * 2 + Math.abs(x.hours - dur) * 0.5 }; })
    .filter((x) => x.d <= 1.5).sort((a, b) => a.sc - b.sc).map((x) => x.id);
}
/** A shift row to create from the photo: "new:<start hour>:<hours>:<n>" (n = 2nd, 3rd… row with the same times). */
const newKey = (start: string, end: string, n: number) => {
  const st = Math.round(hourOf(start)) % 24; let h = Math.round(hourOf(end)) - st; if (h <= 0) h += 24;
  return `new:${st}:${Math.min(16, Math.max(1, h))}:${n}`;
};
const parseNew = (k: string) => { const [, st, h, n] = k.split(':').map(Number); return { st, h, n }; };

/** "+ Add worker": the join link first (workers sign themselves up), then add by hand. */
export function AddTeamSheet({ b, orgId, onClose, onManual }: { b: Bundle; orgId: string; onClose: () => void; onManual: () => void }) {
  const toast = useToast();
  const [link, setLink] = useState<JoinLink | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => { loadJoinLink(orgId).then(setLink, (e) => toast(errText(e), 'error', "Couldn't load your link")); }, [orgId, toast]);
  const url = link ? joinUrl(link.code) : '';
  const msg = `Hi! Join ${b.org.name} on SplitYourShift to see your shifts, swap and clock in from your phone: ${url}`;
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); } catch { const i = document.getElementById('join-url') as HTMLInputElement | null; i?.select(); document.execCommand('copy'); }
    setCopied(true); setTimeout(() => setCopied(false), 2500);
  };
  const share = async () => { try { await navigator.share({ title: `Join ${b.org.name}`, text: msg }); } catch { /* closed */ } };
  const remake = async () => {
    try { setLink(await loadJoinLink(orgId, true)); toast('The old link no longer works. Share this new one.', 'ok', 'New link made'); }
    catch (e) { toast(errText(e), 'error', 'Not changed'); }
  };
  const toggle = async () => {
    if (!link) return;
    try { await setJoinActive(orgId, !link.active); setLink({ ...link, active: !link.active }); toast(link.active ? 'Nobody can join with the link until you turn it on again.' : 'Workers can join with your link again.', 'ok', link.active ? 'Link turned off' : 'Link turned on'); }
    catch (e) { toast(errText(e), 'error', 'Not changed'); }
  };

  return (
    <Sheet eyebrow="Staff" title="Add your team" onClose={onClose}>
      <section className={`team-opt join-opt${link && !link.active ? ' off' : ''}`}>
        <div className="team-opt-h"><span className="team-ico" aria-hidden="true">🔗</span><div><span className="tag ok">Easiest</span><h3>Send your team a join link</h3></div></div>
        <p>Workers open the link, type their name, email and a password, and show up on your staff list by themselves. You don't type anything. You get a notification when someone joins.</p>
        {link ? <>
          <div className="join-box"><input id="join-url" type="text" readOnly value={url} onFocus={(e) => e.target.select()} aria-label="Join link" />
            <button className="btn primary" onClick={copy} disabled={!link.active}>{copied ? '✓ Copied' : 'Copy link'}</button></div>
          {link.active ? <div className="join-share">
            {typeof navigator.share === 'function' && <button className="btn small" onClick={share}>Share…</button>}
            <a className="btn small" href={`sms:?&body=${encodeURIComponent(msg)}`}>Text it</a>
            <a className="btn small" href={`https://wa.me/?text=${encodeURIComponent(msg)}`} target="_blank" rel="noreferrer">WhatsApp</a>
            <a className="btn small" href={`mailto:?subject=${encodeURIComponent(`Join ${b.org.name} on SplitYourShift`)}&body=${encodeURIComponent(msg)}`}>Email it</a>
          </div> : <p className="reason bad" style={{ margin: 0 }}>This link is off. Nobody can join with it.</p>}
          <details className="join-more"><summary>Link settings</summary>
            <p className="hint">Anyone with the link can join as a worker, so share it only with your team. Joined workers can see the schedule, not pay rates. Set each person's shift limit and pay rate in their profile.</p>
            <div className="actions"><button className="btn small" onClick={toggle}>{link.active ? 'Turn link off' : 'Turn link on'}</button>
              <button className="btn small" onClick={remake}>Make a new link</button></div></details>
        </> : <p className="hint">Making your link…</p>}
      </section>

      <section className="team-opt quiet">
        <div className="team-opt-h"><span className="team-ico" aria-hidden="true">✍️</span><div><h3>Add someone by hand</h3></div></div>
        <p>Type a name, then add their email or phone to send a login invite.</p>
        <div className="actions"><button className="btn" onClick={onManual}>Add a worker by hand</button></div>
      </section>
    </Sheet>
  );
}

interface PersonRow { key: string; name: string; phone: string; email: string; existing: string; use: boolean }
interface ShiftRow { i: number; person: string; day: number; start: string; end: string; slot: string }

/** Import a schedule from a photo: upload → read → check → workers, shift rows and the week are filled in. */
export function ImportScheduleSheet({ b, orgId, week, onClose, reload }: { b: Bundle; orgId: string; week: string; onClose: () => void; reload: () => Promise<void> }) {
  const toast = useToast();
  const [loc, setLoc] = useState(b.locs[0]?.id ?? '');
  const [state, setState] = useState<'pick' | 'reading' | 'review'>('pick');
  const [err, setErr] = useState('');
  const [res, setRes] = useState<Imported | null>(null);
  const [people, setPeople] = useState<PersonRow[]>([]);
  const [shifts, setShifts] = useState<ShiftRow[]>([]);
  const [target, setTarget] = useState(week);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const slots = useMemo(() => b.slots.filter((s) => s.location_id === loc), [b.slots, loc]);

  const findExisting = (name: string) => {
    const k = nameKey(name); if (!k) return '';
    const exact = b.emps.find((e) => nameKey(e.name) === k || nameKey(e.short_name ?? '') === k);
    if (exact) return exact.id;
    const first = b.emps.filter((e) => nameKey(e.name).split(' ')[0] === k.split(' ')[0]);
    return first.length === 1 && (k.split(' ').length === 1 || nameKey(first[0].name).split(' ').length === 1 || nameKey(first[0].name).startsWith(k)) ? first[0].id : '';
  };

  const read = async (file: File) => {
    setErr(''); setState('reading');
    setPreview(file.type.startsWith('image/') ? URL.createObjectURL(file) : '');
    try {
      const r = await importFromFile(orgId, loc || null, file);
      if (r.kind === 'other' || (!r.people.length && !r.shifts.length)) { setErr(r.note || "We didn't find a schedule or names in that file. Try a clearer photo."); setState('pick'); return; }
      // everyone named, from the list and from the shifts
      const seen = new Map<string, PersonRow>();
      for (const p of [...r.people, ...r.shifts.map((s) => ({ name: s.name, phone: '', email: '' }))]) {
        const k = nameKey(p.name); if (!k) continue;
        const cur = seen.get(k);
        if (cur) { cur.phone ||= p.phone; cur.email ||= p.email; continue; }
        seen.set(k, { key: k, name: p.name.trim(), phone: p.phone, email: p.email, existing: findExisting(p.name), use: true });
      }
      setPeople([...seen.values()]);
      const locSlots = b.slots.filter((s) => s.location_id === loc);
      const dup = new Set<string>();
      const rows = r.shifts.map((s, i) => ({ i, person: nameKey(s.name), day: DAYS.indexOf(s.day), start: s.start, end: s.end, slot: '' }))
        .filter((s) => { const k = `${s.person}|${s.day}|${s.start}|${s.end}`; if (s.day < 0 || !s.person || dup.has(k)) return false; dup.add(k); return true; });
      // Each person gets a free matching shift row that day; when there are none left, a new row with the written times.
      const used = new Set<string>();
      for (const s of rows) {
        const free = candidates(locSlots, s.start, s.end).find((id) => !used.has(`${id}|${s.day}`));
        let k = free;
        if (!k) { let n = 1; while (used.has(`${newKey(s.start, s.end, n)}|${s.day}`)) n++; k = newKey(s.start, s.end, n); }
        used.add(`${k}|${s.day}`); s.slot = k;
      }
      setShifts(rows);
      const ws = /^\d{4}-\d{2}-\d{2}$/.test(r.week_start) ? mondayOf(r.week_start) : '';
      setTarget(ws && ws >= mondayOf(addDays(week, -7)) ? ws : week);
      setRes(r); setState('review');
    } catch (e) { setErr(errText(e)); setState('pick'); }
  };

  const setP = (k: string, patch: Partial<PersonRow>) => setPeople(people.map((p) => (p.key === k ? { ...p, ...patch } : p)));
  const setS = (i: number, slot: string) => setShifts(shifts.map((s) => (s.i === i ? { ...s, slot } : s)));
  const pOf = (k: string) => people.find((p) => p.key === k);
  const newPeople = people.filter((p) => p.use && !p.existing && p.name.trim());
  const placed = shifts.filter((s) => s.slot && pOf(s.person)?.use);
  const newRows = [...new Set(shifts.map((s) => s.slot).filter((k) => k.startsWith('new:')))].sort();
  const usedNew = [...new Set(placed.map((s) => s.slot).filter((k) => k.startsWith('new:')))].sort((x, y) => parseNew(x).st - parseNew(y).st || parseNew(x).n - parseNew(y).n);
  const newLabel = (k: string) => { const { st, h, n } = parseNew(k); return `${shiftLong(st, h)} · new${n > 1 ? ` (row ${n})` : ''}`; };
  // two people written in the same shift on the same day: only the first is placed
  const taken = new Map<string, number>();
  for (const s of placed) { const k = `${s.slot}|${s.day}`; if (!taken.has(k)) taken.set(k, s.i); }
  const clash = placed.filter((s) => taken.get(`${s.slot}|${s.day}`) !== s.i);
  const filledNow = placed.filter((s) => taken.get(`${s.slot}|${s.day}`) === s.i && !s.slot.startsWith('new:') && b.assign[cellKey(s.slot, addDays(target, s.day))]).length;

  const apply = async () => {
    setBusy(true);
    try {
      const ids = new Map<string, string>(people.filter((p) => p.use && p.existing).map((p) => [p.key, p.existing]));
      if (newPeople.length) {
        const rows = newPeople.map((p, i) => ({ org_id: orgId, name: p.name.trim().slice(0, 80), phone: p.phone.trim() || null, email: p.email.trim() || null, hue: HUES[(b.emps.length + i) % HUES.length] }));
        const { data, error } = await supabase.from('employees').insert(rows).select('id, name');
        if (error) throw error;
        data.forEach((d, i) => ids.set(newPeople[i].key, d.id));
      }
      const empIds = [...new Set(ids.values())];
      if (loc && empIds.length) {
        const { error } = await supabase.from('employee_locations').upsert(empIds.map((employee_id) => ({ employee_id, location_id: loc })), { onConflict: 'employee_id,location_id', ignoreDuplicates: true });
        if (error) throw error;
      }
      // shift rows the photo has and the schedule doesn't
      const slotId = new Map<string, string>();
      if (usedNew.length) {
        const sort0 = Math.max(0, ...slots.map((x) => x.sort ?? 0)) + 1;
        const { data, error } = await supabase.from('shift_slots').insert(usedNew.map((k, i) => { const { st, h } = parseNew(k); return { org_id: orgId, location_id: loc, start_hour: st, hours: h, sort: sort0 + i }; })).select('id');
        if (error) throw error;
        data.forEach((d, i) => slotId.set(usedNew[i], d.id));
      }
      const changes: Changes = {};
      for (const s of placed) if (taken.get(`${s.slot}|${s.day}`) === s.i && ids.get(s.person)) changes[cellKey(slotId.get(s.slot) ?? s.slot, addDays(target, s.day))] = ids.get(s.person)!;
      if (Object.keys(changes).length) await applyChanges(orgId, changes, true);
      await reload();
      const n = Object.keys(changes).length;
      toast(`${newPeople.length ? `Added ${newPeople.length} worker${newPeople.length > 1 ? 's' : ''}. ` : ''}${usedNew.length ? `Added ${usedNew.length} shift row${usedNew.length > 1 ? 's' : ''}. ` : ''}${n ? `Put ${n} shift${n > 1 ? 's' : ''} on the week of ${new Date(target + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' })}. ` : ''}Use their profiles to send login invites, or share your join link.`, 'ok', 'Imported');
      onClose();
    } catch (e) { toast(errText(e), 'error', "Couldn't import"); } finally { setBusy(false); }
  };

  const weekLabel = (w: string) => new Date(w + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
  return (
    <Sheet eyebrow="Schedule · Import from a photo" title={state === 'review' ? 'Check what we read' : 'Import your schedule from a photo'} onClose={onClose}>
      {state !== 'review' && <>
        <p className="hint" style={{ margin: 0 }}>Take a photo of your paper schedule or whiteboard, or upload a screenshot of a spreadsheet or another app, or a PDF. We read the names and shifts and set up the whole week: new workers, any shift times you don't have yet, and who works when. Nothing is saved until you check it. One week at a time works best.</p>
        {b.locs.length > 1 && <div className="field"><label htmlFor="imp-loc">Which schedule is it for?</label>
          <select id="imp-loc" value={loc} onChange={(e) => setLoc(e.target.value)}>{b.locs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>}
        <input ref={fileRef} type="file" accept="image/*,application/pdf" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) read(f); }} />
        {state === 'reading'
          ? <div className="imp-reading">{preview && <img src={preview} alt="Your photo" />}<div><span className="spin" aria-hidden="true" /><b>Reading your schedule…</b><small>This takes about 20 seconds.</small></div></div>
          : <button className="imp-drop" onClick={() => fileRef.current?.click()}
              onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) read(f); }}>
              <span aria-hidden="true">📷</span><b>Take a photo or choose a file</b><small>JPG, PNG or PDF · or drop it here</small></button>}
        {err && <div className="reason bad">{err}</div>}
      </>}
      {state === 'review' && res && <>
        {res.note && <p className="banner warn" style={{ margin: 0 }}>{res.note}</p>}
        <div className="sec"><h4>People ({people.length})</h4><p>Untick anyone you don't want. Fix a name if we read it wrong.</p>
          <div className="imp-people">{people.map((p) => { const ex = b.emps.find((e) => e.id === p.existing); return (
            <label key={p.key} className={`imp-person${p.use ? '' : ' off'}`}>
              <input type="checkbox" checked={p.use} onChange={(e) => setP(p.key, { use: e.target.checked })} aria-label={`Include ${p.name}`} />
              {ex ? <span className="imp-name">{ex.name}</span> : <input type="text" value={p.name} onChange={(e) => setP(p.key, { name: e.target.value })} aria-label="Name" />}
              {ex ? <span className="tag plain">On your staff</span> : <span className="tag ok">New</span>}
              {(p.phone || p.email) && <small>{[p.phone, p.email].filter(Boolean).join(' · ')}</small>}
            </label>); })}</div></div>
        {shifts.length > 0 && <div className="sec"><h4>Shifts ({placed.length - clash.length} of {shifts.length} will be placed)</h4>
          <div className="field" style={{ maxWidth: 360 }}><label htmlFor="imp-week">Put them on the week of</label>
            <select id="imp-week" value={target} onChange={(e) => setTarget(e.target.value)}>
              {[...new Set([week, addDays(week, 7), ...(res.week_start && /^\d{4}-/.test(res.week_start) ? [mondayOf(res.week_start)] : []), target])].sort().map((w) => <option key={w} value={w}>Monday {weekLabel(w)}{w === week ? ' (the week you\'re viewing)' : ''}{res.week_start && w === mondayOf(res.week_start) ? ' (from the photo)' : ''}</option>)}</select></div>
          {usedNew.length > 0 && <p className="banner" style={{ margin: 0 }}><span><b>New shift row{usedNew.length > 1 ? 's' : ''} for {b.locs.find((l) => l.id === loc)?.name}:</b> {usedNew.map(newLabel).join(', ')}. They're added to your regular shifts; you can change or remove them later.</span></p>}
          <div className="table-wrap"><table className="data imp-shifts"><thead><tr><th>Day</th><th>Who</th><th>Written</th><th>Your shift</th></tr></thead>
            <tbody>{[...shifts].sort((x, y) => x.day - y.day || hourOf(x.start) - hourOf(y.start)).map((s) => { const p = pOf(s.person), isClash = clash.some((c) => c.i === s.i); return (
              <tr key={s.i} className={!p?.use ? 'off' : ''}><td>{DAY_NAME[DAYS[s.day]].slice(0, 3)}</td><td>{p?.name}</td><td>{t12(s.start)} – {t12(s.end)}</td>
                <td><select value={s.slot} onChange={(e) => setS(s.i, e.target.value)} aria-label={`Shift for ${p?.name} on ${DAY_NAME[DAYS[s.day]]}`}>
                  <option value="">Skip</option>{slots.map((x) => <option key={x.id} value={x.id}>{shiftLong(x.start_hour, x.hours)}</option>)}
                  {newRows.map((k) => <option key={k} value={k}>{newLabel(k)}</option>)}</select>
                  {isClash && <small className="bad-t">Someone else is in this shift that day; only the first is placed.</small>}</td></tr>); })}</tbody></table></div>
          {filledNow > 0 && <p className="hint">{filledNow} of these shifts already have someone that week; they'll be replaced.</p>}
        </div>}
        <div className="actions">
          <button className="btn primary" disabled={busy || (!newPeople.length && !placed.length)} onClick={apply}>{busy ? 'Saving…' : `Save${newPeople.length ? ` ${newPeople.length} new worker${newPeople.length > 1 ? 's' : ''}` : ''}${newPeople.length && placed.length - clash.length ? ' and' : ''}${placed.length - clash.length ? ` ${placed.length - clash.length} shift${placed.length - clash.length > 1 ? 's' : ''}` : ''}`}</button>
          <button className="btn" onClick={() => { setState('pick'); setRes(null); }}>Try another photo</button></div>
      </>}
    </Sheet>
  );
}
