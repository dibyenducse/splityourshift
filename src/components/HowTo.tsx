import { useState } from 'react';
import { Sheet } from './ui';

export type HowToTopic = 'payroll' | 'clockrules' | 'swapowner' | 'split' | 'swap' | 'clock';
/** Short how-to videos recorded from the app (public/media/how-*.mp4). */
export const HOWTOS: Record<HowToTopic, { title: string; tab: string; length: string; blurb: string }> = {
  payroll: { title: 'How payroll works', tab: 'Payroll', length: '1:11', blurb: 'Pay schedule, overtime, how hours are paid, bonuses, edits and payday.' },
  clockrules: { title: 'Time clock rules and pay', tab: 'Clock rules', length: '1:05', blurb: 'Clock on or off, the grace period, the three ways to pay, and approving late clock-ins.' },
  swapowner: { title: 'Shift swaps for owners', tab: 'Swaps', length: '1:10', blurb: 'Set up swaps for any worker, approve them, see every swap and track shifts owed.' },
  split: { title: 'Split a shift for one day', tab: 'Split a shift', length: '1:01', blurb: 'Give part of a shift to someone else on one day, without changing your regular shifts.' },
  swap: { title: 'Shift swaps for workers', tab: 'Workers: swaps', length: '1:18', blurb: 'Ask a coworker to work your shift; they accept; the schedule updates.' },
  clock: { title: 'How to clock in and out', tab: 'Workers: clocking in', length: '0:52', blurb: 'One tap in and out, coming late, staying late and forgetting to clock out.' },
};
const MEDIA = import.meta.env.BASE_URL + 'media/';

function Player({ topic }: { topic: HowToTopic }) {
  return (
    <div className="tut-frame howto-player">
      <video key={topic} className="tut-video" controls autoPlay playsInline preload="metadata" poster={`${MEDIA}how-${topic}.jpg`} aria-label={HOWTOS[topic].title}>
        <source src={`${MEDIA}how-${topic}.mp4`} type="video/mp4" />
        <a href={`${MEDIA}how-${topic}.mp4`}>Download the video</a>
      </video>
    </div>);
}

/** A sheet with one how-to video, or (without `topic`) all of them to pick from. */
export function HowToSheet({ topic, topics = ['payroll', 'clockrules', 'swapowner', 'split', 'clock', 'swap'], onClose }: { topic?: HowToTopic; topics?: HowToTopic[]; onClose: () => void }) {
  const [t, setT] = useState<HowToTopic>(topic ?? topics[0]);
  return (
    <Sheet eyebrow="How it works" title={HOWTOS[t].title} onClose={onClose}>
      {!topic && topics.length > 1 && <div className="seg howto-tabs" role="tablist">{topics.map((x) =>
        <button key={x} role="tab" aria-selected={x === t} className={x === t ? 'on' : ''} onClick={() => setT(x)}>{HOWTOS[x].tab}</button>)}</div>}
      <Player topic={t} />
      <p className="hint" style={{ margin: 0 }}>{HOWTOS[t].blurb} · {HOWTOS[t].length}</p>
    </Sheet>);
}

/** Small "▶ How it works" button for a panel header (safe inside a <summary>: it doesn't fold the section). */
export function HowToButton({ topic, label = 'How it works' }: { topic: HowToTopic; label?: string }) {
  const [open, setOpen] = useState(false);
  return (<>
    <button type="button" className="howto-btn no-print" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(true); }} title={`${HOWTOS[topic].title} (${HOWTOS[topic].length} video)`}>
      <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="currentColor" opacity=".15" /><path d="M10 8l6 4-6 4z" fill="currentColor" /></svg>{label}</button>
    {open && <HowToSheet topic={topic} onClose={() => setOpen(false)} />}
  </>);
}
