import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  normalizeTemplateInputSlots,
  normalizeTemplateSlug,
} from '@/lib/media-template-service';
import {
  getTemplateStepDefinitions,
  validateAndCompileTemplateGraph,
} from '@/lib/template-graph-compiler';
import {
  createTemplateReadyStarterGraph,
  type ImageInputNodeData,
} from '@/lib/workflow-canvas';

function compileStarter() {
  const graph = createTemplateReadyStarterGraph();
  const output = graph.nodes.find((node) => node.type === 'video-generate');
  if (!output) throw new Error('Starter output is missing.');
  return {
    graph,
    output,
    result: validateAndCompileTemplateGraph({
      graph,
      outputNodeId: output.id,
      canvasRevision: 3,
      catalogRevision: null,
    }),
  };
}

describe('graph media template MVP', () => {
  it('compiles the starter graph into a dynamic public manifest and private step plan', () => {
    const { result } = compileStarter();
    expect(result.validation.issues).toEqual([]);
    expect(result.validation).toMatchObject({
      valid: true,
      outputKind: 'video',
      canvasRevision: 3,
      inputSlots: [
        { key: 'person', kind: 'image', label: 'Your photo', required: true },
        { key: 'vehicle', kind: 'image', label: 'Your vehicle', required: true },
      ],
    });
    expect(result.validation.graphHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.validation.estimatedTotalCredits).toBeGreaterThan(0);
    expect(result.compiled).not.toBeNull();

    const steps = getTemplateStepDefinitions(result.compiled!);
    expect(steps.filter((step) => step.kind === 'generation')).toHaveLength(3);
    expect(steps.filter((step) => step.kind === 'approval')).toHaveLength(2);
    expect(steps.every((step) => step.nodeId && step.label)).toBe(true);
  });

  it('strips consumer media while retaining only fixed durable paths in the private snapshot', () => {
    const { graph, output } = compileStarter();
    const inputs = graph.nodes.filter((node) => node.type === 'image-input');
    const nextGraph = {
      ...graph,
      nodes: graph.nodes.map((node) => {
        if (node.id === inputs[0]?.id) {
          return {
            ...node,
            data: {
              ...(node.data as ImageInputNodeData),
              imageUrl: 'https://signed.example/person.png',
              storagePath: 'generated_images/user-1/person.png',
            },
          };
        }
        if (node.id === inputs[1]?.id) {
          return {
            ...node,
            data: {
              ...(node.data as ImageInputNodeData),
              imageUrl: 'https://signed.example/vehicle.png',
              storagePath: 'generated_images/user-1/vehicle.png',
              templateInput: {
                ...(node.data as ImageInputNodeData).templateInput,
                mode: 'fixed' as const,
              },
            },
          };
        }
        return node;
      }),
    };
    const result = validateAndCompileTemplateGraph({
      graph: nextGraph,
      outputNodeId: output.id,
      canvasRevision: 4,
    });
    expect(result.validation.issues).toEqual([]);
    expect(result.validation.valid).toBe(true);
    expect(result.validation.inputSlots.map((slot) => slot.key)).toEqual(['person']);
    const snapshotNodes = (result.compiled!.graph as unknown as {
      nodes: Array<{ id: string; data: ImageInputNodeData }>;
    }).nodes;
    expect(snapshotNodes.find((node) => node.id === inputs[0]?.id)?.data).toMatchObject({
      imageUrl: null,
      storagePath: null,
    });
    expect(snapshotNodes.find((node) => node.id === inputs[1]?.id)?.data).toMatchObject({
      imageUrl: null,
      storagePath: 'generated_images/user-1/vehicle.png',
    });
  });

  it('normalizes public slots and stable listing slugs', () => {
    expect(normalizeTemplateInputSlots([
      { key: 'person', kind: 'image', label: 'Your photo', description: 'Face visible.' },
      { key: 'clip', kind: 'video', label: 'Your clip' },
      { key: 'person', kind: 'image', label: 'Duplicate' },
      { key: 'bad key', kind: 'image', label: 'Invalid' },
    ])).toEqual([
      { key: 'person', kind: 'image', label: 'Your photo', description: 'Face visible.', required: true },
      { key: 'clip', kind: 'video', label: 'Your clip', required: true },
    ]);
    expect(normalizeTemplateSlug('  My Viral Format!  ')).toBe('my-viral-format');
  });

  it('ships immutable versions, atomic activation, private inputs, and private template generations', () => {
    const graphMigration = fs.readFileSync(path.join(
      process.cwd(),
      'supabase/migrations/20260711131023_graph_media_templates.sql',
    ), 'utf8');
    const privacyMigration = fs.readFileSync(path.join(
      process.cwd(),
      'supabase/migrations/20260711154500_private_template_generations.sql',
    ), 'utf8');
    const hardeningMigration = fs.readFileSync(path.join(
      process.cwd(),
      'supabase/migrations/20260711193246_harden_template_function_permissions.sql',
    ), 'utf8');

    expect(graphMigration).toContain('CREATE TABLE public.template_versions');
    expect(graphMigration).toContain('Published template versions are immutable');
    expect(graphMigration).toContain('created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL');
    expect(graphMigration).toContain("to_jsonb(NEW) - 'created_by'");
    expect(graphMigration).toContain('NEW.created_by IS NULL');
    expect(graphMigration).toContain('activate_template_version');
    expect(graphMigration).toContain('snapshot_hash');
    expect(graphMigration).toContain('template_runs_version_belongs_to_template_fkey');
    expect(graphMigration).toContain('DROP POLICY IF EXISTS "Users can upload own template inputs"');
    expect(graphMigration).not.toContain('CREATE POLICY "Users can upload own template inputs"');
    expect(graphMigration).toContain('REVOKE ALL ON TABLE public.template_runs FROM anon, authenticated');

    expect(privacyMigration).toContain('start_template_generation');
    expect(privacyMigration).toContain('prompt,');
    expect(privacyMigration).toContain("'{}'::jsonb");
    expect(privacyMigration).toContain('template_run_id IS NULL');
    expect(privacyMigration).toContain('template_run_step_id IS NULL');
    expect(privacyMigration).toContain('FROM PUBLIC');

    expect(hardeningMigration).toContain('ALTER FUNCTION public.record_template_run_success');
    expect(hardeningMigration).toContain('SECURITY INVOKER');
    expect(hardeningMigration).toContain('FROM PUBLIC, anon, authenticated');
    expect(hardeningMigration).toContain('templates_active_version_fk_idx');
    expect(hardeningMigration).toContain('template_runs_template_version_fk_idx');
  });

  it('exposes only the canonical dynamic run routes', () => {
    const root = path.join(process.cwd(), 'src/app/api/template-runs/[id]');
    expect(fs.existsSync(path.join(root, 'start/route.ts'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'steps/[stepId]/retry/route.ts'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'approval-steps/[stepId]/approve/route.ts'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'frames/route.ts'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'approve/route.ts'))).toBe(false);
  });
});
