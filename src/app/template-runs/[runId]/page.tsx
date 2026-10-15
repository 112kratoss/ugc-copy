import type { Metadata } from 'next';
import { Suspense } from 'react';

import { RequireAuth } from '@/components/RouteAuthBoundary';
import TemplateRunClient from '@/components/templates/TemplateRunClient';

export const metadata: Metadata = {
  title: 'Template Run',
};

export default async function TemplateRunPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;

  return (
    <RequireAuth returnTo={`/template-runs/${encodeURIComponent(runId)}`}>
      <Suspense fallback={null}>
        <TemplateRunClient runId={runId} />
      </Suspense>
    </RequireAuth>
  );
}
