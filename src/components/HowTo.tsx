import { useState } from 'react';
import { Sheet } from './ui';

export type HowToTopic = 'swap' | 'clock' | 'payroll';
/** Short how-to videos recorded from the app (public/media/how-*.mp4). */
export const HOWTOS: Record<HowToTopic, { title: string; length: string; blurb: string }> = {
  swap: { title: 'How shift swaps work', length: '0:47', blurb: 'Ask a coworker to work your shift; they accept; the schedule updates.' },
  clock: { title: 'How the time clock works', length: '0:56', blurb: 'One tap in and out, the grace period, late, stayed late and forgot to clock out.' },
  payroll: { title: 'How payroll works', length: '0:51', blurb: 'Pay schedule, overtime, hours from the clock or the schedule, and payday.' },
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
export function HowToSheet({ topic, topics = ['swap', 'clock', 'payroll'], onClose }: { topic?: HowToTopic; topics?: HowToTopic[]; onClose: () => void }) {
  const [t, setT] = useState<HowToTopic>(topic ?? topics[0]);
  return (
    <Sheet eyebrow="How it works" title={HOWTOS[t].title} onClose={onClose}>
      {!topic && topics.length > 1 && <div className="seg howto-tabs" role="tablist">{topics.map((x) =>
        <button key={x} role="tab" aria-selected={x === t} className={x === t ? 'on' : ''} onClick={() => setT(x)}>{HOWTOS[x].title.replace(/^How (the )?/, '').replace(/ works?$/, '').replace(/^./, (c) => c.toUpperCase())}</button>)}</div>}
      <Player topic={t} />
      <p className="hint" style={{ margin: 0 }}>{HOWTOS[t].blurb} · {HOWTOS[t].length}</p>
    </Sheet>);
}

/** Small "▶ How it works" button for a panel header. */
export function HowToButton({ topic, label = 'How it works' }: { topic: HowToTopic; label?: string }) {
  const [open, setOpen] = useState(false);
  return (<>
    <button type="button" className="howto-btn no-print" onClick={() => setOpen(true)} title={`${HOWTOS[topic].title} (${HOWTOS[topic].length} video)`}>
      <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="currentColor" opacity=".15" /><path d="M10 8l6 4-6 4z" fill="currentColor" /></svg>{label}</button>
    {open && <HowToSheet topic={topic} onClose={() => setOpen(false)} />}
  </>);
}
