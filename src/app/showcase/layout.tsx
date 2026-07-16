import { RequestHintedOptionalAuth } from '@/app/components/RouteAuthBoundary';

export default function ShowcaseLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <RequestHintedOptionalAuth>{children}</RequestHintedOptionalAuth>;
}
