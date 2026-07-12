import type { Metadata } from 'next';

import { OptionalAuth } from '@/app/components/RouteAuthBoundary';
import TemplateCatalogClient from '@/app/components/templates/TemplateCatalogClient';

export const metadata: Metadata = {
  title: 'Media Templates',
  description: 'Create images and videos from reusable community workflows with your own media.',
};

export default function TemplatesPage() {
  return (
    <OptionalAuth>
      <TemplateCatalogClient />
    </OptionalAuth>
  );
}
