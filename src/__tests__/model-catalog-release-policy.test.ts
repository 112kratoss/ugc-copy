import { describe, expect, it } from 'vitest';
import { buildGenerationModelCatalog } from '@/lib/generation-model-catalog';
import { measureModelCatalogRelease } from '@/lib/model-catalog-release-policy';
const model = buildGenerationModelCatalog({ platform: 'web', schemaVersion: 3 })
  .models[0];
function release(count = 500) {
  const defaults = { image: 'future-0', video: null, motion: null };
  return {
    revision: 'published-scale',
    schemaVersion: 2,
    defaults: { web: defaults, mobile: { ...defaults } },
    entries: Array.from({ length: count }, (_, i) => ({
      modelId: `future-${i}`,
      webEnabled: true,
      mobileEnabled: true,
      publicDescriptor: {
        ...model,
        id: `future-${i}`,
        kind: 'image',
        sortOrder: Math.floor(i / 3),
        description: '模型 — a remote model',
      },
    })),
  };
}
describe('materialized catalog release gates', () => {
  it.each([100, 500])(
    'bounds the transport for %i models without disabling legacy models',
    (count) => {
      const measured = measureModelCatalogRelease(release(count));
      expect(measured.currentBytes).toBeLessThanOrEqual(2048);
      expect(measured.maxPageBytes).toBeLessThanOrEqual(16384);
      expect(measured.maxDetailBytes).toBeLessThanOrEqual(16384);
      expect(measured.maxBatchBytes).toBeLessThanOrEqual(131072);
      expect(measured.legacyBytes).toBeGreaterThan(57344);
      expect(measured.legacyBudgetWarning).toBe(true);
    },
  );
  it('measures each platform against its own availability and defaults', () => {
    const candidate = release(3);
    candidate.entries[1].mobileEnabled = false;
    candidate.defaults.mobile.image = 'future-2';
    const measured = measureModelCatalogRelease(candidate);
    expect(measured.platforms.web.modelCount).toBe(3);
    expect(measured.platforms.mobile.modelCount).toBe(2);
    expect(measured.currentBytes).toBe(
      Math.max(
        measured.platforms.web.currentBytes,
        measured.platforms.mobile.currentBytes,
      ),
    );
  });
  it('gates actual UTF-8 descriptor bytes', () => {
    const candidate = release(1);
    candidate.entries[0].publicDescriptor.description = '模'.repeat(6000);
    expect(
      JSON.stringify(candidate.entries[0].publicDescriptor).length,
    ).toBeLessThan(16384);
    expect(() => measureModelCatalogRelease(candidate)).toThrow(
      'detail byte budget',
    );
  });
});
