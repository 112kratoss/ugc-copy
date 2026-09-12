'use client';

import { useEffect, useRef, useState } from 'react';

/** Sign at click time, reserving the tab during the user gesture. */
export default function ResourceFileLink({ label, resolveUrl }: {
  label: string;
  resolveUrl: (signal: AbortSignal) => Promise<string>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanupRef.current?.(), []);

  const open = async () => {
    if (cleanupRef.current) return;
    const tab = window.open('about:blank', '_blank');
    if (!tab) { setError('Allow popups to open this file, then try again.'); return; }
    tab.opener = null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    let active = true;
    cleanupRef.current = () => { active = false; clearTimeout(timer); controller.abort(); tab?.close(); };
    setPending(true);
    setError(null);
    try {
      const url = await Promise.race([
        resolveUrl(controller.signal),
        new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true })),
      ]);
      if (!active || controller.signal.aborted) return;
      // Resource URLs come from the authorized endpoint, never a local cache.
      const parsed = new URL(url, window.location.origin);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Invalid file URL');
      if (!tab.closed) tab.location.replace(parsed.href);
    } catch {
      tab?.close();
      if (active) setError('Couldn’t open the file. Check your connection and try again.');
    } finally {
      clearTimeout(timer);
      if (active) { cleanupRef.current = null; setPending(false); }
    }
  };
  return <div className="mt-2 text-xs">
    <button type="button" onClick={() => void open()} disabled={pending} aria-label={`Open ${label}`}
      className="ui-focus-ring min-h-11 font-medium text-emerald-200 hover:text-emerald-100 disabled:opacity-50">
      {pending ? 'Opening…' : 'Open'}
    </button>
    {error ? <p role="alert" className="text-rose-200">{error}</p> : null}
  </div>;
}
