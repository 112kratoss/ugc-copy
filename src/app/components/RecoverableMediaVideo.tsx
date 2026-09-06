'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, RotateCcw } from 'lucide-react';

type Source = { url: string; poster?: string | null };
type Props = Source & {
  label: string;
  muted?: boolean;
  resolveRetry?: (signal: AbortSignal) => Promise<Source>;
};

/** Inline previews stay paused on load. Retry renews media without starting work. */
export default function RecoverableMediaVideo(props: Props) {
  return <Session key={props.url} {...props} />;
}
function Session(props: Props) {
  const [attempt, setAttempt] = useState(0);
  return <Attempt key={attempt} {...props} renew={attempt > 0} onRetry={() => setAttempt(value => value + 1)} />;
}
function Attempt({ renew, onRetry, ...props }: Props & { renew: boolean; onRetry: () => void }) {
  const [request] = useState(props);
  const [source, setSource] = useState<Source | null>(renew && request.resolveRetry ? null : request);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const finishRef = useRef<(value: 'ready' | 'error') => void>(() => {});
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const timer = setTimeout(() => finishRef.current('error'), 30_000);
    finishRef.current = value => {
      if (!active || controller.signal.aborted) return;
      clearTimeout(timer);
      setStatus(value);
      if (value === 'error') controller.abort();
    };
    if (renew && request.resolveRetry) {
      void request.resolveRetry(controller.signal).then(next => {
        if (!next.url.trim()) throw new Error('Media unavailable');
        if (active && !controller.signal.aborted) setSource(next);
      }).catch(() => { if (active && !controller.signal.aborted) finishRef.current('error'); });
    }
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [renew, request]);
  return <div className="relative h-full min-h-52 w-full overflow-hidden bg-black" aria-busy={status === 'loading'}>
    {source && status !== 'error' ? <video src={source.url} poster={source.poster || undefined}
      aria-label={request.label} controls muted={request.muted} playsInline preload="metadata" className="h-full w-full object-contain"
      onLoadedData={() => finishRef.current('ready')} onError={() => finishRef.current('error')} /> : null}
    {status === 'loading' ? <div role="status" className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 bg-black/40 text-sm text-zinc-100">
      <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" /> Loading video…
    </div> : null}
    {status === 'error' ? <div role="alert" className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-4 text-center text-sm text-zinc-100">
      <p>Video couldn’t load. Check your connection and try again.</p>
      <button type="button" onClick={onRetry} className="ui-focus-ring inline-flex min-h-11 items-center gap-2 rounded-full border border-white/20 px-4 py-2 font-semibold hover:bg-white/10">
        <RotateCcw aria-hidden="true" className="h-4 w-4" /> Reload video
      </button>
    </div> : null}
  </div>;
}
