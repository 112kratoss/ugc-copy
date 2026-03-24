import { OptionalAuth } from '@/app/components/RouteAuthBoundary';

export default async function ShowcaseLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <OptionalAuth>{children}</OptionalAuth>;
}
