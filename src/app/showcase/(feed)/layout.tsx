import { RequestHintedOptionalAuth } from '@/components/RouteAuthBoundary';

/**
 * Explore reads its query on every request anyway, so it keeps drawing a
 * signed-in visitor with the session the server checked, as `showcase/layout.tsx`
 * did for both of its pages until the post page was cached for everyone.
 */
export default function ShowcaseFeedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <RequestHintedOptionalAuth>{children}</RequestHintedOptionalAuth>;
}
