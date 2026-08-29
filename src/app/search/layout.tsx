import '@/app/non-public-utilities.css';

import { RequestHintedOptionalAuth } from '@/app/components/RouteAuthBoundary';

export default function SearchLayout({ children }: { children: React.ReactNode }) {
  return <RequestHintedOptionalAuth>{children}</RequestHintedOptionalAuth>;
}
