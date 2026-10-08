import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildGenerationModelCatalog, quoteGenerationModel } from '@/lib/generation-model-catalog';
import { buildCodeGenerationModelOperations } from '@/lib/generation-model-runtime';

/**
 * Release 2026-10-08-pixverse-mobile: PixVerse V6 shipped web-only in kie-video-models-20261008
 * because the installed apps name every maker in their AI-data question and PixVerse was new
 * there. The apps name it from consent version 2 on (ugc-mobile/lib/ai-data-consent.ts), so
 * this release lists the one changed model with its availability turned on for mobile. The
 * entry must equal the code build byte for byte (the shadow verifier diffs projections), and
 * nothing else about the model may change in the same release.
 */

interface ManifestEntry {
  modelId: string;
  kind: string;
  webEnabled: boolean;
  mobileEnabled: boolean;
  adapterKey: string;
  adapterConfig: Record<string, unknown>;
  providerModelMap: Record<string, string>;
  pricingStrategy: string;
  pricingConfig: Record<string, unknown>;
  validationStrategy: string;
  validationConfig: Record<string, unknown>;
  publicDescriptor: Record<string, unknown>;
}

interface Manifest {
  mode: string;
  release: { revision: string; basedOnRevision: string; schemaVersion: number };
  expectedModelIds: string[];
  addsModelIds?: string[];
  entries: ManifestEntry[];
}

function read(name: string): Manifest {
  return JSON.parse(fs.readFileSync(path.resolve(
    process.cwd(),
    `config/generation-model-catalog/releases/${name}`,
  ), 'utf8')) as Manifest;
}

const manifest = read('2026-10-08-pixverse-mobile.json');
const base = read('2026-10-08-kie-video-models.json');

const catalog = buildGenerationModelCatalog({ platform: 'web', schemaVersion: 2 });
const mobileCatalog = buildGenerationModelCatalog({ platform: 'mobile', schemaVersion: 2 });
const operation = buildCodeGenerationModelOperations().find((candidate) => candidate.modelId === 'pixverse-v6')!;

function entry(): ManifestEntry {
  const found = manifest.entries.find((candidate) => candidate.modelId === 'pixverse-v6');
  if (!found) throw new Error('no manifest entry for pixverse-v6');
  return found;
}

function mobileMakers(): Set<string> {
  const source = fs.readFileSync(path.resolve(process.cwd(), 'ugc-mobile/lib/ai-data-consent.ts'), 'utf8');
  const list = source.match(/export const AI_MODEL_MAKERS = \[([\s\S]*?)\] as const;/)?.[1] ?? '';
  return new Set([...list.matchAll(/'([^']+)'/g)].map((match) => match[1]));
}

describe('pixverse-mobile release', () => {
  it('chains onto the release production is running and changes PixVerse V6 only', () => {
    expect(manifest.release.revision).toBe('pixverse-mobile-20261008');
    expect(manifest.release.basedOnRevision).toBe(base.release.revision);
    expect(manifest.release.schemaVersion).toBe(2);
    expect(manifest.mode).toBe('clone-active');
    expect(manifest.entries.map((candidate) => candidate.modelId)).toEqual(['pixverse-v6']);
    expect(manifest.addsModelIds).toBeUndefined();
    // The base added five models; this release clones that inventory and adds none.
    expect([...manifest.expectedModelIds].sort()).toEqual([...base.expectedModelIds, ...(base.addsModelIds ?? [])].sort());
    expect(manifest.expectedModelIds).toContain('pixverse-v6');
  });

  it('is the code build, with mobile on', () => {
    const { schemaVersion, ...publicDescriptor } = entry().publicDescriptor;
    expect(schemaVersion).toBe(2);
    expect(publicDescriptor).toEqual(catalog.models.find((model) => model.id === 'pixverse-v6'));
    expect(entry().webEnabled).toBe(true);
    expect(entry().mobileEnabled).toBe(true);
    expect(entry().publicDescriptor.availability).toEqual({ web: true, mobile: true });
    expect(mobileCatalog.models.map((model) => model.id)).toContain('pixverse-v6');
    expect(entry().adapterKey).toBe(operation.adapterKey);
    expect(entry().providerModelMap).toEqual(operation.providerModelMap);
    expect(entry().pricingStrategy).toBe(operation.pricingStrategy);
    expect(entry().pricingConfig).toEqual(operation.pricingConfig);
    expect(entry().validationStrategy).toBe(operation.validationStrategy);
  });

  it('changes nothing about the model but where it is offered', () => {
    const before = base.entries.find((candidate) => candidate.modelId === 'pixverse-v6')!;
    const after = entry();
    const descriptorBefore: Record<string, unknown> = { ...before.publicDescriptor };
    const descriptorAfter: Record<string, unknown> = { ...after.publicDescriptor };
    delete descriptorBefore.availability;
    delete descriptorAfter.availability;
    expect(descriptorAfter).toEqual(descriptorBefore);
    expect(after.providerModelMap).toEqual(before.providerModelMap);
    expect(after.pricingConfig).toEqual(before.pricingConfig);
    expect(after.validationConfig).toEqual(before.validationConfig);
    expect(after.adapterConfig).toEqual(before.adapterConfig);
    // Same prices as the evidence file: 360p 5 s 20 credits, 720p 10 s with sound and a
    // reference 108.
    expect(quoteGenerationModel({
      kind: 'video',
      modelId: 'pixverse-v6',
      settings: { aspectRatio: '16:9', resolution: '360p', duration: 5 },
      inputCounts: {},
      catalogRevision: catalog.revision,
    }, { catalog }).costCredits).toBe(20);
  });

  it('is published only once the apps name PixVerse in their AI-data question', () => {
    // The question's maker list and its version live in ugc-mobile/lib/ai-data-consent.ts;
    // raising the version makes every phone ask again. Both OTAs must be in users' hands
    // before this release is published, so the reviewer and every user see the maker named.
    expect(mobileMakers()).toContain('PixVerse');
    const source = fs.readFileSync(path.resolve(process.cwd(), 'ugc-mobile/lib/ai-data-consent.ts'), 'utf8');
    expect(source).toMatch(/export const AI_DATA_CONSENT_VERSION = 2;/);
  });
});
