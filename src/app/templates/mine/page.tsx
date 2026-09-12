import type { Metadata } from 'next';

import { RequireAuth } from '@/components/RouteAuthBoundary';
import TemplateCatalogClient from '@/components/templates/TemplateCatalogClient';

export const metadata: Metadata = {
  title: 'My Templates',
};

export default function MyTemplatesPage() {
  return (
    <RequireAuth returnTo="/templates/mine">
      <TemplateCatalogClient mode="owner" />
    </RequireAuth>
  );
}

