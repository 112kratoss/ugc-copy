import { describe, expect, it } from 'vitest';

import {
  normalizeSourceToolSelectionsWithCatalog,
  validateSourceToolSelections,
  type SourceToolOption,
} from '@/lib/source-tools';

const catalog: SourceToolOption[] = [{
  slug: 'higgsfield',
  label: 'Higgsfield',
  models: [{ slug: 'soul', label: 'Soul' }],
  supportedMediaKinds: ['image', 'video'],
}];

describe('source tool selection validation', () => {
  it('rejects overlong and reserved creation names', () => {
    expect(validateSourceToolSelections([{
      toolLabel: 'x'.repeat(81),
      createTool: true,
    }])).toMatch(/80 characters/i);

    expect(validateSourceToolSelections([{
      toolLabel: 'Custom',
      createTool: true,
    }])).toMatch(/reserved/i);
  });

  it('preserves explicit creation intent while canonicalizing catalog entries', () => {
    expect(normalizeSourceToolSelectionsWithCatalog(catalog, [{
      toolLabel: 'Higgsfield',
      toolSlug: 'higgsfield',
      modelLabel: 'Soul',
      modelSlug: 'soul',
      createTool: true,
      createModel: true,
    }])).toEqual([{
      toolLabel: 'Higgsfield',
      toolSlug: 'higgsfield',
      modelLabel: 'Soul',
      modelSlug: 'soul',
      createTool: true,
      createModel: true,
    }]);
  });
});

describe('source model slugs with dots', () => {
  // The app's models as `withGenerationCatalogModels` lists them: the
  // generation model's id, dots and all, and its display name.
  const appCatalog: SourceToolOption[] = [{
    slug: 'magicbooklet',
    label: 'magicbooklet',
    models: [
      { slug: 'veo-3.1', label: 'Veo 3.1' },
      { slug: 'kling-3.0', label: 'Kling 3.0' },
    ],
    supportedMediaKinds: ['image', 'video'],
  }];

  function normalizeModel(source: SourceToolOption[], modelLabel: string, modelSlug: string) {
    const [selection] = normalizeSourceToolSelectionsWithCatalog(source, [{
      toolLabel: 'magicbooklet',
      toolSlug: 'magicbooklet',
      modelLabel,
      modelSlug,
    }]);
    return { modelLabel: selection.modelLabel, modelSlug: selection.modelSlug };
  }

  it('keeps the catalog slug when a composer sends the model id as its label', () => {
    expect(normalizeModel(appCatalog, 'veo-3.1', 'veo-3.1')).toEqual({
      modelLabel: 'Veo 3.1',
      modelSlug: 'veo-3.1',
    });
  });

  it('finds the catalog model from a slug the composer slugified', () => {
    expect(normalizeModel(appCatalog, 'kling-3.0', 'kling-3-0')).toEqual({
      modelLabel: 'Kling 3.0',
      modelSlug: 'kling-3.0',
    });
  });

  it('prefers the model whose slug was sent exactly', () => {
    const withHyphenatedTwin: SourceToolOption[] = [{
      ...appCatalog[0],
      models: [
        { slug: 'veo-3-1', label: 'Veo 3 1' },
        ...appCatalog[0].models,
      ],
    }];

    expect(normalizeModel(withHyphenatedTwin, 'Veo', 'veo-3.1')).toEqual({
      modelLabel: 'Veo 3.1',
      modelSlug: 'veo-3.1',
    });
    expect(normalizeModel(withHyphenatedTwin, 'Veo', 'veo-3-1')).toEqual({
      modelLabel: 'Veo 3 1',
      modelSlug: 'veo-3-1',
    });
  });
});
