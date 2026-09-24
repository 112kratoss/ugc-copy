import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { AI_MODEL_MAKER_BY_MODEL_ID, AI_MODEL_MAKERS, PROMPT_ENHANCER_MAKER } from '@/lib/ai-data-recipients';
import { IMAGE_MODELS, MOTION_MODELS, SOUND_EFFECT_MODELS, VIDEO_MODELS, VOICEOVER_MODELS } from '@/lib/models';

/**
 * App Review rejected iOS 0.1.6 (55) under guidelines 5.1.1(i) and 5.1.2(i):
 * the app sent prompts and media to third-party AI services without naming
 * them and asking first. The app now asks before sending, and the privacy
 * policy lists who receives what. These cases keep both lists complete as
 * models are added.
 */

const makerOf = AI_MODEL_MAKER_BY_MODEL_ID as Record<string, string>;
const policyMakers = new Set<string>(AI_MODEL_MAKERS.map(({ maker }) => maker));

// The mobile app names the makers of the models it can send to. It offers no
// voice or sound models, so their maker is left out there.
const mobileModelIds = [...Object.keys(IMAGE_MODELS), ...Object.keys(VIDEO_MODELS), ...Object.keys(MOTION_MODELS)];
const allModelIds = [...mobileModelIds, ...Object.keys(VOICEOVER_MODELS), ...Object.keys(SOUND_EFFECT_MODELS)];

function mobileMakers() {
  const source = readFileSync('ugc-mobile/lib/ai-data-consent.ts', 'utf8');
  const list = source.match(/export const AI_MODEL_MAKERS = \[([\s\S]*?)\] as const;/)?.[1];
  if (!list) throw new Error('AI_MODEL_MAKERS not found in ugc-mobile/lib/ai-data-consent.ts');
  return new Set([...list.matchAll(/'([^']+)'/g)].map((match) => match[1]));
}

describe('who receives a person’s prompts and media', () => {
  it.each(allModelIds)('%s names its maker', (id) => {
    expect(makerOf[id]).toBeTruthy();
  });

  it('names no model that the catalog no longer has', () => {
    expect(Object.keys(makerOf).sort()).toEqual([...allModelIds].sort());
  });

  it('lists every maker in the privacy policy, once', () => {
    for (const maker of Object.values(makerOf)) expect(policyMakers).toContain(maker);
    expect(policyMakers).toContain(PROMPT_ENHANCER_MAKER);
    expect(policyMakers.size).toBe(AI_MODEL_MAKERS.length);
  });

  it('names exactly the makers the mobile app can send to, in the question it asks first', () => {
    const expected = new Set([...mobileModelIds.map((id) => makerOf[id]), PROMPT_ENHANCER_MAKER]);
    expect([...mobileMakers()].sort()).toEqual([...expected].sort());
  });

  it('says the enhancer is Gemini, as the app does', async () => {
    const { PROMPT_ENHANCER_PROVIDER_MODEL } = await import('@/lib/prompt-enhancer');
    expect(PROMPT_ENHANCER_PROVIDER_MODEL).toMatch(/^gemini/);
    expect(PROMPT_ENHANCER_MAKER).toBe('Google');
  });

  it('gives the policy an AI section the app can link to, naming Kie.ai and reading the maker list', () => {
    const page = readFileSync('src/app/privacy/page.tsx', 'utf8');
    expect(page).toContain('id="ai-processing"');
    expect(page).toContain('Kie.ai');
    expect(page).toContain('AI_MODEL_MAKERS.map');
    expect(readFileSync('ugc-mobile/app/ai-data-sharing.tsx', 'utf8')).toContain('/privacy#ai-processing');
  });
});
