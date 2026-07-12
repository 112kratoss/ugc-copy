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
  const canvasValue = Array.isArray(resolvedSearchParams.canvas)
    ? resolvedSearchParams.canvas[0]
    : resolvedSearchParams.canvas;
  const canvasId = typeof canvasValue === 'string' && canvasValue.trim()
    ? canvasValue.trim()
    : null;
  const templateValue = Array.isArray(resolvedSearchParams.template)
    ? resolvedSearchParams.template[0]
    : resolvedSearchParams.template;
  const templateId = typeof templateValue === 'string' && templateValue.trim()
    ? templateValue.trim()
    : null;
  const testRunValue = Array.isArray(resolvedSearchParams.testRunId)
    ? resolvedSearchParams.testRunId[0]
    : resolvedSearchParams.testRunId;
  const testRunId = typeof testRunValue === 'string' && testRunValue.trim()
    ? testRunValue.trim()
    : null;
  const returnTo = importShareId
    ? buildWorkflowShareImportPath(importShareId)
    : templateId
      ? `/create-workflow?template=${encodeURIComponent(templateId)}${
        testRunId ? `&testRunId=${encodeURIComponent(testRunId)}` : ''
      }`
      : canvasId
        ? `/create-workflow?canvas=${encodeURIComponent(canvasId)}`
        : '/create-workflow';

  return (
    <RequireAuth returnTo={returnTo}>
      <CreateWorkflowEntry
        initialCanvasId={canvasId}
        initialImportShareId={importShareId}
        initialTemplateId={templateId}
        initialTestRunId={testRunId}
      />
    </RequireAuth>
  );
}

export default function CreateWorkflowPage({
  searchParams,
  initialImportShareId = null,
}: CreateWorkflowPageProps = {}) {
  if (!searchParams) {
    return <CreateWorkflowEntry forceEditor initialImportShareId={initialImportShareId} />;
  }

  return (
    <CreateWorkflowPageWithAuth
      searchParams={searchParams}
      initialImportShareId={initialImportShareId}
    />
  );
}
