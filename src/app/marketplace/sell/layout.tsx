import { RequestHintedOptionalAuth } from '@/components/RouteAuthBoundary';

/**
 * Recipe sales is a signed-in page that reads the session on every request
 * anyway, so it keeps drawing with the session the server checked, as
 * `marketplace/layout.tsx` did for every marketplace page until the storefront
 * was cached for everyone.
 */
export default function MarketplaceSellLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <RequestHintedOptionalAuth>{children}</RequestHintedOptionalAuth>;
}
