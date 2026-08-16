import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { IMAGE_MODELS, VIDEO_MODELS } from '@/lib/models';

interface ManifestEntry {
  modelId: string;
  kind: string;
  adapterKey: string;
  pricingStrategy: string;
  pricingConfig: Record<string, unknown>;
  providerModelMap: Record<string, string>;
  validationStrategy: string;
  validationConfig: Record<string, unknown>;
  webEnabled: boolean;
  mobileEnabled: boolean;
  publicDescriptor: Record<string, unknown>;
}

interface Manifest {
  mode: string;
  release: { revision: string; basedOnRevision: string; schemaVersion: number };
  expectedModelIds: string[];
  entries: ManifestEntry[];
  acceptanceQuotes?: Array<{ modelId: string; settings: Record<string, unknown>; expectedCredits: number }>;
}

function load(name: string): Manifest {
  return JSON.parse(fs.readFileSync(path.resolve(
    process.cwd(),
    `config/generation-model-catalog/releases/${name}`,
  ), 'utf8')) as Manifest;
}

const imageManifest = load('2026-08-15-image-dropins.json');
const videoManifest = load('2026-08-15-video-dropins.json');

/**
 * Provider ids quoted from the `model` parameter enum in Kie's OpenAPI specs, read
 * 2026-08-15 and recorded in model_api_references/dropin-models-2026-08-15.md.
 * Two of these diverge from their docs path, which is the trap this table exists to pin:
 *   market/qwen3-pro/*  ->  qwen3/pro-*
 *   market/kling/v3-omni-*  ->  kling-3.0-omni/*
 */
const EXPECTED_PROVIDER_IDS: Record<string, Record<string, string>> = {
  'grok-imagine-image-2': {
    default: 'grok-imagine-image-2-0/text-to-image',
    text: 'grok-imagine-image-2-0/text-to-image',
  },
  qwen3: { text: 'qwen3/text-to-image', reference: 'qwen3/image-to-image' },
  'qwen3-pro': { text: 'qwen3/pro-text-to-image', reference: 'qwen3/pro-image-to-image' },
  'ideogram-character': {
    default: 'ideogram/character',
    text: 'ideogram/character',
    reference: 'ideogram/character',
  },
  'seedance-2-5': { default: 'bytedance/seedance-2-5' },
  'kling-o3': {
    default: 'kling-3.0-omni/text-to-video',
    text: 'kling-3.0-omni/text-to-video',
    image: 'kling-3.0-omni/image-to-video',
    reference: 'kling-3.0-omni/reference-to-video',
  },
  'minimax-h3': {
    default: 'minimax-h3/text-to-video',
    text: 'minimax-h3/text-to-video',
    image: 'minimax-h3/image-to-video',
    reference: 'minimax-h3/reference-to-video',
  },
};

describe('drop-in model release manifests', () => {
  it('adds exactly the four image models and nothing else', () => {
    expect(imageManifest.entries.map((entry) => entry.modelId).sort())
      .toEqual(['grok-imagine-image-2', 'ideogram-character', 'qwen3', 'qwen3-pro']);
    expect(imageManifest.expectedModelIds).toHaveLength(33);
  });

  it('adds exactly the three video models and nothing else', () => {
    expect(videoManifest.entries.map((entry) => entry.modelId).sort())
      .toEqual(['kling-o3', 'minimax-h3', 'seedance-2-5']);
    expect(videoManifest.expectedModelIds).toHaveLength(36);
  });

  it('chains the video release onto the image release', () => {
    expect(imageManifest.release.basedOnRevision).toBe('wan-provider-id-fix-20260725');
    expect(videoManifest.release.basedOnRevision).toBe(imageManifest.release.revision);
    for (const manifest of [imageManifest, videoManifest]) {
      expect(manifest.mode).toBe('clone-active');
      expect(manifest.release.schemaVersion).toBe(2);
    }
  });

  it('routes every new model to the provider id its spec declares', () => {
    for (const entry of [...imageManifest.entries, ...videoManifest.entries]) {
      expect(entry.providerModelMap, entry.modelId).toEqual(EXPECTED_PROVIDER_IDS[entry.modelId]);
    }
  });

  it('never ships a provider id that merely echoes the app id', () => {
    // The generic fallthrough sends the app id verbatim, which is what broke Wan. Every
    // model added here has a provider id that genuinely differs from its app id.
    for (const entry of [...imageManifest.entries, ...videoManifest.entries]) {
      for (const providerId of Object.values(entry.providerModelMap)) {
        expect(providerId, entry.modelId).not.toBe(entry.modelId);
      }
    }
  });

  it('keeps every new model live on both platforms', () => {
    for (const entry of [...imageManifest.entries, ...videoManifest.entries]) {
      expect(entry.webEnabled, entry.modelId).toBe(true);
      expect(entry.mobileEnabled, entry.modelId).toBe(true);
    }
  });

  it('carries the declarative adapters and validation the runtime builds', () => {
    // grok-imagine-image-2 and the qwen pair are fully expressible as kie-task-v1
    // bindings; ideogram-character needs a value-map transform (aspect ratio →
    // image_size names) the adapter does not have, so it stays on the ladder.
    const expectedImageAdapters: Record<string, string> = {
      'grok-imagine-image-2': 'kie-task-v1',
      qwen3: 'kie-task-v1',
      'qwen3-pro': 'kie-task-v1',
      'ideogram-character': 'image-v1',
    };
    for (const entry of imageManifest.entries) {
      expect(entry.kind).toBe('image');
      expect(entry.adapterKey, entry.modelId).toBe(expectedImageAdapters[entry.modelId]);
      expect(entry.validationStrategy).toBe('descriptor-rules-v1');
    }
    for (const entry of videoManifest.entries) {
      expect(entry.kind).toBe('video');
      expect(entry.adapterKey).toBe('video-v1');
      expect(entry.validationStrategy).toBe('descriptor-rules-v1');
    }
  });

  it('requires a character reference on ideogram-character', () => {
    const entry = imageManifest.entries.find((item) => item.modelId === 'ideogram-character');
    const rules = entry?.validationConfig.rules as Array<Record<string, unknown>>;
    expect(rules).toContainEqual(expect.objectContaining({
      type: 'min-slot-count',
      slotKey: 'imageReferences',
      min: 1,
    }));
  });

  it('omits the empty passthroughSettingKeys the manifest validator rejects', () => {
    for (const entry of imageManifest.entries) {
      expect(entry.validationConfig.passthroughSettingKeys, entry.modelId).toBeUndefined();
    }
  });

  it('prices seedance 2.5 identically to the code catalog', () => {
    // The only strategy the manifest validator can evaluate, so these quotes are
    // checked at stage time too — keep them agreeing with models.ts.
    expect(videoManifest.acceptanceQuotes).toEqual([
      { modelId: 'seedance-2-5', settings: { resolution: '720p', duration: 10 }, inputs: [], expectedCredits: 630 },
      { modelId: 'seedance-2-5', settings: { resolution: '480p', duration: 30 }, inputs: [], expectedCredits: 840 },
    ]);
    const pricing = VIDEO_MODELS['seedance-2-5'].pricing;
    expect(pricing['720p'].noVideo * 10).toBe(630);
    expect(pricing['480p'].noVideo * 30).toBe(840);
  });

  it('declares descriptors that match the registries the app renders from', () => {
    for (const entry of imageManifest.entries) {
      const model = IMAGE_MODELS[entry.modelId as keyof typeof IMAGE_MODELS];
      expect(entry.publicDescriptor.displayName, entry.modelId).toBe(model.displayName);
      expect(entry.publicDescriptor.id, entry.modelId).toBe(model.id);
    }
    for (const entry of videoManifest.entries) {
      const model = VIDEO_MODELS[entry.modelId as keyof typeof VIDEO_MODELS];
      expect(entry.publicDescriptor.displayName, entry.modelId).toBe(model.displayName);
      expect(entry.publicDescriptor.id, entry.modelId).toBe(model.id);
    }
  });
});
