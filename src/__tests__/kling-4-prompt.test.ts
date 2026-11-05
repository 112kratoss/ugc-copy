import { describe, expect, it } from 'vitest';

import { kling4ProviderPrompt, kling4UndeclaredMentionRefusal } from '@/lib/kling-4-prompt';

/**
 * Kling 4.0 rejects a request whose prompt has an @ naming no material it declares
 * (docs/model-api-references/kling-4-0.md): pictures are `@image_N` by place, keyframes
 * `@first_frame` and `@last_frame`.
 */
describe('the prompt Kling 4.0 is sent', () => {
  const tenPictures = { kind: 'references' as const, pictureHandles: ['@chef', null, null, null, null, null, null, null, null, '@dish'] };

  it('names each picture by its place, and leaves a picture with no handle unnamed', () => {
    expect(kling4ProviderPrompt('@chef hands @dish over, then @chef bows.', tenPictures)).toEqual({
      prompt: '@image_1 hands @image_10 over, then @image_1 bows.',
      undeclaredMentions: [],
    });
  });

  it('reads @image_10 as the tenth picture, not the first one run on', () => {
    expect(kling4ProviderPrompt('@image_10 and @image_1, then @image_1.', tenPictures).undeclaredMentions).toEqual([]);
    expect(kling4ProviderPrompt('@image_11 waves.', tenPictures).undeclaredMentions).toEqual(['@image_11']);
    expect(kling4ProviderPrompt('@image_1x waves.', tenPictures).undeclaredMentions).toEqual(['@image_1x']);
  });

  it('declares only the frames a frames run sends, and nothing for text', () => {
    const startOnly = { kind: 'frames' as const, startFrame: true, endFrame: false };
    expect(kling4ProviderPrompt('From @first_frame the camera rises.', startOnly).undeclaredMentions).toEqual([]);
    expect(kling4ProviderPrompt('Toward @last_frame.', startOnly).undeclaredMentions).toEqual(['@last_frame']);
    expect(kling4ProviderPrompt('@image_1 waves.', { kind: 'text' }).undeclaredMentions).toEqual(['@image_1']);
  });

  it('reports every other @ once, as written, spelled as Kie spells its names', () => {
    expect(kling4ProviderPrompt('Meet @Chef @ noon; mail chef@example.com, @Chef again.', { kind: 'text' }).undeclaredMentions)
      .toEqual(['@Chef', '@', '@example.com']);
    expect(kling4ProviderPrompt('@Image_1 waves.', tenPictures).undeclaredMentions).toEqual(['@Image_1']);
    expect(kling4ProviderPrompt('A plain prompt with no mentions.', { kind: 'text' })).toEqual({
      prompt: 'A plain prompt with no mentions.',
      undeclaredMentions: [],
    });
  });

  it('says how to fix a refused prompt', () => {
    expect(kling4UndeclaredMentionRefusal(['@Chef', '@'])).toBe(
      'Kling 4.0 reads every @ as a mention of an attached picture. Mention a reference by its @name, or take the @ out of @Chef, "@".',
    );
  });
});
