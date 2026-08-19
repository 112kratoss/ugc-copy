'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { AlertTriangle, RotateCw } from 'lucide-react';

import { Surface, Text } from '@/app/components/DesignSystem';

/**
 * Console-level error boundary.
 *
 * Every admin page is force-dynamic and reads live from Supabase, so a network
 * blip, a PostgREST error, or an unapplied migration surfaced as Next's generic
 * "a server error occurred" page — outside the shell, with no navigation and an
 * opaque digest. That is precisely the wrong failure mode for the tool an
 * operator reaches for *during* an incident: it cannot distinguish "the
 * database is down" from "this one page is broken".
 *
 * Rendering inside the console group keeps the sidebar, so the rest of the
 * console stays reachable, and surfaces the digest for cross-referencing
 * against the server logs.
 */
export default function AdminConsoleError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Server Component errors reach the client already redacted, so the console
    // is the only place the operator can see anything at all about them.
    console.error('admin console page failed', error);
  }, [error]);

  return (
    <Surface variant="card" padding="md" className="border-[var(--ui-accent-danger)]">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-[var(--ui-accent-danger)]" aria-hidden />
        <div className="min-w-0">
          <Text as="h1" variant="cardTitle">This console page could not load</Text>
          <Text variant="bodySm" className="mt-1.5">
            The rest of the console is still usable — the sidebar links all still work. If every
            page fails, treat it as a backend outage rather than a console bug.
          </Text>

          {error.digest ? (
            <Text variant="caption" className="mt-3 block font-mono">
              digest {error.digest}
            </Text>
          ) : null}

          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" onClick={reset} className="ui-button ui-button-primary ui-focus-ring">
              <RotateCw className="h-4 w-4" aria-hidden />
              Try again
            </button>
            <Link href="/admin" className="ui-button ui-button-secondary ui-focus-ring">
              Overview
            </Link>
            <Link href="/admin/system" className="ui-button ui-button-secondary ui-focus-ring">
              System health
            </Link>
          </div>
        </div>
      </div>
    </Surface>
  );
}
