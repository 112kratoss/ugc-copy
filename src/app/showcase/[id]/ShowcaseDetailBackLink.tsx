'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';

import { hasNavigatedInThisDocument, isPageReachedInThisDocument } from '@/components/navigation-progress-state';

/**
 * Whether a step back in history lands on a page of the site: a navigation of
 * this document put an entry there. A post that replaced the first page (the
 * composer's Publish, opened by its own address) has only the page before the
 * site behind it.
 */
function canStepBackInsideTheSite() {
  return hasNavigatedInThisDocument() && window.history.length > 1;
}

/**
 * The way back on a post page, with the row it sits in: drawn only for a viewer
 * who came to the post from another page of the site, in this tab.
 *
 * Someone who arrived by the post's own address (a shared link, a refresh, a new
 * tab) has no page of the site behind them, and the menu's Home and Explore
 * already lead on from the post, so the page draws no way back for them (owner,
 * 2026-11-15: the "Back to Community" a shared link drew was not needed); nor
 * does a return to that first page by the browser's Back. Any other arrival
 * draws it: a link, the feed's own push, an alert's tap or the composer's
 * Publish (`isPageReachedInThisDocument`). Which of the two the viewer is, is
 * read once, as the page mounts: a navigation that starts later, away from the
 * post, must not draw the button under the reader as they leave. The server's
 * render and a hydrating first page read it alike, so the server's HTML never
 * holds the row and nothing moves when the page hydrates.
 *
 * A `stepsBackOnly` way back ("Back", for a link that named no page) has no page
 * of its own to open, so it is drawn only where stepping back stays on the site.
 *
 * It stays a real `<Link href>` — that is what gives it a hover URL, a working
 * "open in new tab", and a sane meaning for assistive tech — but where it can, it
 * steps back in history instead of following the href. The difference is not
 * cosmetic: a forward navigation re-renders the feed from scratch, throws away
 * every page the viewer had paginated in, and drops them at the top; a history
 * pop restores the cached feed with their scroll position intact, and does it in
 * a fraction of the time. Where it cannot, the href opens the page it names.
 */
export default function ShowcaseDetailBackLink({
  href,
  label,
  stepsBackOnly = false,
}: {
  href: string;
  label: string;
  stepsBackOnly?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  // How the viewer arrived, as the page mounted. Whether a press steps back is
  // decided here too, not at the press: NavigationProgress counts the press itself
  // as a navigation before this link's handler runs, so a count read then is never
  // 0. `stepsBackOnly` is read as it comes instead: the page reads its address
  // after mounting, so its first render always takes the link for one that named
  // no page.
  const [arrival] = useState(() => {
    const reached = isPageReachedInThisDocument(pathname);
    return { reached, canStepBack: reached && canStepBackInsideTheSite() };
  });

  if (!arrival.reached || (stepsBackOnly && !arrival.canStepBack)) {
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
          if (!arrival.canStepBack) return;

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
