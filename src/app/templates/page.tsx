import type { Metadata } from 'next';
import { cache } from 'react';

import { OptionalAuth } from '@/components/RouteAuthBoundary';
import TemplateCatalogClient from '@/components/templates/TemplateCatalogClient';
import type { MediaTemplate } from '@/components/templates/types';
import { JsonLd } from '@/components/JsonLd';
import { listActiveMediaTemplatesPage } from '@/lib/media-template-service';
import { createServiceClient } from '@/lib/server-helpers';
import {
  buildBreadcrumbSchema,
  buildItemListSchema,
  createMetadata,
} from '@/lib/seo';

export const revalidate = 300;

/** One read per render, shared by the metadata and the page. */
const loadInitialTemplates = cache(async (): Promise<{ templates: MediaTemplate[]; nextCursor: string | null } | undefined> => {
  try {
    const page = await listActiveMediaTemplatesPage(createServiceClient());
    return { nextCursor: page.nextCursor, templates: page.templates.map((template) => {
      const publicTemplate = {
        ...template,
        outputKind: template.outputKind ?? 'video',
      };
      delete publicTemplate.authoring;
      return publicTemplate;
    }) };
  } catch (error) {
    // Keep the catalog usable when the server-side bootstrap is unavailable.
    // An undefined value tells the client to retry through the public API.
    console.error('Failed to server-render the template catalog:', error);
    return undefined;
  }
});

// Was a bare metadata object, so this page shipped without a canonical URL or a
// social card while still being indexable. An empty catalog ("No templates are
// live yet") asks not to be indexed, and the sitemap leaves it out the same way;
// a failed read says nothing about the catalog, so it stays indexable.
export async function generateMetadata(): Promise<Metadata> {
  const initialPage = await loadInitialTemplates();

  return createMetadata({
    title: 'Media Templates',
    description:
      'Create AI images and videos from reusable community workflows — bring your own media and run a process someone has already proven.',
    path: '/templates',
    keywords: [
      'AI content templates',
      'reusable AI workflows',
      'AI video templates',
      'AI image templates',
    ],
    noIndex: initialPage !== undefined && initialPage.templates.length === 0,
  });
}

export default async function TemplatesPage() {
  const initialPage = await loadInitialTemplates();

  const listedTemplates = (initialPage?.templates ?? [])
    .filter((template): template is MediaTemplate & { slug: string } => Boolean(template.slug));

  return (
    <OptionalAuth>
      {listedTemplates.length > 0 ? (
        <JsonLd
          data={[
            buildItemListSchema(
              'Media templates',
              '/templates',
              listedTemplates.map((template) => ({
                name: template.name,
                path: `/templates/${template.slug}`,
              }))
            ),
            buildBreadcrumbSchema([
              { name: 'Home', path: '/' },
              { name: 'Templates', path: '/templates' },
            ]),
          ]}
        />
      ) : null}
      <TemplateCatalogClient
        initialTemplates={initialPage?.templates}
        initialNextCursor={initialPage?.nextCursor ?? null}
      />
    </OptionalAuth>
  );
}
