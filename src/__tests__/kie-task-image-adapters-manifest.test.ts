import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildCodeGenerationModelOperations } from '@/lib/generation-model-runtime';

/**
 * Release manifest test for the kie-task-v1 image adapter migration
 * (2026-08-16). This release moves nine image models off the hand-coded
 * payload ladder; it must change adapter wiring and NOTHING else — pricing,
 * provider ids, and validation stay byte-equal to the code build, which the
 * emitter derives them from.
 */

const MIGRATED = [
  'nano-banana-2-lite',
  'nano-banana-2',
  'nano-banana-pro',
  'gpt-image-2',
  'flux-2-pro',
  'z-image',
  'imagen-4-fast',
  'imagen-4',
  'imagen-4-ultra',
];

const manifest = JSON.parse(fs.readFileSync(path.resolve(
  process.cwd(),
  'config/generation-model-catalog/releases/2026-08-16-kie-task-image-adapters.json',
), 'utf8')) as {
  mode: string;
  release: { revision: string; basedOnRevision: string };
  expectedModelIds: string[];
  entries: Array<{
    modelId: string;
    kind: string;
    adapterKey: string;
    adapterConfig: Record<string, unknown>;
    providerModelMap: Record<string, string>;
    pricingStrategy: string;
    pricingConfig: Record<string, unknown>;
    validationStrategy: string;
    webEnabled: boolean;
    mobileEnabled: boolean;
  }>;
};

const operations = new Map(
  buildCodeGenerationModelOperations().map((operation) => [operation.modelId, operation]),
);

describe('kie-task image adapter migration manifest', () => {
  it('migrates exactly the nine ladder models and adds no models', () => {
    expect(manifest.entries.map((entry) => entry.modelId).sort()).toEqual([...MIGRATED].sort());
    expect(manifest.expectedModelIds).toHaveLength(36);
    expect(manifest.mode).toBe('clone-active');
    expect(manifest.release.basedOnRevision).toBe('video-dropins-20260815');
  });

  it('moves every entry onto kie-task-v1 with a non-empty adapter config', () => {
    for (const entry of manifest.entries) {
      expect(entry.kind, entry.modelId).toBe('image');
      expect(entry.adapterKey, entry.modelId).toBe('kie-task-v1');
      expect(Object.keys(entry.adapterConfig).length, entry.modelId).toBeGreaterThan(0);
      expect(entry.webEnabled && entry.mobileEnabled, entry.modelId).toBe(true);
    }
  });

  it('keeps adapter wiring, pricing, and provider routing equal to the code build', () => {
    for (const entry of manifest.entries) {
      const operation = operations.get(entry.modelId);
      expect(operation, entry.modelId).toBeDefined();
      expect(entry.adapterKey, entry.modelId).toBe(operation!.adapterKey);
      expect(entry.adapterConfig, entry.modelId).toEqual(operation!.adapterConfig);
      expect(entry.providerModelMap, entry.modelId).toEqual(operation!.providerModelMap);
      expect(entry.pricingStrategy, entry.modelId).toBe(operation!.pricingStrategy);
      expect(entry.pricingConfig, entry.modelId).toEqual(operation!.pricingConfig);
      expect(entry.validationStrategy, entry.modelId).toBe(operation!.validationStrategy);
    }
  });
});
