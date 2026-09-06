'use client';

import InlineMediaVideo from '@/app/components/InlineMediaVideo';

import { useEffect, useRef, useState } from 'react';
import { Loader2, RotateCcw } from 'lucide-react';

import { resolvePlaybackUrl } from '@/lib/media-descriptor';

interface GenerationResultVideoProps {
  generationId: string | null;
  outputUrl: string;
  accessToken: string | undefined;
  onOriginalResolved?: (result: { outputUrl: string; url: string }) => void;
  loop?: boolean;
}

export default function GenerationResultVideo(props: GenerationResultVideoProps) {
  return <ResultSession key={`${props.generationId}:${props.outputUrl}`} {...props} />;
}

function ResultSession(props: GenerationResultVideoProps) {
  const [attempt, setAttempt] = useState(0);
  return <ResultAttempt key={attempt} {...props} onRetry={() => setAttempt((value) => value + 1)} />;
}

function ResultAttempt({ onRetry, ...props }: GenerationResultVideoProps & { onRetry: () => void }) {
  // A token refresh must not replace a playing/paused video's source. Explicit
  // Retry mounts a new attempt with the current token and renews the signed URL.
  const [request] = useState(props);
  const [source, setSource] = useState<{ url: string; poster?: string } | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const finishRef = useRef<(status: 'ready' | 'error') => void>(() => {});

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const timer = setTimeout(() => finishRef.current('error'), 30_000);
    finishRef.current = (nextStatus) => {
      if (!active || controller.signal.aborted) return;
      clearTimeout(timer);
      setStatus(nextStatus);
      if (nextStatus === 'error') controller.abort();
    };

    void (async () => {
      try {
        let nextSource: { url: string; poster?: string } = { url: request.outputUrl };
        let originalUrl = request.outputUrl;
        if (request.generationId) {
          if (!request.accessToken) throw new Error('Session unavailable');
          const response = await fetch(`/api/generations?${new URLSearchParams({
            id: request.generationId,
            detail: 'summary',
            // Archiving hides a creation from the library; saved workflows
            // can still reference it. The owner endpoint retains auth checks.
            includeArchived: 'true',
          })}`, {
            headers: { Authorization: `Bearer ${request.accessToken}` },
            cache: 'no-store',
            signal: controller.signal,
          });
          if (!response.ok) throw new Error('Could not refresh video');
          const payload = await response.json();
          const generation = Array.isArray(payload?.generations)
            ? payload.generations.find((item: { id?: unknown }) => item?.id === request.generationId)
            : null;
          if (!generation) throw new Error('Video unavailable');
          const media = generation.media;
          if (media?.kind === 'video' && typeof media.url === 'string' && media.url.trim()) {
            originalUrl = media.url;
            nextSource = {
              url: resolvePlaybackUrl({
                url: media.url,
                renditionUrl: typeof media.renditionUrl === 'string' ? media.renditionUrl : null,
              }),
              poster: typeof media.previewUrl === 'string' ? media.previewUrl : undefined,
            };
          } else if (typeof generation.output_url === 'string' && generation.output_url.trim()) {
            originalUrl = generation.output_url;
            nextSource = { url: generation.output_url };
          }
        }
        if (active && !controller.signal.aborted) {
          request.onOriginalResolved?.({ outputUrl: request.outputUrl, url: originalUrl });
          setSource(nextSource);
        }
      } catch {
        if (active && !controller.signal.aborted) finishRef.current('error');
      }
    })();

    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [request]);

  return (
    <div className="relative h-full w-full" aria-busy={status === 'loading'}>
      {source && status !== 'error' ? (
        <InlineMediaVideo
          src={source.url}
          poster={source.poster}
          controls
          autoPlay
          loop={request.loop ?? true}
          playsInline
          className="h-full w-full object-contain"
          onLoadedData={() => finishRef.current('ready')}
          onError={() => finishRef.current('error')}
        />
      ) : null}
      {status === 'loading' ? (
        <div role="status" className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 bg-black/40 text-sm text-zinc-100">
          <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
          Loading video…
        </div>
      ) : null}
      {status === 'error' ? (
        <div role="alert" className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-4 text-center text-sm text-zinc-100">
          <p>Video couldn’t load. Check your connection and try again.</p>
          <button type="button" onClick={onRetry} className="inline-flex min-h-11 items-center gap-2 rounded-full border border-white/20 px-4 py-2 font-semibold hover:bg-white/10">
            <RotateCcw aria-hidden="true" className="h-4 w-4" />
            Retry
          </button>
        </div>
      ) : null}
    </div>
  );
}
