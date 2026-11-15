'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { hasNavigatedInThisDocument } from '@/components/navigation-progress-state';

/**
 * The way back on a post page, with the row it sits in: drawn only for a viewer
 * who came to the post from another page of the site, in this tab.
 *
 * Someone who arrived by the post's own address (a shared link, a refresh, a new
 * tab) has no page of the site behind them, and the menu's Home and Explore
 * already lead on from the post, so the page draws no way back for them (owner,
 * 2026-11-15: the "Back to Community" a shared link drew was not needed). Which
 * of the two the viewer is, is read once, as the page mounts: a navigation that
 * starts later, away from the post, must not draw the button under the reader as
 * they leave. The server's render and a hydrating page read it alike (the flag
 * lives in the browser's module and is 0 on every full load), so the server's
 * HTML never holds the row and nothing moves when the page hydrates.
 *
 * It stays a real `<Link href>` — that is what gives it a hover URL, a working
 * "open in new tab", and a sane meaning for assistive tech — but it steps back
 * in history instead of following the href. The difference is not cosmetic: a
 * forward navigation re-renders the feed from scratch, throws away every page
 * the viewer had paginated in, and drops them at the top; a history pop restores
 * the cached feed with their scroll position intact, and does it in a fraction
 * of the time.
 */
export default function ShowcaseDetailBackLink({
  href,
  label,
}: {
  href: string;
  label: string;
}) {
  const router = useRouter();
  const [cameFromInsideTheSite] = useState(hasNavigatedInThisDocument);

  if (!cameFromInsideTheSite) {
    return null;
  }

  return (
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <Link
        href={href}
        prefetch={false}
        onClick={(event) => {
          // Modifier and non-primary clicks belong to the browser.
          if (event.defaultPrevented || event.button !== 0) return;
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          if (window.history.length <= 1) return;

          event.preventDefault();
          router.back();
        }}
        className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3.5 py-2 text-sm font-medium text-zinc-200 transition hover:border-white/20 hover:bg-white/[0.08] hover:text-white"
      >
        <ArrowLeft className="h-4 w-4" />
        {label}
      </Link>
    </div>
  );
}
