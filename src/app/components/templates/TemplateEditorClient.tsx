'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';

import { Surface, Text } from '@/app/components/DesignSystem';

import { TemplatePageShell } from './TemplatePrimitives';

/**
 * Compatibility bridge for old imports and already-open editor tabs.
 * Template authoring now lives in the shared workflow canvas.
 */
export default function TemplateEditorClient({ templateId = null }: { templateId?: string | null }) {
  const router = useRouter();
  const target = `/create-workflow?template=${encodeURIComponent(templateId || 'new')}`;

  useEffect(() => { router.replace(target); }, [router, target]);

  return (
    <TemplatePageShell>
      <Surface variant="panel" padding="lg" className="mx-auto mt-16 max-w-lg text-center">
        <Loader2 className="mx-auto h-7 w-7 animate-spin text-emerald-200" aria-hidden />
        <Text as="h1" variant="cardTitle" className="mt-4">Opening the workflow canvas</Text>
        <Text variant="bodySm" className="mt-2">Template inputs, approvals, and outputs are now configured in one shared builder.</Text>
      </Surface>
    </TemplatePageShell>
  );
}
