import Link from 'next/link';
import { UserRoundX } from 'lucide-react';

/** An unknown handle: say so, with a way into Explore, instead of the generic 404. */
export default function CreatorNotFound() {
  return (
    <div className="ui-page ui-page-ambient min-h-[calc(100dvh-64px)] px-4 py-8 sm:px-6 sm:py-12">
      <section className="mx-auto max-w-2xl rounded-[28px] border border-[var(--ui-border-default)] bg-[var(--ui-surface-1)] p-6 text-center shadow-[var(--ui-shadow-panel)] sm:p-8">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--ui-surface-2)] text-[var(--ui-text-muted)]">
          <UserRoundX className="h-5 w-5" aria-hidden />
        </span>
        <h1 className="mt-5 text-2xl font-extrabold tracking-tight text-[var(--ui-text-primary)]">
          Creator not found
        </h1>
        <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-[var(--ui-text-secondary)]">
          There is no creator at this address. The handle may have changed, or the account may have been removed.
        </p>
        <Link
          href="/showcase"
          className="ui-focus-ring mt-6 inline-flex min-h-12 items-center justify-center rounded-full bg-[var(--ui-primary)] px-6 text-sm font-extrabold text-[var(--ui-primary-on)] transition hover:bg-[var(--ui-primary-strong)]"
        >
          Explore creators
        </Link>
      </section>
    </div>
  );
}
