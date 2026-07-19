import { describe, expect, it, vi } from 'vitest';

import contractFixture from '../../contracts/generation-model-catalog-v1.json';
import {
  GENERATION_MODEL_CATALOG_CACHE_KEY,
  loadCachedGenerationModelCatalog,
  loadCachedGenerationModelCatalogEnvelope,
  parseGenerationModelCatalog,
  saveCachedGenerationModelCatalog,
} from '../lib/generation-model-catalog';

describe('mobile generation model catalog', () => {
  it('parses the shared schema-v1 contract fixture', () => {
    const catalog = parseGenerationModelCatalog(contractFixture);

    expect(catalog.revision).toBe('0123456789abcdef');
    expect(catalog.models[0]).toMatchObject({
      id: 'fixture-image',
      kind: 'image',
      inputs: { imageReferences: { max: 2, supportsNaming: true } },
    });
  });

  it('rejects malformed or unsupported catalogs', () => {
    expect(() => parseGenerationModelCatalog({ ...contractFixture, schemaVersion: 2 })).toThrow('Unsupported model catalog schema');
    expect(() => parseGenerationModelCatalog({ ...contractFixture, models: [{ id: 'broken' }] })).toThrow('Invalid model catalog');
  });

  it('persists and restores the last valid catalog', async () => {
    const storage = {
      getItem: vi.fn().mockResolvedValue(JSON.stringify(contractFixture)),
      setItem: vi.fn().mockResolvedValue(undefined),
    };

    await expect(loadCachedGenerationModelCatalog(storage)).resolves.toMatchObject({ revision: '0123456789abcdef' });
    await saveCachedGenerationModelCatalog(parseGenerationModelCatalog(contractFixture), storage, {
      etag: '"catalog-1"',
      fetchedAt: 123,
    });

    expect(storage.getItem).toHaveBeenCalledWith(GENERATION_MODEL_CATALOG_CACHE_KEY);
    expect(storage.setItem).toHaveBeenCalledWith(
      GENERATION_MODEL_CATALOG_CACHE_KEY,
      JSON.stringify({ catalog: contractFixture, etag: '"catalog-1"', fetchedAt: 123 })
    );
    storage.getItem.mockResolvedValue(JSON.stringify({ catalog: contractFixture, etag: '"catalog-1"', fetchedAt: 123 }));
    await expect(loadCachedGenerationModelCatalogEnvelope(storage)).resolves.toMatchObject({
      catalog: { revision: '0123456789abcdef' },
      etag: '"catalog-1"',
      fetchedAt: 123,
    });
  });

  it('ignores corrupt cached data', async () => {
    const storage = {
      getItem: vi.fn().mockResolvedValue('{not-json'),
      setItem: vi.fn(),
    };

    await expect(loadCachedGenerationModelCatalog(storage)).resolves.toBeNull();
  });
});
