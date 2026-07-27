import { RequestHintedOptionalAuth } from '@/app/components/RouteAuthBoundary';

export default function FeedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <RequestHintedOptionalAuth>{children}</RequestHintedOptionalAuth>;
}
