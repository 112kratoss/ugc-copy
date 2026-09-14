import { describe, expect, it } from 'vitest';
import { buildGenerationModelCatalog } from '@/lib/generation-model-catalog';
import {
  catalogSummary,
  decodeCatalogCursor,
  encodeCatalogCursor,
  matchesCatalogEtag,
  catalogBytes,
} from '@/lib/model-catalog-transport';

describe('bounded model catalog transport', () => {
  it('binds pagination to revision and category, including equal sort orders', () => {
    const cursor = encodeCatalogCursor('release-1', 'image', {
      id: 'new-model',
      sortOrder: 10,
    });
    expect(decodeCatalogCursor(cursor, 'release-1', 'image')).toEqual({
      id: 'new-model',
      sortOrder: 10,
    });
    expect(() => decodeCatalogCursor(cursor, 'release-2', 'image')).toThrow();
    expect(() => decodeCatalogCursor(cursor, 'release-1', 'video')).toThrow();
    expect(() => decodeCatalogCursor('garbage', 'release-1', null)).toThrow();
  });
  it('supports weak, strong, multiple and wildcard conditional etags', () => {
    expect(matchesCatalogEtag('W/"a"', '"a"')).toBe(true);
    expect(matchesCatalogEtag('"b", W/"a"', '"a"')).toBe(true);
    expect(matchesCatalogEtag('*', '"a"')).toBe(true);
    expect(matchesCatalogEtag('"b"', '"a"')).toBe(false);
  });
  it('projects only picker fields and measures UTF-8 bytes', () => {
    const model = buildGenerationModelCatalog({
      platform: 'web',
      schemaVersion: 3,
    }).models[0];
    expect(Object.keys(catalogSummary(model)).sort()).toEqual([
      'badge',
      'description',
      'displayName',
      'id',
      'kind',
      'recommended',
      'sortOrder',
    ]);
    expect(catalogBytes('模型')).toBe(
      Buffer.byteLength(JSON.stringify('模型'), 'utf8'),
    );
  });
});

it('binds an all-category cursor without embedding summary fields or overriding its category', () => {
  const summary = {
    id: 'model-id',
    sortOrder: 4,
    kind: 'image',
    description: 'Large description'.repeat(200),
  };
  const cursor = encodeCatalogCursor('published', null, summary);
  expect(decodeCatalogCursor(cursor, 'published', null)).toEqual({
    id: 'model-id',
    sortOrder: 4,
  });
  expect(cursor.length).toBeLessThan(200);
  expect(Buffer.from(cursor, 'base64url').toString('utf8')).not.toContain(
    'description',
  );
});
