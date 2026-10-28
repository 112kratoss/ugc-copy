import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildGenerationModelCatalog } from '@/lib/generation-model-catalog';
import {
  buildCodeGenerationModelOperations,
  calculateGenerationModelRuntimeCost,
  type GenerationModelRuntimeInputs,
} from '@/lib/generation-model-runtime';

// The welcome_credits_v1 grant a new account receives
// (supabase/migrations/20260713142640_onboarding_and_welcome_credits_foundation.sql).
const WELCOME_CREDITS = 25;

// The guided first video's starters, in order (ugc-mobile/lib/guided-creation-starter.ts). The root suite
// cannot import a mobile file on CI, so each starter's line is matched in that file's text instead.
const STARTERS = [
  {
    // Kie's 3.8 credits a second at 480p without video (kie.ai/pricing, 2026-10-20): 5 s is 19.
    line: "{ modelId: 'seedance-2-mini', settings: { resolution: '480p', duration: 5, sound: false } }",
    modelId: 'seedance-2-mini',
    settings: { resolution: '480p', duration: 5, sound: false },
    credits: 19,
  },
];

const noInputs: GenerationModelRuntimeInputs = {
  counts: { images: 0, videos: 0, audios: 0, preparedAudios: 0, characters: 0 },
  slotCounts: {},
  slotDurationsSeconds: {},
  referenceVideoDurationsSeconds: [],
};

describe('guided first video starters', () => {
  const source = readFileSync(path.join(process.cwd(), 'ugc-mobile/lib/guided-creation-starter.ts'), 'utf8');
  const operations = buildCodeGenerationModelOperations();

  it.each(STARTERS)('starts $modelId within the welcome credits at the code catalog price', ({ line, modelId, settings, credits }) => {
    expect(source).toContain(line);
    const config = operations.find((entry) => entry.modelId === modelId);
    expect(config).toBeDefined();

    const cost = calculateGenerationModelRuntimeCost(config!, settings, noInputs);
    expect(cost).toBe(credits);
    expect(cost).toBeLessThanOrEqual(WELCOME_CREDITS);
  });

  it('lists exactly these starters, in this order', () => {
    const lines = source.split('\n').filter((text) => text.includes('{ modelId: '));
    expect(lines.map((text) => text.trim().replace(/,$/, ''))).toEqual(STARTERS.map((starter) => starter.line));
  });
});

describe('the default video', () => {
  it('opens within the welcome credits at the code catalog price', () => {
    // Every creator with no draft opens on it (owner, 2026-10-28: Seedance 2 Mini at 480p for 5 s, 19).
    const catalog = buildGenerationModelCatalog({ platform: 'mobile', schemaVersion: 2 });
    const model = catalog.models.find((candidate) => candidate.id === catalog.defaults.video)!;
    const settings = Object.fromEntries(model.controls.map((control) => [control.key, control.defaultValue]));
    const config = buildCodeGenerationModelOperations().find((entry) => entry.modelId === model.id)!;

    const cost = calculateGenerationModelRuntimeCost(config, settings, noInputs);
    expect({ modelId: model.id, cost }).toEqual({ modelId: 'seedance-2-mini', cost: 19 });
    expect(cost).toBeLessThanOrEqual(WELCOME_CREDITS);
  });
});
