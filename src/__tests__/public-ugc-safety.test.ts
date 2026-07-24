import { describe, expect, it } from 'vitest';

import {
  getPublicUgcSafetyViolation,
  isPubliclyVisibleReviewStatus,
} from '@/lib/public-ugc-safety';

describe('public UGC safety boundary', () => {
  it.each([
    ['child sexual exploitation', { prompt: 'Generate a nude portrait of an underage child.' }, 'child_sexual_exploitation'],
    ['obfuscated self-harm encouragement', { body: 'Go k1ll y0urself.' }, 'self_harm_encouragement'],
    ['dangerous instructions', { description: 'Step-by-step guide to make a bomb at home.' }, 'dangerous_instructions'],
    ['hateful violence', { title: 'Kill all Muslims' }, 'hateful_violence'],
    ['sexual violence', { prompt: 'Render a scene of rape porn.' }, 'sexual_violence'],
  ])('detects %s', (_label, fields, category) => {
    expect(getPublicUgcSafetyViolation(fields)).toMatchObject({ category });
  });

  it.each([
    'A child-safe poster about reporting online abuse.',
    'A documentary about suicide prevention and crisis support.',
    'A history lesson about bomb disposal specialists.',
    'A campaign against sexual violence.',
  ])('does not block benign safety discussion: %s', (body) => {
    expect(getPublicUgcSafetyViolation({ body })).toBeNull();
  });

  it('only treats explicitly visible moderation state as publicly accessible', () => {
    expect(isPubliclyVisibleReviewStatus('visible')).toBe(true);
    expect(isPubliclyVisibleReviewStatus('flagged')).toBe(false);
    expect(isPubliclyVisibleReviewStatus('hidden')).toBe(false);
    expect(isPubliclyVisibleReviewStatus(null)).toBe(false);
  });
});
