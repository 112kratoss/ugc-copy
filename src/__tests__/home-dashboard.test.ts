import { describe, expect, it } from 'vitest';

import type { GenerationModelDescriptor } from '@/lib/generation-model-catalog';
import {
  HOME_WORKSPACE_ACTIVE_STATUSES,
  rankHomeWorkspaceGenerations,
  selectWhatsNewModels,
  toHomeWorkspaceGenerationView,
  type HomeWorkspaceGenerationView,
} from '@/lib/home-dashboard';

function buildSummaryRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'gen-1',
    status: 'succeeded',
    category: 'image',
    model: 'nano-banana-2',
    origin: 'creation',
    title: 'Test creation',
    created_at: '2026-07-20T10:00:00.000Z',
    completed_at: '2026-07-20T10:01:00.000Z',
    preview_url: 'https://cdn.example/preview.jpg',
    media: {
      kind: 'image',
      url: 'https://cdn.example/output.jpg',
      previewUrl: 'https://cdn.example/media-preview.jpg',
    },
    output_count: 2,
    ...overrides,
  };
}

function buildView(overrides: Partial<HomeWorkspaceGenerationView> = {}): HomeWorkspaceGenerationView {
  const base = toHomeWorkspaceGenerationView(buildSummaryRow());
  if (!base) {
    throw new Error('expected base view to project');
  }
  return { ...base, ...overrides };
}

function buildModel(overrides: Partial<GenerationModelDescriptor> = {}): GenerationModelDescriptor {
  return {
    id: 'seedream-5-pro',
    kind: 'image',
    displayName: 'Seedream 5 Pro',
    description: 'Production-ready stills',
    badge: null,
    recommended: false,
    sortOrder: 10,
    minClientSchemaVersion: 1,
    controls: [],
    capabilities: {
      multiShot: false,
      sound: false,
      fixedLens: false,
      googleSearch: false,
      outputFormat: false,
    },
    inputs: {
      imageReferences: null,
      videoReferences: null,
      audioReferences: null,
      startFrame: false,
      endFrame: false,
    },
    ...overrides,
  };
}

describe('toHomeWorkspaceGenerationView', () => {
  it('projects a summary row', () => {
    const view = toHomeWorkspaceGenerationView(buildSummaryRow());

    expect(view).toMatchObject({
      id: 'gen-1',
      status: 'succeeded',
      category: 'image',
      model: 'nano-banana-2',
      origin: 'creation',
      previewUrl: 'https://cdn.example/preview.jpg',
      mediaKind: 'image',
      outputCount: 2,
      isActive: false,
      isFailed: false,
    });
  });

  it.each(HOME_WORKSPACE_ACTIVE_STATUSES)('marks %s rows active', (status) => {
    const view = toHomeWorkspaceGenerationView(buildSummaryRow({ status }));

    expect(view?.isActive).toBe(true);
    expect(view?.isFailed).toBe(false);
  });

  it('includes pending rows, which Studio buckets ignore', () => {
    const view = toHomeWorkspaceGenerationView(buildSummaryRow({ status: 'pending' }));

    expect(view).not.toBeNull();
    expect(view?.isActive).toBe(true);
  });

  it('normalizes legacy completed to succeeded', () => {
    const view = toHomeWorkspaceGenerationView(buildSummaryRow({ status: 'completed' }));

    expect(view?.status).toBe('succeeded');
    expect(view?.isActive).toBe(false);
  });

  it('flags failed rows', () => {
    const view = toHomeWorkspaceGenerationView(buildSummaryRow({ status: 'failed' }));

    expect(view?.isFailed).toBe(true);
    expect(view?.isActive).toBe(false);
  });

  it('returns null for rows missing essentials or with unknown status', () => {
    expect(toHomeWorkspaceGenerationView(buildSummaryRow({ id: null }))).toBeNull();
    expect(toHomeWorkspaceGenerationView(buildSummaryRow({ created_at: undefined }))).toBeNull();
    expect(toHomeWorkspaceGenerationView(buildSummaryRow({ status: 'exploded' }))).toBeNull();
  });

  it('falls back to media preview, then image output url', () => {
    const mediaPreview = toHomeWorkspaceGenerationView(buildSummaryRow({ preview_url: null }));
    expect(mediaPreview?.previewUrl).toBe('https://cdn.example/media-preview.jpg');

    const imageOutput = toHomeWorkspaceGenerationView(buildSummaryRow({
      preview_url: null,
      media: { kind: 'image', url: 'https://cdn.example/output.jpg', previewUrl: null },
    }));
    expect(imageOutput?.previewUrl).toBe('https://cdn.example/output.jpg');

    const videoWithoutPreview = toHomeWorkspaceGenerationView(buildSummaryRow({
      preview_url: null,
      category: 'video',
      media: { kind: 'video', url: 'https://cdn.example/output.mp4', previewUrl: null },
    }));
    expect(videoWithoutPreview?.previewUrl).toBeNull();
  });

  it('derives media kind from category when the media descriptor is absent', () => {
    expect(
      toHomeWorkspaceGenerationView(buildSummaryRow({ media: null, category: 'motion' }))?.mediaKind,
    ).toBe('video');
    expect(
      toHomeWorkspaceGenerationView(buildSummaryRow({ media: null, category: 'voiceover' }))?.mediaKind,
    ).toBe('audio');
    expect(
      toHomeWorkspaceGenerationView(buildSummaryRow({ media: null, category: 'workflow' }))?.mediaKind,
    ).toBeNull();
  });
});

describe('rankHomeWorkspaceGenerations', () => {
  it('puts active runs first, newest on top, then recent finished work', () => {
    const views = [
      buildView({ id: 'done-old', status: 'succeeded', isActive: false, createdAt: '2026-07-18T00:00:00.000Z' }),
      buildView({ id: 'active-old', status: 'waiting', isActive: true, createdAt: '2026-07-19T00:00:00.000Z' }),
      buildView({ id: 'done-new', status: 'succeeded', isActive: false, createdAt: '2026-07-21T00:00:00.000Z' }),
      buildView({ id: 'active-new', status: 'processing', isActive: true, createdAt: '2026-07-22T00:00:00.000Z' }),
    ];

    const ranked = rankHomeWorkspaceGenerations(views);

    expect(ranked.active.map((view) => view.id)).toEqual(['active-new', 'active-old']);
    expect(ranked.recent.map((view) => view.id)).toEqual(['done-new', 'done-old']);
  });

  it('keeps failures inline in recents, flagged', () => {
    const views = [
      buildView({ id: 'ok', status: 'succeeded', isActive: false, createdAt: '2026-07-20T00:00:00.000Z' }),
      buildView({
        id: 'boom',
        status: 'failed',
        isActive: false,
        isFailed: true,
        createdAt: '2026-07-21T00:00:00.000Z',
      }),
    ];

    const ranked = rankHomeWorkspaceGenerations(views);

    expect(ranked.recent.map((view) => view.id)).toEqual(['boom', 'ok']);
    expect(ranked.recent[0]?.isFailed).toBe(true);
  });

  it('caps recents at maxRecent without touching active runs', () => {
    const views = [
      ...Array.from({ length: 6 }, (_, index) => buildView({
        id: `done-${index}`,
        isActive: false,
        createdAt: `2026-07-1${index}T00:00:00.000Z`,
      })),
      ...Array.from({ length: 3 }, (_, index) => buildView({
        id: `active-${index}`,
        status: 'processing',
        isActive: true,
        createdAt: `2026-07-2${index}T00:00:00.000Z`,
      })),
    ];

    const ranked = rankHomeWorkspaceGenerations(views, { maxRecent: 2 });

    expect(ranked.active).toHaveLength(3);
    expect(ranked.recent).toHaveLength(2);
  });
});

describe('selectWhatsNewModels', () => {
  it('selects models with a New badge, case-insensitively', () => {
    const models = [
      buildModel({ id: 'old-pro', badge: 'Pro' }),
      buildModel({ id: 'fresh-video', kind: 'video', badge: 'NEW ' }),
      buildModel({ id: 'fresh-motion', kind: 'motion', badge: 'new' }),
      buildModel({ id: 'plain' }),
    ];

    const selected = selectWhatsNewModels(models);

    expect(selected.map((model) => model.id)).toEqual(['fresh-video', 'fresh-motion']);
  });

  it('falls back to catalog head order when nothing is badged New', () => {
    const models = [
      buildModel({ id: 'first' }),
      buildModel({ id: 'second', badge: 'Pro' }),
      buildModel({ id: 'third' }),
    ];

    expect(selectWhatsNewModels(models, 2).map((model) => model.id)).toEqual(['first', 'second']);
  });

  it('maps kind to create hrefs and accents', () => {
    const [image, video, motion] = selectWhatsNewModels([
      buildModel({ id: 'img model', badge: 'New' }),
      buildModel({ id: 'vid', kind: 'video', badge: 'New' }),
      buildModel({ id: 'mot', kind: 'motion', badge: 'New' }),
    ]);

    expect(image).toMatchObject({ href: '/create-image?model=img%20model', accent: 'image' });
    expect(video).toMatchObject({ href: '/create-video?model=vid', accent: 'video' });
    expect(motion).toMatchObject({ href: '/create-motion?model=mot', accent: 'motion' });
  });

  it('respects the limit and handles empty input', () => {
    const models = Array.from({ length: 6 }, (_, index) => buildModel({ id: `model-${index}`, badge: 'New' }));

    expect(selectWhatsNewModels(models)).toHaveLength(4);
    expect(selectWhatsNewModels(models, 0)).toEqual([]);
    expect(selectWhatsNewModels([])).toEqual([]);
  });
});
