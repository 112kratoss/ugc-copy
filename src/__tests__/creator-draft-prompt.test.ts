import { describe, expect, it } from 'vitest';

import { isAnotherDraftOwner, keepsPromptOverSavedDraft, promptHoldsTyping } from '@/lib/creator-draft-prompt';

const MOTION_OPENING = "No distortion, the character's movements are consistent with the video.";

describe('the prompt box against a saved draft read back (owner, 2026-11-01)', () => {
  it('counts as typed only words that are not what the page opened on', () => {
    expect(promptHoldsTyping('A corgi astronaut', '')).toBe(true);
    expect(promptHoldsTyping('', '')).toBe(false);
    // An emptied box has nothing to lose.
    expect(promptHoldsTyping('   ', MOTION_OPENING)).toBe(false);
    expect(promptHoldsTyping(MOTION_OPENING, MOTION_OPENING)).toBe(false);
    expect(promptHoldsTyping('From the post', 'From the post')).toBe(false);
    expect(promptHoldsTyping('From the post, edited', 'From the post')).toBe(true);
  });

  it('keeps words typed on the page over the saved prompt, and fills a box with none', () => {
    const read = { openingPrompt: '', savedPrompt: 'An older prompt', carried: false };
    expect(keepsPromptOverSavedDraft({ ...read, boxPrompt: 'A newer prompt' })).toBe(true);
    expect(keepsPromptOverSavedDraft({ ...read, boxPrompt: '' })).toBe(false);
    expect(keepsPromptOverSavedDraft({ ...read, boxPrompt: ' \n' })).toBe(false);
    expect(keepsPromptOverSavedDraft({ ...read, openingPrompt: MOTION_OPENING, boxPrompt: MOTION_OPENING })).toBe(false);
  });

  it('lets the prompt carried from sign-up win over words typed on the way back, where it holds words', () => {
    const typedOnReturn = { boxPrompt: 'A corgi astr', openingPrompt: '', carried: true };
    expect(keepsPromptOverSavedDraft({ ...typedOnReturn, savedPrompt: 'A corgi astronaut on the moon, cinematic' })).toBe(false);
    // A carried draft without words never empties the box.
    expect(keepsPromptOverSavedDraft({ ...typedOnReturn, savedPrompt: '' })).toBe(true);
    expect(keepsPromptOverSavedDraft({ ...typedOnReturn, savedPrompt: undefined })).toBe(true);
    // The same draft read back on any other occasion is the creator's own save.
    expect(keepsPromptOverSavedDraft({ ...typedOnReturn, carried: false, savedPrompt: 'A corgi astronaut on the moon, cinematic' })).toBe(true);
  });

  it('calls a read for any other owner a change, and the same owner read again none', () => {
    expect(isAnotherDraftOwner(null, 'user-1')).toBe(false);
    expect(isAnotherDraftOwner('user-1', 'user-1')).toBe(false);
    expect(isAnotherDraftOwner('user-1', 'user-2')).toBe(true);
    // A visitor's words stay behind when an account signs in without the sign-up sheet, and an
    // account's when it signs out.
    expect(isAnotherDraftOwner('visitor', 'user-1')).toBe(true);
    expect(isAnotherDraftOwner('user-1', 'visitor')).toBe(true);
  });
});
