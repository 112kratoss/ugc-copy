import type { Metadata } from 'next';

import { OptionalAuth } from '@/app/components/RouteAuthBoundary';
import TemplateDetailClient from '@/app/components/templates/TemplateDetailClient';

export const metadata: Metadata = {
  title: 'Media Template',
};

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
