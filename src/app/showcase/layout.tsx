import { OptionalAuth } from '@/app/components/RouteAuthBoundary';

export default function ShowcaseLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <OptionalAuth>{children}</OptionalAuth>;
}
