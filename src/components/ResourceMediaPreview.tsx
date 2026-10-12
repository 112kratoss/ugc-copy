'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Loader2, RotateCcw } from 'lucide-react';
import InlineMediaAudio from './InlineMediaAudio';
import InlineMediaVideo from './InlineMediaVideo';

type Props = {
  mediaType: 'audio' | 'video' | 'image';
  autoPlay?: boolean;
  onOpenImage?: (url: string) => void;
  imageClassName?: string;
  errorAction?: ReactNode;
  label: string;
  url?: string | null;
  resolveUrl?: (signal: AbortSignal) => Promise<string>;
  className?: string;
};

type BatchedRequest = {
  key: string;
  settled: boolean;
  resolve: (url: string) => void;
  reject: (reason: unknown) => void;
  /** Set once the request is on the wire; called when this caller stops waiting. */
  leave?: () => void;
};

/**
 * Turns a loader that resolves many URLs in one request into the per-preview
 * `resolveUrl` below. Previews that ask in the same tick (a panel's previews
 * mount together) share one request of at most `maxBatchSize` keys, where each
 * used to sign its own. Each caller still aborts alone; the shared request is
 * aborted once every caller in it has gone. A key the loader leaves out fails
 * its preview, whose Reload asks again.
 */
export function createBatchedUrlResolver(
  load: (keys: string[], signal: AbortSignal) => Promise<ReadonlyMap<string, string>>,
  maxBatchSize: number,
): (key: string, signal?: AbortSignal) => Promise<string> {
  let queued: BatchedRequest[] = [];

  const send = (requests: BatchedRequest[]) => {
    const controller = new AbortController();
    let waiting = requests.length;
    for (const request of requests) {
      request.leave = () => {
        waiting -= 1;
        if (waiting === 0) controller.abort();
      };
    }
    load(Array.from(new Set(requests.map(request => request.key))), controller.signal).then(urls => {
      for (const request of requests) {
        const url = urls.get(request.key);
        if (url) request.resolve(url);
        else request.reject(new Error('Resource unavailable'));
      }
    }, (error: unknown) => {
      for (const request of requests) request.reject(error);
    });
  };

  const batchSize = Math.max(1, Math.floor(maxBatchSize));
  const flush = () => {
    const requests = queued.filter(request => !request.settled);
    queued = [];
    const keys = Array.from(new Set(requests.map(request => request.key)));
    for (let start = 0; start < keys.length; start += batchSize) {
      const chunk = new Set(keys.slice(start, start + batchSize));
      send(requests.filter(request => chunk.has(request.key)));
    }
  };

  return (key, signal) => new Promise<string>((resolve, reject) => {
    const request: BatchedRequest = {
      key,
      settled: false,
      resolve: url => { if (!request.settled) { request.settled = true; resolve(url); } },
      reject: reason => { if (!request.settled) { request.settled = true; reject(reason); } },
    };
    if (signal?.aborted) {
      request.reject(signal.reason);
      return;
    }
    signal?.addEventListener('abort', () => {
      if (request.settled) return;
      request.reject(signal.reason);
      request.leave?.();
    }, { once: true });
    queued.push(request);
    if (queued.length === 1) queueMicrotask(flush);
  });
}

/** Each explicit retry resolves its source again and leaves playback paused. */
export default function ResourceMediaPreview(props: Props) {
  return <Session key={JSON.stringify([props.mediaType, props.url])} {...props} />;
}

function Session(props: Props) {
  const [attempt, setAttempt] = useState(0);
  return <Attempt key={attempt} {...props} renew={attempt > 0} onRetry={() => setAttempt(value => value + 1)} />;
}

function Attempt({ renew, onRetry, ...props }: Props & { renew: boolean; onRetry: () => void }) {
  const [request] = useState(props);
  const [source, setSource] = useState<string | null>(renew && request.resolveUrl ? null : request.url || null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(!source || request.mediaType !== 'audio' ? 'loading' : 'ready');
  const lifecycle = useRef({ active: false, failed: false, timer: null as ReturnType<typeof setTimeout> | null });
  const controller = useRef<AbortController | null>(null);

  const clearDeadline = () => {
    if (lifecycle.current.timer) clearTimeout(lifecycle.current.timer);
    lifecycle.current.timer = null;
  };
  const fail = () => {
    if (!lifecycle.current.active || lifecycle.current.failed) return;
    lifecycle.current.failed = true;
    clearDeadline();
    controller.current?.abort();
    setStatus('error');
  };
  const loading = () => {
    if (!lifecycle.current.active || lifecycle.current.failed) return;
    setStatus('loading');
    if (!lifecycle.current.timer) lifecycle.current.timer = setTimeout(fail, 30_000);
  };
  const ready = () => {
    if (!lifecycle.current.active || lifecycle.current.failed) return;
    clearDeadline();
    setStatus('ready');
  };

  useEffect(() => {
    const current = lifecycle.current;
    const abort = new AbortController();
    controller.current = abort;
    current.active = true;
    current.failed = false;
    const initialUrl = renew && request.resolveUrl ? null : request.url;
    if (!initialUrl || request.mediaType !== 'audio') loading();
    if (!initialUrl) {
      if (!request.resolveUrl) fail();
      else void request.resolveUrl(abort.signal).then(url => {
        if (abort.signal.aborted) return;
        if (!url.trim()) throw new Error('Resource unavailable');
        setSource(url);
        // Audio defers its media bytes until Play. Signing still has a deadline.
        if (request.mediaType === 'audio') ready();
      }).catch(() => { if (!abort.signal.aborted) fail(); });
    }
    return () => {
      current.active = false;
      clearDeadline();
      abort.abort();
    };
    // A keyed attempt captures its request; callbacks only use stable refs/setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renew, request]);

  const mediaProps = {
    src: source || undefined,
    controls: true,
    'aria-label': request.label,
    autoPlay: !renew && request.autoPlay,
    onLoadStart: request.mediaType === 'video' ? loading : undefined,
    onPlay: loading,
    onWaiting: loading,
    onCanPlay: ready,
    onPlaying: ready,
    onError: fail,
  };
  return <div className={request.className} aria-busy={status === 'loading'}>
    {source && status !== 'error' && request.mediaType === 'image' ? (
      request.onOpenImage ? <button type="button" onClick={() => request.onOpenImage?.(source)} aria-label={`Open preview for ${request.label}`} className="ui-focus-ring block h-full w-full">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={source} alt={request.label} onLoad={ready} onError={fail} className={request.imageClassName || 'max-h-48 w-auto max-w-full rounded-xl object-contain'} />
      </button> : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={source} alt={request.label} onLoad={ready} onError={fail} className={request.imageClassName || 'max-h-48 w-auto max-w-full rounded-xl object-contain'} />
      )
    ) : source && status !== 'error' ? request.mediaType === 'audio'
      ? <InlineMediaAudio {...mediaProps} className="w-full" />
      : <InlineMediaVideo {...mediaProps} playsInline preload="metadata" onLoadedData={ready} className="max-h-64 w-auto max-w-full rounded-xl" /> : null}
    {status === 'loading' ? <p role="status" className="flex items-center gap-2 py-2 text-sm text-zinc-300"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />Loading {request.mediaType}…</p> : null}
    {status === 'error' ? <div role="alert" className="space-y-2 py-3 text-sm text-zinc-300">
      <p>This {request.mediaType} couldn’t load. Check your connection and try again.</p>
      <button type="button" onClick={onRetry} className="ui-focus-ring inline-flex min-h-11 items-center gap-2 rounded-full border border-white/20 px-4 py-2 font-semibold hover:bg-white/10"><RotateCcw aria-hidden="true" className="h-4 w-4" />Reload {request.mediaType}</button>
      {props.errorAction}
    </div> : null}
  </div>;
}
