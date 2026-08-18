import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { reviewActiveTemplatesForCatalog } from '../../scripts/generation-model-catalog';

type Row = Record<string, unknown>;

function snapshotWithModels(models: string[]) {
  return {
    graph: {
      nodes: models.map((model, index) => ({
        id: `generate-${index + 1}`,
        type: index % 2 === 0 ? 'image-generate' : 'video-generate',
        data: { model },
      })),
    },
  };
}

function createFakeClient(seed: { templates: Row[]; versions: Row[] }) {
  const updates: Array<{ table: string; payload: Row; id: unknown }> = [];
  return {
    updates,
    client: {
      from(table: string) {
        if (table === 'templates') {
          return {
            select: () => ({
              eq: () => ({
                eq: async () => ({ data: seed.templates, error: null }),
              }),
            }),
            update: (payload: Row) => ({
              eq: (_column: string, id: unknown) => ({
                eq: async () => {
                  updates.push({ table, payload, id });
                  return { data: null, error: null };
                },
              }),
            }),
          };
        }
        if (table === 'template_versions') {
          return {
            select: () => ({
              in: async (_column: string, ids: unknown[]) => ({
                data: seed.versions.filter((row) => ids.includes(row.id)),
                error: null,
              }),
            }),
          };
        }
        throw new Error(`Unexpected table: ${table}`);
      },
    } as never,
  };
}

describe('reviewActiveTemplatesForCatalog', () => {
  it('disables only the templates whose models left the catalog', async () => {
    const fake = createFakeClient({
      templates: [
        { id: 'template-live', slug: 'live', name: 'Live', active_version_id: 'version-live' },
        { id: 'template-dead', slug: 'dead', name: 'Dead', active_version_id: 'version-dead' },
      ],
      versions: [
        { id: 'version-live', graph_snapshot: snapshotWithModels(['nano-banana-2']) },
        { id: 'version-dead', graph_snapshot: snapshotWithModels(['nano-banana-2', 'retired-model']) },
      ],
    });

    const outcome = await reviewActiveTemplatesForCatalog(fake.client, new Set(['nano-banana-2']));

    expect(outcome.reviewedCount).toBe(2);
    expect(outcome.disabled).toEqual([{
      templateId: 'template-dead',
      slug: 'dead',
      name: 'Dead',
      missingModels: ['retired-model'],
    }]);
    expect(fake.updates).toEqual([{
      table: 'templates',
      payload: { status: 'disabled', is_active: false },
      id: 'template-dead',
    }]);
    expect(outcome.skipped).toEqual([]);
  });

  it('reports unreadable or missing snapshots without disabling them', async () => {
    const fake = createFakeClient({
      templates: [
        { id: 'template-orphan', slug: 'orphan', name: 'Orphan', active_version_id: 'version-gone' },
        { id: 'template-mangled', slug: 'mangled', name: 'Mangled', active_version_id: 'version-mangled' },
      ],
      versions: [
        { id: 'version-mangled', graph_snapshot: { graph: { nodes: [{ type: 'image-generate', data: {} }] } } },
      ],
    });

    const outcome = await reviewActiveTemplatesForCatalog(fake.client, new Set(['nano-banana-2']));

    expect(outcome.disabled).toEqual([]);
    expect(fake.updates).toEqual([]);
    expect(outcome.skipped).toEqual([
      { templateId: 'template-orphan', reason: 'active version snapshot is unavailable' },
      { templateId: 'template-mangled', reason: 'active version snapshot is unreadable' },
    ]);
  });

  it('leaves the catalog untouched when no templates are active', async () => {
    const fake = createFakeClient({ templates: [], versions: [] });
    const outcome = await reviewActiveTemplatesForCatalog(fake.client, new Set());
    expect(outcome).toEqual({ reviewedCount: 0, disabled: [], skipped: [] });
  });
});

describe('release lifecycle wiring', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'scripts/generation-model-catalog.ts'),
    'utf8',
  );

  it('reviews active templates after both publish and rollback activate a release', () => {
    const publishBlock = source.slice(source.indexOf("rpc('publish_generation_model_catalog'"));
    const rollbackBlock = source.slice(source.indexOf("rpc('rollback_generation_model_catalog'"));
    expect(publishBlock.slice(0, 700)).toContain('runPostReleaseTemplateReview');
    expect(rollbackBlock.slice(0, 700)).toContain('runPostReleaseTemplateReview');
  });

  it('never fails the release command because the template review failed', () => {
    expect(source).toContain("status: 'failed',");
    expect(source).toContain('must not be mistaken for a failed publish');
  });
});
