import type { Metadata } from 'next';

import { OptionalAuth } from '@/components/RouteAuthBoundary';
import TemplateDetailClient from '@/components/templates/TemplateDetailClient';
import { getMediaTemplate } from '@/lib/media-template-service';
import { createMetadata } from '@/lib/seo';
import { createServiceClient } from '@/lib/server-helpers';

/**
 * The template's own name and description: every template page carried the
 * static title "Media Template", although the sitemap submits each slug.
 */
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const path = `/templates/${encodeURIComponent(slug)}`;
  try {
    const template = await getMediaTemplate(createServiceClient(), slug, null);
    return createMetadata({
      title: template.name,
      description: template.description?.trim() || `Make the ${template.name} format your own on magicbooklet.`,
      path,
    });
  } catch {
    return createMetadata({ title: 'Template unavailable', description: 'This template is not available.', path, noIndex: true });
  }
}

export default async function TemplateDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return (
    <OptionalAuth>
      <TemplateDetailClient slug={slug} />
    </OptionalAuth>
  );
}
