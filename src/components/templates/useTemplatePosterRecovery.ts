'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { getTemplate } from './api';
import type { MediaTemplate } from './types';

/** Renew only failed cards, with one shared action and at most four requests in flight. */
export function useTemplatePosterRecovery(
  setTemplates: Dispatch<SetStateAction<MediaTemplate[]>>,
  token?: string,
) {
  const [failedIds, setFailedIds] = useState<Set<string>>(new Set());
  const [attempts, setAttempts] = useState<Record<string, number>>({});
  const [isReloading, setIsReloading] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), [token]);

  const onPreviewError = useCallback((id: string) => {
    setFailedIds((current) => current.has(id) ? current : new Set([...current, id]));
  }, []);
  const reloadPreviews = useCallback(async () => {
    if (pending.current || failedIds.size === 0) return;
    const controller = new AbortController();
    pending.current = controller;
    setIsReloading(true);
    const timer = setTimeout(() => controller.abort(), 30_000);
    const queue = [...failedIds];
    const renewed = new Map<string, MediaTemplate>();
    const stillFailed = new Set<string>();
    try {
      await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
        while (queue.length && !controller.signal.aborted) {
          const id = queue.shift()!;
          try {
            const template = await getTemplate(id, token, controller.signal);
            if (template.id !== id) throw new Error('Template changed.');
            renewed.set(id, template);
          } catch {
            stillFailed.add(id);
          }
        }
      }));
      if (!controller.signal.aborted) {
        setTemplates((current) => current.map((template) => renewed.get(template.id) ?? template));
        setFailedIds((current) => new Set([
          ...[...current].filter((id) => !failedIds.has(id)),
          ...stillFailed,
        ]));
        // Remount failed images even if the renewed URL is unchanged.
        setAttempts((current) => {
          const next = { ...current };
          for (const id of failedIds) next[id] = (next[id] ?? 0) + 1;
          return next;
        });
      }
    } finally {
      clearTimeout(timer);
      pending.current = null;
      setIsReloading(false);
    }
  }, [failedIds, setTemplates, token]);

  useEffect(() => {
    const online = () => { void reloadPreviews(); };
    window.addEventListener('online', online);
    return () => window.removeEventListener('online', online);
  }, [reloadPreviews]);
  return { hasFailedPreviews: failedIds.size > 0, attempts, isReloading, onPreviewError, reloadPreviews };
}
