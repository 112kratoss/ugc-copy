import { RequireAuth } from '@/app/components/RouteAuthBoundary';
import { buildWorkflowShareImportPath } from '@/lib/workflow-share';

import CreateWorkflowEntry from './CreateWorkflowEntry';

interface CreateWorkflowPageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
  initialImportShareId?: string | null;
}

async function CreateWorkflowPageWithAuth({
  searchParams,
  initialImportShareId,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
  initialImportShareId?: string | null;
}) {
  const resolvedSearchParams = await searchParams;
  const importValue = Array.isArray(resolvedSearchParams.import)
    ? resolvedSearchParams.import[0]
    : resolvedSearchParams.import;
  const importShareId = typeof importValue === 'string' && importValue.trim()
    ? importValue.trim()
    : initialImportShareId ?? null;
  const returnTo = importShareId ? buildWorkflowShareImportPath(importShareId) : '/create-workflow';

  return (
    <RequireAuth returnTo={returnTo}>
      <CreateWorkflowEntry initialImportShareId={importShareId} />
    </RequireAuth>
  );
}

export default function CreateWorkflowPage({
  searchParams,
  initialImportShareId = null,
}: CreateWorkflowPageProps = {}) {
  if (!searchParams) {
    return <CreateWorkflowEntry initialImportShareId={initialImportShareId} />;
  }

  return (
    <CreateWorkflowPageWithAuth
      searchParams={searchParams}
      initialImportShareId={initialImportShareId}
    />
  );
}
