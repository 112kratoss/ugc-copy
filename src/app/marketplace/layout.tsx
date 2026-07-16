import { RequestHintedOptionalAuth } from '@/app/components/RouteAuthBoundary';

export default async function MarketplaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <RequestHintedOptionalAuth>{children}</RequestHintedOptionalAuth>;
}
