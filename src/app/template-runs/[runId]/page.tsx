import type { Metadata } from 'next';
import { Suspense } from 'react';

import { RequireAuth } from '@/app/components/RouteAuthBoundary';
import TemplateRunClient from '@/app/components/templates/TemplateRunClient';

export const metadata: Metadata = {
  title: 'Template Run',
};

function getParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function TemplateRunPage({
  params,
  searchParams,
}: {
  params: Promise<{ runId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { runId } = await params;
  const resolvedSearchParams: Record<string, string | string[] | undefined> = searchParams
    ? await searchParams
    : {};
  const query = new URLSearchParams();
  const test = getParam(resolvedSearchParams.test);
  const returnTo = getParam(resolvedSearchParams.returnTo);
  if (test === '1') query.set('test', '1');
  if (returnTo?.startsWith('/templates/') && !returnTo.startsWith('//')) query.set('returnTo', returnTo);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  const authReturnTo = `/template-runs/${encodeURIComponent(runId)}${suffix}`;

  return (
    <RequireAuth returnTo={authReturnTo}>
      <Suspense fallback={null}>
        <TemplateRunClient runId={runId} />
      </Suspense>
    </RequireAuth>
  );
}
