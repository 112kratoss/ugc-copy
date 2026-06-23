import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();

const browserFacingFiles = [
  'src/app/page.tsx',
  'src/lib/generation-paywall.ts',
  'src/lib/workflow-canvas.ts',
  'src/lib/generation-feedback.ts',
  'src/lib/generation-timing.ts',
  'src/lib/share.ts',
  'src/lib/generation-model-client.ts',
  'src/app/creations/page.tsx',
  'src/app/create-image/CreateImageClient.tsx',
  'src/app/create-video/CreateVideoClient.tsx',
  'src/app/create-workflow/WorkflowNodeEditors.tsx',
  'src/app/create-workflow/WorkflowCanvasNodes.tsx',
];

const workflowAssistantClientFiles = [
  'src/app/create-workflow/CreateWorkflowClient.tsx',
  'src/app/create-workflow/WorkflowPlannerDrawer.tsx',
  'src/app/create-workflow/WorkflowCanvasNodes.tsx',
  'src/app/create-workflow/useWorkflowCanvasAssistant.ts',
];

describe('client model boundary', () => {
  it('keeps browser-facing generation UI away from the server pricing/provider registry', () => {
    for (const file of browserFacingFiles) {
      const source = readFileSync(join(repoRoot, file), 'utf8');
      expect(source, file).not.toContain("@/lib/models");
    }
  });

  it('derives generated paywall labels from the server catalog instead of browser model lists', () => {
    const source = readFileSync(join(repoRoot, 'src/lib/generation-paywall.ts'), 'utf8');

    expect(source).toContain("@/lib/generation-model-catalog");
    expect(source).not.toContain("@/lib/client-generation-models");
  });

  it('keeps workflow assistant UI away from the server assistant planner module', () => {
    for (const file of workflowAssistantClientFiles) {
      const source = readFileSync(join(repoRoot, file), 'utf8');
      expect(source, file).not.toMatch(/from ['"]@\/lib\/workflow-assistant['"]/);
    }
  });
});
