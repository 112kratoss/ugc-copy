import type { Metadata } from 'next';

import { OptionalAuth } from '@/app/components/RouteAuthBoundary';
import TemplateCatalogClient from '@/app/components/templates/TemplateCatalogClient';
import type { MediaTemplate } from '@/app/components/templates/types';
import { listActiveMediaTemplates } from '@/lib/media-template-service';
import { createServiceClient } from '@/lib/server-helpers';

export const metadata: Metadata = {
  title: 'Media Templates',
  description: 'Create images and videos from reusable community workflows with your own media.',
};

export const revalidate = 300;

async function loadInitialTemplates(): Promise<MediaTemplate[] | undefined> {
  try {
    const templates = await listActiveMediaTemplates(createServiceClient());
    return templates.map((template) => {
      const publicTemplate = {
        ...template,
        outputKind: template.outputKind ?? 'video',
      };
      delete publicTemplate.authoring;
      return publicTemplate;
    });
  } catch (error) {
    // Keep the catalog usable when the server-side bootstrap is unavailable.
    // An undefined value tells the client to retry through the public API.
    console.error('Failed to server-render the template catalog:', error);
    return undefined;
  }
}

export default async function TemplatesPage() {
  const initialTemplates = await loadInitialTemplates();

  return (
    <OptionalAuth>
      <TemplateCatalogClient initialTemplates={initialTemplates} />
    </OptionalAuth>
  );
}
