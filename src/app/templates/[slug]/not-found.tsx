import { ArrowLeft } from 'lucide-react';

import { Button, StatusCallout } from '@/components/DesignSystem';
import { TemplatePageShell } from '@/components/templates/TemplatePrimitives';

/**
 * A template that is gone or not published, answered with a 404: the same way
 * back to the catalog the detail offered when it could not load one.
 */
export default function TemplateNotFound() {
  return (
    <TemplatePageShell>
      <Button href="/templates" variant="ghost" icon={ArrowLeft} iconPosition="start">Back to templates</Button>
      <StatusCallout
        title="Template not found"
        body="This template may have been removed, or it isn't published."
        className="mt-6"
      />
    </TemplatePageShell>
  );
}
