import type { Metadata } from 'next';
import { cache } from 'react';
import { notFound } from 'next/navigation';

import { OptionalAuth } from '@/components/RouteAuthBoundary';
import TemplateDetailClient from '@/components/templates/TemplateDetailClient';
import { logBackendError } from '@/lib/backend-logger';
import { loadMediaTemplateRow, type MediaTemplateRow } from '@/lib/media-template-service';
import { createMetadata } from '@/lib/seo';
import { createServiceClient } from '@/lib/server-helpers';
import { getServerAuthState } from '@/lib/supabase-server';

type TemplatePageProps = { params: Promise<{ slug: string }> };

/**
 * Who may see this template on this request. Anyone sees a live one; its
 * creator also sees their own draft or disabled one, which is never indexed.
 * A read that failed is not a missing template: the page still draws and its
 * client reads the template itself, so a blip never tells a crawler to drop a
 * live page, as the old catch-all "Template unavailable" did.
 */
type TemplatePageAccess =
  | { kind: 'live' | 'owner-only'; template: MediaTemplateRow }
  | { kind: 'missing' }
  | { kind: 'unread' };

/** The rule the detail API applies to a visitor (`getMediaTemplate`). */
function isLiveTemplate(template: MediaTemplateRow) {
  return template.status === 'active' && template.is_active === true && Boolean(template.active_version_id);
}

/**
 * One row read per request, shared by the metadata and the page. The title and
 * description need nothing else; the full template also signed its media and
 * read its creator and cost for those two strings. The session is read only
 * for a template a visitor may not see.
 */
const loadTemplatePageAccess = cache(async (slug: string): Promise<TemplatePageAccess> => {
  let template: MediaTemplateRow | null;
  try {
    template = await loadMediaTemplateRow(createServiceClient(), slug);
  } catch (error) {
    logBackendError('template_page_read_failed', { error });
    return { kind: 'unread' };
  }
  if (!template) return { kind: 'missing' };
  if (isLiveTemplate(template)) return { kind: 'live', template };
  const viewerUserId = (await getServerAuthState()).session?.user?.id ?? null;
  return viewerUserId && viewerUserId === template.creator_user_id
    ? { kind: 'owner-only', template }
    : { kind: 'missing' };
});

/**
 * The template's own name and description: every template page carried the
 * static title "Media Template", although the sitemap submits each slug.
 */
export async function generateMetadata({ params }: TemplatePageProps): Promise<Metadata> {
  const { slug } = await params;
  const path = `/templates/${encodeURIComponent(slug)}`;
  const access = await loadTemplatePageAccess(slug);
  if (access.kind === 'missing') return { title: 'Template not found' };
  if (access.kind === 'unread') {
    return createMetadata({
      title: 'Media Template',
      description: 'Make a community format your own on magicbooklet.',
      path,
    });
  }
  const { template } = access;
  return createMetadata({
    title: template.name,
    description: template.description?.trim() || `Make the ${template.name} format your own on magicbooklet.`,
    path,
    noIndex: access.kind === 'owner-only',
  });
}

export default async function TemplateDetailPage({ params }: TemplatePageProps) {
  const { slug } = await params;
  // Before anything is drawn, so the answer is a real 404 and not a 200 page
  // that says the template is unavailable.
  if ((await loadTemplatePageAccess(slug)).kind === 'missing') notFound();
  return (
    <OptionalAuth>
      <TemplateDetailClient slug={slug} />
    </OptionalAuth>
  );
}
