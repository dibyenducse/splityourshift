import { useEffect, useState } from 'react';
import { supabase, errText } from '../lib/supabase';
import { DAY_LONG, ampm } from '../lib/time';
import { availText, defAvail } from '../lib/rules';
import type { Avail } from '../lib/types';
import { useToast } from './ui';

const HOURS = Array.from({ length: 24 }, (_, h) => h);

/**
 * A worker's weekly availability (the availability table the owner sees while scheduling).
 * Used on the worker's page and on Account Settings. Pass `avail` when it is already loaded.
 */
export function AvailabilityEditor({ empId, avail, onSaved }: { empId: string; avail?: Avail[]; onSaved?: () => void }) {
  const toast = useToast();
  const [rows, setRows] = useState<Avail[] | null>(avail ?? null);
  useEffect(() => { if (avail) setRows(avail); }, [avail]);
  useEffect(() => {
    if (avail) return;
    supabase.from('availability').select('dow, mode, from_hour, to_hour').eq('employee_id', empId).then(({ data, error }) => {
      if (error) return toast(errText(error), 'error', "Couldn't load availability");
      const a = defAvail(); for (const x of (data ?? []) as Avail[]) a[x.dow] = x; setRows(a);
    });
  }, [empId, avail, toast]);

  const save = async (a: Avail) => {
    if (a.mode === 'hours' && a.from_hour === a.to_hour) return toast('Pick a start and an end that are different.', 'error', 'Not saved');
    setRows((r) => r && r.map((x) => (x.dow === a.dow ? a : x)));
    const { error } = await supabase.from('availability').upsert({ employee_id: empId, dow: a.dow, mode: a.mode, from_hour: a.from_hour, to_hour: a.to_hour });
    if (error) toast(errText(error), 'error', 'Not saved'); else toast(`Saved. ${DAY_LONG[a.dow]}: ${availText(a).toLowerCase()}.`, 'ok', 'Availability');
    onSaved?.();
  };
  if (!rows) return <p className="empty-note">Loading…</p>;
  return (
    <div className="stack avail">{rows.map((a) => (
      <div key={a.dow} className="avail-row">
        <b>{DAY_LONG[a.dow]}</b>
        <select aria-label={`${DAY_LONG[a.dow]} availability`} value={a.mode} onChange={(e) => save({ ...a, mode: e.target.value as Avail['mode'] })}>
          <option value="any">Available any time</option><option value="hours">Available these hours</option><option value="off">Not available</option></select>
        {a.mode === 'hours' && <span className="avail-hours">
          <select aria-label={`${DAY_LONG[a.dow]} from`} value={a.from_hour} onChange={(e) => save({ ...a, from_hour: +e.target.value })}>{HOURS.map((h) => <option key={h} value={h}>{ampm(h)}</option>)}</select>
          <span>to</span>
          <select aria-label={`${DAY_LONG[a.dow]} until`} value={a.to_hour} onChange={(e) => save({ ...a, to_hour: +e.target.value })}>{HOURS.map((h) => <option key={h} value={h}>{ampm(h)}</option>)}</select>
        </span>}
      </div>))}</div>
  );
}
