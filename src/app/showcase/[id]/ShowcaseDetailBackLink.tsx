'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { hasNavigatedInThisDocument } from '@/app/components/navigation-progress-state';

/**
 * The return affordance on a post page.
 *
 * It stays a real `<Link href>` — that is what gives it a hover URL, a working
 * "open in new tab", and a sane meaning for assistive tech — but when the viewer
 * got here from inside the app it steps back in history instead of following the
 * href. The difference is not cosmetic: a forward navigation re-renders the feed
 * from scratch, throws away every page the viewer had paginated in, and drops
 * them at the top; a history pop restores the cached feed with their scroll
 * position intact, and does it in a fraction of the time.
 *
 * Someone who arrived from a shared link or a refresh has no in-app entry to pop
 * to, so for them the href is followed normally — stepping back there would take
 * them out of the app entirely, which is not what a "Back to Community" button
 * should ever do.
 */
export default function ShowcaseDetailBackLink({
  href,
  label,
}: {
  href: string;
  label: string;
}) {
  const router = useRouter();

  return (
    <Link
      href={href}
      prefetch={false}
      onClick={(event) => {
        // Modifier and non-primary clicks belong to the browser.
        if (event.defaultPrevented || event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        if (!hasNavigatedInThisDocument() || window.history.length <= 1) return;

        event.preventDefault();
        router.back();
      }}
      className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3.5 py-2 text-sm font-medium text-zinc-200 transition hover:border-white/20 hover:bg-white/[0.08] hover:text-white"
    >
      <ArrowLeft className="h-4 w-4" />
      {label}
    </Link>
  );
}
