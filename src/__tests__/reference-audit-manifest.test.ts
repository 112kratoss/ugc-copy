import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildGenerationModelCatalog,
  quoteGenerationModel,
  CatalogError,
  type GenerationModelQuoteInput,
} from '@/lib/generation-model-catalog';
import { buildCodeGenerationModelOperations } from '@/lib/generation-model-runtime';

/**
 * Release 2026-09-04-reference-audit: the fixes from
 * docs/model-reference-inputs-audit-2026-09-04.md that live in the catalog — three
 * pass-through prices re-read from kie.ai, and five quote-time rules for contracts Kie
 * enforces that the descriptor alone cannot express. Every entry must equal the code
 * build byte for byte (the shadow verifier diffs projections), so the manifest is checked
 * against `buildGenerationModelCatalog` and `buildCodeGenerationModelOperations` rather
 * than against hand-copied expectations.
 */

const manifest = JSON.parse(fs.readFileSync(path.resolve(
  process.cwd(),
  'config/generation-model-catalog/releases/2026-09-04-reference-audit.json',
), 'utf8')) as {
  release: { revision: string; basedOnRevision: string };
  entries: Array<{
    modelId: string;
    publicDescriptor: Record<string, unknown>;
    pricingStrategy: string;
    pricingConfig: Record<string, unknown>;
    validationConfig: Record<string, unknown>;
  }>;
};

const catalog = buildGenerationModelCatalog({ platform: 'web', schemaVersion: 2 });
const operations = new Map(
  buildCodeGenerationModelOperations().map((operation) => [operation.modelId, operation]),
);

function descriptor(modelId: string) {
  const found = catalog.models.find((model) => model.id === modelId);
  if (!found) throw new Error(`no descriptor for ${modelId}`);
  return found;
}

function fieldErrorsFor(input: GenerationModelQuoteInput): Record<string, string> {
  try {
    quoteGenerationModel(input);
  } catch (error) {
    if (error instanceof CatalogError) return error.fieldErrors;
    throw error;
  }
  throw new Error('expected the quote to be rejected');
}

function rulesFor(modelId: string): Array<Record<string, unknown>> {
  return (operations.get(modelId)?.validationConfig.rules ?? []) as Array<Record<string, unknown>>;
}

describe('reference-audit release', () => {
  it('chains onto the release production is running', () => {
    expect(manifest.release.revision).toBe('reference-audit-20260904');
    expect(manifest.release.basedOnRevision).toBe('minimax-reference-duration-20260904');
  });

  it('carries every model whose pricing or rules the audit changed, and nothing else', () => {
    expect(manifest.entries.map((entry) => entry.modelId).sort()).toEqual([
      'gpt-image-2',
      'grok-imagine-video',
      'kling-2.6',
      'kling-3.0-video',
      'minimax-h3',
      'seedance-1.5-pro',
      'seedance-2',
      'seedance-2-5',
      'seedance-2-fast',
      'seedance-2-mini',
      'veo-3.1',
      'wan-2.7',
    ]);
  });

  it.each(manifest.entries.map((entry) => entry.modelId))(
    '%s: the manifest entry is the code build',
    (modelId) => {
      const entry = manifest.entries.find((candidate) => candidate.modelId === modelId)!;
      const { schemaVersion, ...publicDescriptor } = entry.publicDescriptor;
      expect(schemaVersion).toBe(2);
      expect(publicDescriptor).toEqual(descriptor(modelId));
      const operation = operations.get(modelId)!;
      expect(entry.pricingStrategy).toBe(operation.pricingStrategy);
      expect(entry.pricingConfig).toEqual(operation.pricingConfig);
      const { passthroughSettingKeys, ...validationConfig } = operation.validationConfig as Record<string, unknown>;
      expect(entry.validationConfig).toEqual(
        Array.isArray(passthroughSettingKeys) && passthroughSettingKeys.length > 0
          ? { ...validationConfig, passthroughSettingKeys }
          : validationConfig,
      );
    },
  );

  describe('prices re-read from kie.ai on 2026-09-04', () => {
    it('bills Grok Imagine Video at 2.4 / 4.5 credits per second', () => {
      expect(quoteGenerationModel({
        kind: 'video',
        modelId: 'grok-imagine-video',
        settings: { resolution: '480p', duration: 6, aspectRatio: '16:9', mode: 'normal' },
        inputCounts: {},
      }).costCredits).toBe(15);
      expect(quoteGenerationModel({
        kind: 'video',
        modelId: 'grok-imagine-video',
        settings: { resolution: '720p', duration: 10, aspectRatio: '16:9', mode: 'normal' },
        inputCounts: {},
      }).costCredits).toBe(45);
    });

    it('bills Seedance 1.5 Pro 480p 12 s at Kie\'s per-second rate', () => {
      expect(quoteGenerationModel({
        kind: 'video',
        modelId: 'seedance-1.5-pro',
        settings: { resolution: '480p', duration: 12, aspectRatio: '16:9', sound: false },
        inputCounts: {},
      }).costCredits).toBe(21);
      expect(quoteGenerationModel({
        kind: 'video',
        modelId: 'seedance-1.5-pro',
        settings: { resolution: '480p', duration: 12, aspectRatio: '16:9', sound: true },
        inputCounts: {},
      }).costCredits).toBe(42);
    });

    it('bills Veo quality 4K text-to-video at the listed 370', () => {
      expect(quoteGenerationModel({
        kind: 'video',
        modelId: 'veo-3.1',
        settings: { mode: 'veo3', resolution: '4k', aspectRatio: '16:9' },
        inputCounts: {},
      }).costCredits).toBe(370);
    });
  });

  describe('contracts Kie enforces that the descriptor cannot express', () => {
    it('renders GPT Image 2 at 5:4 and 4:5 in 1K only', () => {
      for (const aspectRatio of ['5:4', '4:5']) {
        expect(Object.values(fieldErrorsFor({
          kind: 'image',
          modelId: 'gpt-image-2',
          settings: { aspectRatio, resolution: '2K' },
          inputCounts: {},
        })).join(' ')).toMatch(/1K only/);
        expect(() => quoteGenerationModel({
          kind: 'image',
          modelId: 'gpt-image-2',
          settings: { aspectRatio, resolution: '1K' },
          inputCounts: {},
        })).not.toThrow();
      }
      // Ratios outside the rule keep the full ladder.
      expect(() => quoteGenerationModel({
        kind: 'image',
        modelId: 'gpt-image-2',
        settings: { aspectRatio: '16:9', resolution: '4K' },
        inputCounts: {},
      })).not.toThrow();
    });

    it('holds Wan 2.7 reference runs to ten seconds, and text runs to fifteen', () => {
      const withClip = (duration: number, referenceMode: string): GenerationModelQuoteInput => ({
        kind: 'video',
        modelId: 'wan-2.7',
        settings: { resolution: '720p', duration, aspectRatio: '16:9', referenceMode },
        inputCounts: referenceMode === 'elements' ? { videos: 1 } : {},
        inputMetadata: referenceMode === 'elements'
          ? { slots: { videoReferences: { count: 1, durationsSeconds: [5] } } }
          : undefined,
      });
      expect(Object.values(fieldErrorsFor(withClip(15, 'elements'))).join(' ')).toMatch(/at most 10 seconds/);
      expect(() => quoteGenerationModel(withClip(10, 'elements'))).not.toThrow();
      expect(() => quoteGenerationModel(withClip(15, 'frames'))).not.toThrow();
    });

    it('refuses an end frame without a start frame wherever the provider reads frames positionally', () => {
      const endOnly = (modelId: string, settings: Record<string, string | number | boolean>): GenerationModelQuoteInput => ({
        kind: 'video',
        modelId,
        settings: { aspectRatio: '16:9', referenceMode: 'frames', ...settings },
        inputCounts: { images: 1 },
        inputMetadata: { slots: { startFrame: { count: 0 }, endFrame: { count: 1 } } },
      });
      for (const [modelId, settings] of [
        ['seedance-2-mini', { resolution: '720p', duration: 6 }],
        ['seedance-2-5', { resolution: '720p', duration: 6 }],
        ['seedance-1.5-pro', { resolution: '720p', duration: 8 }],
        ['wan-2.7', { resolution: '720p', duration: 6 }],
        ['kling-3.0-video', { mode: 'std', duration: 6 }],
        ['veo-3.1', { mode: 'veo3_fast', resolution: '720p', duration: 8 }],
      ] as const) {
        expect(fieldErrorsFor(endOnly(modelId, settings)).startFrame, modelId).toMatch(/start frame/);
      }
      // minimax-h3/image-to-video: "Either first_frame_url or last_frame_url must be provided".
      expect(() => quoteGenerationModel(endOnly('minimax-h3', { resolution: '768P', duration: 6 }))).not.toThrow();
    });

    it('puts the end-frame rule on exactly the models that declare an end frame, MiniMax excepted', () => {
      for (const model of catalog.models.filter((entry) => entry.kind === 'video')) {
        const hasRule = rulesFor(model.id).some((rule) => (
          rule.type === 'min-slot-count' && rule.slotKey === 'startFrame'
        ));
        expect(hasRule, model.id).toBe(model.inputs.endFrame && model.id !== 'minimax-h3');
      }
    });

    it('caps combined reference audio at fifteen seconds when a client reports durations', () => {
      const audio = (modelId: string, durationsSeconds: number[] | undefined): GenerationModelQuoteInput => ({
        kind: 'video',
        modelId,
        settings: { resolution: modelId === 'minimax-h3' ? '768P' : '720p', duration: 5, aspectRatio: '16:9', referenceMode: 'elements' },
        inputCounts: { images: 1, audios: 2 },
        inputMetadata: {
          slots: {
            imageReferences: { count: 1 },
            audioReferences: { count: 2, ...(durationsSeconds ? { durationsSeconds } : {}) },
          },
        },
      });
      for (const modelId of ['seedance-2', 'seedance-2-fast', 'seedance-2-mini', 'minimax-h3']) {
        expect(Object.values(fieldErrorsFor(audio(modelId, [8, 8]))).join(' '), modelId).toMatch(/audio may be at most 15 seconds/);
        expect(() => quoteGenerationModel(audio(modelId, [7, 7])), modelId).not.toThrow();
        // Advisory for a client that cannot measure audio (mobile): nothing to sum, no error.
        expect(() => quoteGenerationModel(audio(modelId, undefined)), modelId).not.toThrow();
      }
      // Seedance 2.5 states a per-file range only, so it carries no audio total.
      expect(rulesFor('seedance-2-5').some((rule) => (
        rule.type === 'combined-duration' && (rule.slotKeys as string[]).includes('audioReferences')
      ))).toBe(false);
    });

    it('keeps Kling 2.6 image-oriented motion to ten seconds', () => {
      const motion = (characterOrientation: string, duration: number): GenerationModelQuoteInput => ({
        kind: 'motion',
        modelId: 'kling-2.6',
        settings: { resolution: '720p', characterOrientation, duration },
        inputCounts: { images: 1, videos: 1 },
      });
      expect(fieldErrorsFor(motion('image', 20)).duration).toMatch(/10 seconds/);
      expect(() => quoteGenerationModel(motion('image', 10))).not.toThrow();
      expect(() => quoteGenerationModel(motion('video', 20))).not.toThrow();
      // Kling 3.0 motion states no orientation limit.
      expect(() => quoteGenerationModel({ ...motion('image', 20), modelId: 'kling-3.0' })).not.toThrow();
    });
  });
});
