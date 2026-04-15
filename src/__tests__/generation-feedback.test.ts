import { describe, expect, it } from 'vitest';

import { getGenerationNotificationCopy } from '@/lib/generation-feedback';

describe('generation feedback', () => {
  it('includes completion duration in success notifications when available', () => {
    const copy = getGenerationNotificationCopy('image', 'succeeded', 38_000);

    expect(copy.title).toBe('Image ready');
    expect(copy.description).toContain('38s');
  });

  it('keeps failure notifications concise', () => {
    const copy = getGenerationNotificationCopy('video', 'failed', 38_000);

    expect(copy.title).toBe('Video failed');
    expect(copy.description).not.toContain('38s');
  });
});
