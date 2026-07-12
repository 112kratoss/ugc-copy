'use client';

import dynamic from 'next/dynamic';
import { Loader2 } from 'lucide-react';

const CreateWorkflowClient = dynamic(
  () => import('./CreateWorkflowClient'),
  {
    ssr: false,
    loading: () => (
      <div className="flex min-h-screen items-center justify-center bg-black text-white">
        <Loader2 className="h-8 w-8 animate-spin text-zinc-400" />
      </div>
    ),
  }
);

const WorkflowLibraryClient = dynamic(
  () => import('./WorkflowLibraryClient'),
  {
    ssr: false,
    loading: () => (
      <div className="flex min-h-[calc(100vh-4rem)] items-center justify-center bg-black text-white">
        <Loader2 className="h-8 w-8 animate-spin text-emerald-300" />
      </div>
    ),
  }
);

export default function CreateWorkflowEntry({
  forceEditor = false,
  initialCanvasId = null,
  initialImportShareId = null,
  initialTemplateId = null,
  initialTestRunId = null,
}: {
  forceEditor?: boolean;
  initialCanvasId?: string | null;
  initialImportShareId?: string | null;
  initialTemplateId?: string | null;
  initialTestRunId?: string | null;
}) {
  const shouldOpenEditor = forceEditor
    || Boolean(initialCanvasId || initialImportShareId || initialTemplateId || initialTestRunId);

  if (!shouldOpenEditor) {
    return <WorkflowLibraryClient />;
  }

  return (
    <CreateWorkflowClient
      initialCanvasId={initialCanvasId}
      initialImportShareId={initialImportShareId}
      initialTemplateId={initialTemplateId}
      initialTestRunId={initialTestRunId}
      organizedWorkflowNavigation={!forceEditor}
    />
  );
}
