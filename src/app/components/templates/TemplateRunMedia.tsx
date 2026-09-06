'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, RotateCcw } from 'lucide-react';
import { getTemplateRun } from './api';

interface Props {
  runId: string;
  stepId?: string;
  kind: 'image' | 'video';
  url: string;
  token?: string;
  alt: string;
  onResolved?: (value: { outputUrl: string; url: string }) => void;
}

export default function TemplateRunMedia(props: Props) {
  return <MediaSession key={`${props.runId}:${props.stepId ?? 'result'}:${props.kind}:${props.url}`} {...props} />;
}

function MediaSession(props: Props) {
  const [attempt, setAttempt] = useState(0);
  return <MediaAttempt key={attempt} {...props} renew={attempt > 0} onRetry={() => setAttempt((value) => value + 1)} />;
}

function MediaAttempt({ renew, onRetry, ...props }: Props & { renew: boolean; onRetry: () => void }) {
  const [request] = useState(props);
  const [source, setSource] = useState<string | null>(renew ? null : request.url);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const finishRef = useRef<(status: 'ready' | 'error') => void>(() => {});

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const timer = setTimeout(() => finishRef.current('error'), 30_000);
    finishRef.current = (next) => {
      if (!active || controller.signal.aborted) return;
      clearTimeout(timer);
      setStatus(next);
      if (next === 'error') controller.abort();
    };
    if (renew) {
      void (async () => {
        try {
          if (!request.token) throw new Error('Session unavailable');
          // Intermediate output IDs are intentionally hidden from the owner
          // library. Renew through the same owned-run read that admitted them.
          const run = await getTemplateRun(request.runId, request.token, controller.signal);
          if (run.id !== request.runId) throw new Error('Run unavailable');
          const step = request.stepId ? run.steps.find((item) => item.id === request.stepId) : null;
          const url = request.stepId
            ? step?.mediaKind === request.kind ? step.outputUrl : null
            : run.result?.kind === request.kind ? run.result.url : null;
          if (!url) throw new Error('Media unavailable');
          if (active && !controller.signal.aborted) {
            request.onResolved?.({ outputUrl: request.url, url });
            setSource(url);
          }
        } catch {
          if (active && !controller.signal.aborted) finishRef.current('error');
        }
      })();
    }
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [renew, request]);

  return (
    <div className="relative h-full min-h-52 w-full bg-black" aria-busy={status === 'loading'}>
      {source && status !== 'error' ? request.kind === 'video' ? (
        <video src={source} controls playsInline preload="metadata" className="h-full w-full object-contain"
          onLoadedMetadata={() => finishRef.current('ready')} onError={() => finishRef.current('error')} />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={source} alt={request.alt} className="h-full w-full object-contain"
          onLoad={() => finishRef.current('ready')} onError={() => finishRef.current('error')} />
      ) : null}
      {status === 'loading' ? (
        <div role="status" className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 bg-black/40 text-sm text-zinc-100">
          <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" /> Loading media…
        </div>
      ) : null}
      {status === 'error' ? (
        <div role="alert" className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-4 text-center text-sm text-zinc-100">
          <p>Media couldn’t load. Check your connection and try again.</p>
          <button type="button" onClick={onRetry} className="ui-focus-ring inline-flex min-h-11 items-center gap-2 rounded-full border border-white/20 px-4 py-2 font-semibold hover:bg-white/10">
            <RotateCcw aria-hidden="true" className="h-4 w-4" /> Reload media
          </button>
        </div>
      ) : null}
    </div>
  );
}
