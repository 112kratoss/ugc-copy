'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Play } from 'lucide-react';
import { useAuth } from '@/app/components/AuthProvider';
import type { WorkflowCanvasNode } from '@/lib/workflow-canvas';

const ThumbnailContext = createContext<{ urls: Record<string, string>; revision: number; sources: Record<string, string> }>({ urls: {}, revision: 0, sources: {} });

export function WorkflowOutputThumbnails({ nodes, children }: { nodes: WorkflowCanvasNode[]; children: ReactNode }) {
  const { session } = useAuth();
  const token = session?.access_token;
  // Position/selection changes must not fetch media again. Include the original
  // output identity so a rerun invalidates a poster even if its node is reused.
  const identity = JSON.stringify(nodes
    .filter((node) => (node.type === 'video-generate' || node.type === 'motion-generate'
      || (node.type === 'approval-gate' && 'mediaKind' in node.data && node.data.mediaKind === 'video'))
      && node.data.runState.generationId && node.data.runState.outputUrl)
    .map((node) => [node.data.runState.generationId, node.data.runState.outputUrl])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0]))));
  const [posters, setPosters] = useState<{ identity: string; token?: string; urls: Record<string, string>; revision: number }>({ identity: '', urls: {}, revision: 0 });

  useEffect(() => {
    if (!token) return;
    const ids = [...new Set((JSON.parse(identity) as [string, string][]).map(([id]) => id))];
    if (!ids.length) return;
    let active = true;
    let controller: AbortController | null = null;
    const refresh = async () => {
      if (controller || !active) return;
      const current = new AbortController();
      controller = current;
      const urls: Record<string, string> = {};
      try {
        // The owner endpoint admits at most 50 IDs. Fetch bounded batches,
        // never one descriptor request for each mounted card.
        for (let index = 0; index < ids.length; index += 50) {
          const batch = ids.slice(index, index + 50);
          const timer = setTimeout(() => current.abort(), 15_000);
          try {
            const response = await fetch(`/api/generations?${new URLSearchParams({ ids: batch.join(','), detail: 'summary', includeArchived: 'true' })}`, {
              headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal: current.signal,
            });
            if (!response.ok) throw new Error('Preview unavailable');
            const payload = await response.json();
            if (!active || current.signal.aborted) return;
            if (!Array.isArray(payload?.generations)) throw new Error('Invalid previews');
            for (const generation of payload.generations) {
              const media = generation?.media;
              if (batch.includes(generation?.id) && media?.kind === 'video'
                && typeof media.previewUrl === 'string' && media.previewUrl.trim()) {
                urls[generation.id] = media.previewUrl;
              }
            }
          } finally {
            clearTimeout(timer);
          }
        }
      } catch {
        // Keep the card usable through its expanded viewer. Never download the
        // original video as a fallback for a missing or denied poster.
      } finally {
        if (active) setPosters((previous) => ({ identity, token, urls, revision: previous.revision + 1 }));
        controller = null;
      }
    };
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    void refresh();
    window.addEventListener('online', refresh);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      active = false;
      controller?.abort();
      window.removeEventListener('online', refresh);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [identity, token]);

  const sources = Object.fromEntries((JSON.parse(identity) as [string, string][]).map(([id, output]) => [output, id]));
  const current = posters.identity === identity && posters.token === token ? posters : { urls: {}, revision: posters.revision };
  return <ThumbnailContext.Provider value={{ ...current, sources }}>{children}</ThumbnailContext.Provider>;
}

/** Approvals may omit the generation ID; only reuse an exact output match in this graph. */
export function useWorkflowOutputGenerationId(generationId: string | null, outputUrl?: string | null) {
  const { sources } = useContext(ThumbnailContext);
  return generationId || (outputUrl ? sources[outputUrl] : null) || null;
}

export function WorkflowOutputThumbnail({ generationId }: { generationId: string | null }) {
  const { urls, revision } = useContext(ThumbnailContext);
  const url = generationId ? urls[generationId] : undefined;
  const attemptKey = `${url}:${revision}`;
  const [failedAttempt, setFailedAttempt] = useState<string | null>(null);
  return (
    <span className="relative flex h-28 w-full items-center justify-center overflow-hidden rounded-xl border border-white/10 bg-black/40 text-zinc-200">
      {url && failedAttempt !== attemptKey ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-cover" onError={() => setFailedAttempt(attemptKey)} />
      ) : null}
      <span className="relative inline-flex items-center gap-2 rounded-full bg-black/70 px-3 py-2 text-xs font-medium">
        <Play aria-hidden="true" className="h-4 w-4" /> Open video
      </span>
    </span>
  );
}
