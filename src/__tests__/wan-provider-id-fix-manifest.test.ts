import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const manifest = JSON.parse(fs.readFileSync(path.resolve(
  process.cwd(),
  'config/generation-model-catalog/releases/2026-07-25-wan-provider-id-fix.json',
), 'utf8')) as {
  mode: string;
  release: { revision: string; basedOnRevision: string };
  expectedModelIds: string[];
  entries: Array<{
    modelId: string;
    adapterKey: string;
    pricingStrategy: string;
    pricingConfig: { pricing?: Record<string, number> };
    providerModelMap: Record<string, string>;
  }>;
};

/**
 * Provider ids quoted from the `model` parameter enum in Kie's OpenAPI specs,
 * read 2026-07-25. Each spec declares its value as the *only* allowed enum
 * member, which is why the dotted app ids the catalog previously sent were
 * rejected outright.
 *   https://docs.kie.ai/market/wan/2-7-image.md
 *   https://docs.kie.ai/market/wan/2-7-image-pro.md
 */
const EXPECTED_PROVIDER_IDS: Record<string, string> = {
  'wan-2.7-image': 'wan/2-7-image',
  'wan-2.7-image-pro': 'wan/2-7-image-pro',
};

/** Live prices at the time the release was cut. Must survive it unchanged. */
const FROZEN_PRICING: Record<string, Record<string, number>> = {
  'wan-2.7-image': { '1K': 4.8, '2K': 4.8 },
  'wan-2.7-image-pro': { '1K': 12, '2K': 12, '4K': 12 },
};

describe('wan provider id fix release manifest', () => {
  it('changes exactly the two Wan image models and nothing else', () => {
    expect(manifest.entries.map((entry) => entry.modelId).sort())
      .toEqual(['wan-2.7-image', 'wan-2.7-image-pro']);
  });

  it('routes both models to the provider ids Kie actually accepts', () => {
    for (const entry of manifest.entries) {
      expect(entry.providerModelMap.default).toBe(EXPECTED_PROVIDER_IDS[entry.modelId]);
    }
  });

  it('never re-emits a dotted app id as a provider id', () => {
    for (const entry of manifest.entries) {
      for (const providerId of Object.values(entry.providerModelMap)) {
        expect(providerId).not.toMatch(/^wan-2\.7/);
      }
    }
  });

  it('leaves pricing byte-identical, so this release cannot move money', () => {
    // The whole point of scoping the release this narrowly: a provider-routing
    // correction must not become a silent repricing of two live paid models.
    for (const entry of manifest.entries) {
      expect(entry.pricingConfig.pricing).toEqual(FROZEN_PRICING[entry.modelId]);
      expect(entry.pricingStrategy).toBe('image-v1');
    }
  });

  it('keeps the adapter and the full model inventory unchanged', () => {
    for (const entry of manifest.entries) {
      expect(entry.adapterKey).toBe('image-v1');
    }
    // clone-active carries the other 27 models through untouched.
    expect(manifest.mode).toBe('clone-active');
    expect(manifest.expectedModelIds).toHaveLength(29);
  });

  it('is based on the release it was generated from', () => {
    expect(manifest.release.basedOnRevision).toBe('seedance2-hd-v2-20260724');
    expect(manifest.release.revision).toBe('wan-provider-id-fix-20260725');
  });
});
