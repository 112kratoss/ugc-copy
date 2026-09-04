import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildGenerationModelCatalog, quoteGenerationModel } from '@/lib/generation-model-catalog';
import { buildCodeGenerationModelOperations } from '@/lib/generation-model-runtime';

/**
 * Release 2026-09-04-minimax-reference-duration moved minimax-h3 to reference-adjustment
 * pricing (Kie bills input clip seconds as well as output) by editing the manifest, while
 * `videoPricingExpression` stayed per-second on output alone. Nothing compared the two, so
 * the next release emitted from code would have carried production back to the
 * under-billing shape. This pins the shipped entry to the code build the way the other
 * release tests do.
 */

const manifest = JSON.parse(fs.readFileSync(path.resolve(
  process.cwd(),
  'config/generation-model-catalog/releases/2026-09-04-minimax-reference-duration.json',
), 'utf8')) as {
  release: { revision: string; basedOnRevision: string };
  entries: Array<{
    modelId: string;
    publicDescriptor: Record<string, unknown>;
    pricingStrategy: string;
    pricingConfig: Record<string, unknown>;
  }>;
};

describe('minimax reference-duration release', () => {
  it('chains onto the reference-caps release', () => {
    expect(manifest.release.revision).toBe('minimax-reference-duration-20260904');
    expect(manifest.release.basedOnRevision).toBe('video-reference-caps-20260903');
  });

  it('carries the pricing the code build now emits for minimax-h3', () => {
    const entry = manifest.entries.find((candidate) => candidate.modelId === 'minimax-h3');
    const operation = buildCodeGenerationModelOperations().find((candidate) => candidate.modelId === 'minimax-h3');
    expect(entry?.pricingStrategy).toBe('reference-adjustment');
    expect(entry?.pricingStrategy).toBe(operation?.pricingStrategy);
    expect(entry?.pricingConfig).toEqual(operation?.pricingConfig);
  });

  it('keeps the published descriptor equal to the code build', () => {
    const entry = manifest.entries.find((candidate) => candidate.modelId === 'minimax-h3')!;
    const { schemaVersion, ...publicDescriptor } = entry.publicDescriptor;
    expect(schemaVersion).toBe(2);
    const descriptor = buildGenerationModelCatalog({ platform: 'web', schemaVersion: 2 })
      .models.find((model) => model.id === 'minimax-h3');
    expect(publicDescriptor).toEqual(descriptor);
  });

  it('bills input clip seconds at the same rate as output', () => {
    // Kie: Unit Price × (Generated Video Duration + Input Video Duration); 2K is 13/s.
    expect(quoteGenerationModel({
      kind: 'video',
      modelId: 'minimax-h3',
      settings: { resolution: '2K', duration: 10, aspectRatio: '16:9', referenceMode: 'elements' },
      inputCounts: { images: 1, videos: 1 },
      inputMetadata: {
        slots: {
          imageReferences: { count: 1 },
          videoReferences: { count: 1, durationsSeconds: [10] },
        },
      },
    }).costCredits).toBe(260);
    expect(quoteGenerationModel({
      kind: 'video',
      modelId: 'minimax-h3',
      settings: { resolution: '768P', duration: 6, aspectRatio: '16:9' },
      inputCounts: {},
    }).costCredits).toBe(48);
  });
});
