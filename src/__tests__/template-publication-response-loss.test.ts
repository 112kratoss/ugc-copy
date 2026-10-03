import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { publishMediaTemplate } from '@/lib/media-template-service';
import { compileTemplateGraph } from '@/lib/template-graph-compiler';
import { createTemplateReadyStarterGraph } from '@/lib/workflow-canvas';

// Service-boundary reproduction: activation is recorded, then its reply is lost.
// Real PostgreSQL/Storage verification remains separate audit work.
describe('template publication activation response loss', () => {
  it.each(['timeout', 'malformed', 'missing-inserted', 'thrown', 'rejected'] as const)('preserves uncertain activation assets and cleans definite rejection: %s', async mode => {
    const userId = randomUUID();
    const templateId = randomUUID();
    const canvasId = randomUUID();
    const runId = randomUUID();
    const graph = createTemplateReadyStarterGraph();
    const output = graph.nodes.find(node => node.type === 'image-generate')!;
    const compiled = compileTemplateGraph({ graph, outputNodeId: output.id, canvasRevision: 3, catalogRevision: null });
    const template = {
      id: templateId, creator_user_id: userId, source_canvas_id: canvasId,
      name: 'Publication fixture', draft_output_node_id: output.id,
      draft_catalog_revision: null, status: 'draft', active_version_id: null,
    };
    const objects = new Map<string, Blob>();
    const versions: Array<Record<string, unknown>> = [];
    const client = {
      from(table: string) {
        const filters: Record<string, unknown> = {};
        const row = () => {
          if (table === 'templates') return template;
          if (table === 'workflow_canvases') return { id: canvasId, user_id: userId, graph, revision: 3 };
          if (table === 'template_runs') return {
            id: runId, template_id: templateId, user_id: userId, status: 'succeeded', is_test: true,
            graph_hash: compiled.graphHash, source_canvas_revision: 3, catalog_revision: null,
            result_url: `generated_images/${userId}/demo.png`,
          };
          if (table === 'template_versions') return versions.find(version => Object.entries(filters).every(([key, value]) => version[key] === value)) ?? null;
          throw new Error(`Unexpected table ${table}`);
        };
        const query = {
          select: () => query,
          eq: (key: string, value: unknown) => { filters[key] = value; return query; },
          single: async () => ({ data: row(), error: null }),
          maybeSingle: async () => ({ data: row(), error: null }),
        };
        return query;
      },
      rpc: async (name: string, args: Record<string, unknown>) => {
        expect(name).toBe('activate_template_version');
        if (mode === 'rejected') return { data: null, error: { message: 'Constraint rejected', code: '23514' }, status: 400 };
        versions.push({ id: args.p_version_id, template_id: templateId, demo_output_url: args.p_demo_output_url });
        if (mode === 'thrown') throw new Error('Connection closed');
        if (mode === 'malformed') return { data: null, error: null, status: 200 };
        if (mode === 'missing-inserted') return { data: {}, error: null, status: 200 };
        return { data: null, error: { message: 'Gateway timeout', code: '' }, status: 504 };
      },
      storage: {
        from: (bucket: string) => ({
          download: async () => ({ data: new Blob(['fixture-image'], { type: 'image/png' }), error: null }),
          upload: async (key: string, blob: Blob) => { objects.set(`${bucket}/${key}`, blob); return { error: null }; },
          remove: async (keys: string[]) => { keys.forEach(key => objects.delete(`${bucket}/${key}`)); return { error: null }; },
        }),
      },
    } as unknown as SupabaseClient;
    await expect(publishMediaTemplate(client, userId, templateId, {
      rightsConfirmed: true, expectedRevision: 3, graphHash: compiled.graphHash,
      testRunId: runId, outputNodeId: output.id,
    })).rejects.toBeDefined();
    if (mode === 'rejected') {
      expect(versions).toHaveLength(0);
      expect(objects.size).toBe(0);
    } else {
      expect(versions).toHaveLength(1);
      expect(objects.has(versions[0].demo_output_url as string)).toBe(true);
    }
  });
});
