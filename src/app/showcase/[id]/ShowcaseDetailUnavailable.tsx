import Link from 'next/link';

/**
 * Shown inside the overlay when a post cannot be loaded. The full page calls
 * `notFound()` for this case, but inside an overlay that would swap the list
 * the viewer is standing on for an error page — closing the panel should just
 * return them to where they were.
 */
export default function ShowcaseDetailUnavailable() {
  return (
    <div className="px-6 py-16 text-center sm:px-10">
      <h2 className="text-xl font-semibold tracking-tight text-white">This post is unavailable</h2>
      <p className="mx-auto mt-3 max-w-sm text-sm leading-6 text-zinc-400">
        It may have been removed by its creator, or it is no longer public. Close this to get back
        to what you were browsing.
      </p>
      <Link
        href="/showcase"
        prefetch={false}
        className="ui-focus-ring mt-6 inline-flex min-h-11 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] px-4 text-sm font-bold text-zinc-200 transition hover:border-white/25 hover:text-white"
      >
        Browse the Showcase
      </Link>
    </div>
  );
}
