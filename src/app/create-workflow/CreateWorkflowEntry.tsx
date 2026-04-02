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

export default function CreateWorkflowEntry({
  initialImportShareId = null,
}: {
  initialImportShareId?: string | null;
}) {
  return <CreateWorkflowClient initialImportShareId={initialImportShareId} />;
}
