import Link from 'next/link';
import { ArrowLeft, ShieldAlert } from 'lucide-react';

/**
 * An unlock moderation took back: said, where the buyer used to land on the
 * library as if nothing had happened (D2, 2026-10-27). The owner's decision
 * then was no refunds for now, so the page promises none.
 */
export default function UnlockRemoved() {
  return (
    <div className="min-h-screen bg-[#050506] py-6 text-white">
      <div className="mx-auto w-full max-w-3xl px-4">
        <Link
          href="/creations?view=unlocks"
          className="inline-flex items-center gap-2 text-sm text-zinc-400 transition hover:text-zinc-200"
        >
          <ArrowLeft className="h-4 w-4" />
          Unlocked recipes
        </Link>

        <div role="status" className="mt-4 flex items-start gap-2.5 rounded-2xl border border-amber-300/20 bg-amber-300/[0.06] px-4 py-3">
          <ShieldAlert className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-200" aria-hidden="true" />
          <p className="text-sm leading-6 text-amber-100/90">
            This recipe was removed for breaking the community rules.
          </p>
        </div>
      </div>
    </div>
  );
}
