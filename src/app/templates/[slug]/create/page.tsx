import type { Metadata } from 'next';

import { RequireAuth } from '@/app/components/RouteAuthBoundary';
import CreateTemplateRunClient from '@/app/components/templates/CreateTemplateRunClient';

export const metadata: Metadata = {
  title: 'Use Media Template',
};

export default async function CreateFromTemplatePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const returnTo = `/templates/${encodeURIComponent(slug)}/create`;
  return (
    <RequireAuth returnTo={returnTo}>
      <CreateTemplateRunClient slug={slug} />
    </RequireAuth>
  );
}
