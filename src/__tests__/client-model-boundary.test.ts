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
  'src/app/create-motion/CreateMotionClient.tsx',
  'src/app/create-workflow/WorkflowNodeEditors.tsx',
  'src/app/create-workflow/WorkflowCanvasNodes.tsx',
];

const createClientFiles = [
  'src/app/create-image/CreateImageClient.tsx',
  'src/app/create-video/CreateVideoClient.tsx',
  'src/app/create-motion/CreateMotionClient.tsx',
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

  it('keeps create clients on the shared parity-tested registry instead of local copies', () => {
    // CreateMotionClient once carried its own MOTION_MODELS const, which sat
    // outside model-registry-parity.test.ts and drifted unguarded.
    for (const file of createClientFiles) {
      const source = readFileSync(join(repoRoot, file), 'utf8');
      expect(source, file).not.toMatch(/const (IMAGE|VIDEO|MOTION)_MODELS\s*=/);
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
