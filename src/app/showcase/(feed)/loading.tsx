import TabLoadingShell from '@/app/components/TabLoadingShell';

/**
 * The `(feed)` group exists so this stays the *tab's* loading state.
 *
 * A `loading.tsx` directly under `showcase/` wraps the whole subtree, so
 * opening a post showed a full-page "Loading Showcase" panel: the wrong page's
 * name, covering the shell it should have left alone, and pre-empting the
 * post's own boundary so that never got a turn. Keeping the feed in a route
 * group scopes the shell to `/showcase` and leaves `/showcase/[id]` alone,
 * where the top progress bar covers the wait instead.
 */
export default function ShowcaseLoading() {
  return <TabLoadingShell title="Showcase" eyebrow="Community" accent="blue" />;
}
