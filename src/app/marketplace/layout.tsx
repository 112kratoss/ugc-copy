import { OptionalAuth } from '@/app/components/RouteAuthBoundary';

export default async function MarketplaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <OptionalAuth>{children}</OptionalAuth>;
}
