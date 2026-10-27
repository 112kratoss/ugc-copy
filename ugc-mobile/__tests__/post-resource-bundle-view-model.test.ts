import { describe, expect, it } from 'vitest';

import {
  formatLockedBundleFacts,
  formatPostResourceBundleCountSummary,
  formatUnlockCountLabel,
  getResourceGroupSubtitle,
  parseGenerationSetupNotes,
  resourceKindLabel,
  shouldShowResourceItemTitle,
} from '@/lib/post-resource-bundle-view-model';
import type { PostResourceBundleLockedPreview } from '@/lib/types';
import { formatUnlockDate } from '@/lib/unlock-library-view-model';

describe('parseGenerationSetupNotes', () => {
  it('reads the publish flow\'s saved setup as settings', () => {
    const parsed = parseGenerationSetupNotes([
      'Saved generation setup',
      'Model: Nano Banana 2.0',
      'Aspect ratio: 9:16',
      'Resolution: 1K',
      'Inputs: 1 saved reference',
    ].join('\n'));

    expect(parsed).toEqual({
      title: 'Generation setup',
      entries: [
        { key: 'Model', value: 'Nano Banana 2.0' },
        { key: 'Aspect ratio', value: '9:16' },
        { key: 'Resolution', value: '1K' },
        { key: 'Inputs', value: '1 saved reference' },
      ],
    });
  });

  it('tolerates Windows line endings and blank lines', () => {
    const parsed = parseGenerationSetupNotes('Saved generation setup\r\n\r\nModel: Veo 3\r\nDuration: 8s\r\n');

    expect(parsed?.entries).toEqual([
      { key: 'Model', value: 'Veo 3' },
      { key: 'Duration', value: '8s' },
    ]);
  });

  it('leaves hand-written notes alone', () => {
    expect(parseGenerationSetupNotes('Start with the hook: make it short.\nThen pay it off.')).toBeNull();
    expect(parseGenerationSetupNotes('Saved generation setup\nJust a sentence without a key.')).toBeNull();
    expect(parseGenerationSetupNotes('Saved generation setup')).toBeNull();
    expect(parseGenerationSetupNotes('')).toBeNull();
    expect(parseGenerationSetupNotes(null)).toBeNull();
  });

  it('rejects a setup whose lines are only half there', () => {
    expect(parseGenerationSetupNotes('Saved generation setup\nModel: ')).toBeNull();
    expect(parseGenerationSetupNotes('Saved generation setup\n: Nano Banana')).toBeNull();
  });
});

describe('getResourceGroupSubtitle', () => {
  it('says nothing when the title already names the type and there is one item', () => {
    expect(getResourceGroupSubtitle({ title: 'Prompt or script', resourceType: 'prompt', itemCount: 1 })).toBe('');
  });

  it('adds the type when the creator named the group', () => {
    expect(getResourceGroupSubtitle({ title: 'Hero prompt', resourceType: 'prompt', itemCount: 1 })).toBe('Prompt or script');
  });

  it('counts only past one', () => {
    expect(getResourceGroupSubtitle({ title: 'Source assets', resourceType: 'source_file', itemCount: 3 })).toBe('3 items');
    expect(getResourceGroupSubtitle({ title: 'Campaign kit', resourceType: 'source_file', itemCount: 3 })).toBe('Source assets · 3 items');
  });
});

describe('shouldShowResourceItemTitle', () => {
  const promptGroup = { title: 'Prompt or script', resourceType: 'prompt' as const, itemCount: 1 };

  it('hides a lone generic title under the group it repeats', () => {
    expect(shouldShowResourceItemTitle(promptGroup, { title: 'Prompt', type: 'prompt' })).toBe(false);
    expect(shouldShowResourceItemTitle({ ...promptGroup, title: 'Guide or notes', resourceType: 'note' }, { title: 'Notes', type: 'note' })).toBe(false);
    expect(shouldShowResourceItemTitle(promptGroup, { title: 'Prompt or script', type: 'prompt' })).toBe(false);
  });

  it('keeps a title that carries its own meaning', () => {
    expect(shouldShowResourceItemTitle(promptGroup, { title: 'Negative prompt', type: 'prompt' })).toBe(true);
    expect(shouldShowResourceItemTitle({ ...promptGroup, title: 'Hero prompt' }, { title: 'Prompt', type: 'prompt' })).toBe(true);
  });

  it('keeps every title once a group lists more than one item', () => {
    expect(shouldShowResourceItemTitle({ ...promptGroup, itemCount: 2 }, { title: 'Prompt', type: 'prompt' })).toBe(true);
  });
});

describe('resourceKindLabel', () => {
  it("names each kind in the web's words, and drops one this build does not know", () => {
    expect(['prompt', 'workflow', 'files', 'notes', 'remix'].map(resourceKindLabel))
      .toEqual(['Prompt', 'Workflow', 'Files', 'Notes', 'Remix']);
    expect(resourceKindLabel('hologram')).toBe('');
  });
});

describe('formatPostResourceBundleCountSummary', () => {
  // Recipe audit B-F16: "sections" are the composer's cards, not something a
  // buyer gets, and "source file" and "settings note" are composer words. The
  // web's `formatPostResourceBundleCountSummary` says the same since 2026-10-27.
  // The locked preview as the server sends it, sections counted and all.
  const preview = (sectionCount: number, itemCounts: PostResourceBundleLockedPreview['itemCounts']): PostResourceBundleLockedPreview => (
    { sectionCount, itemCounts }
  );

  it('counts what a buyer gets in plain words, in the web\'s order, without sections', () => {
    expect(formatPostResourceBundleCountSummary(preview(3, { settings: 1, reference_audio: 2, prompt: 1, reference_image: 3 })))
      .toBe('1 prompt, 3 reference images, 2 reference audio files, settings');
    expect(formatPostResourceBundleCountSummary(preview(4, { prompt: 1, source_file: 2, settings: 2, external_link: 1 })))
      .toBe('1 prompt, 2 files, settings, 1 link');
    expect(formatPostResourceBundleCountSummary({ itemCounts: { source_file: 1 } })).toBe('1 file');
  });

  it('says nothing for a recipe with nothing counted', () => {
    expect(formatPostResourceBundleCountSummary(preview(2, {}))).toBe('');
    expect(formatPostResourceBundleCountSummary(null)).toBe('');
  });
});

describe('formatLockedBundleFacts', () => {
  it('reads sold for a paid recipe and opened for a free one', () => {
    expect(formatUnlockCountLabel('paid', 12)).toBe('12 sold');
    expect(formatUnlockCountLabel('free', 1)).toBe('1 opened');
  });

  it('joins the record and the last update into one line', () => {
    const updatedAt = '2026-10-03T10:00:00.000Z';
    expect(formatLockedBundleFacts({ accessMode: 'paid', salesCount: 12, updatedAt }))
      .toBe(`12 sold · Updated ${formatUnlockDate(updatedAt)}`);
    expect(formatLockedBundleFacts({ accessMode: 'free', salesCount: 0, freeUnlockCount: 0, updatedAt: null })).toBe('0 opened');
    expect(formatLockedBundleFacts({ accessMode: 'paid', salesCount: undefined, updatedAt: 'not-a-date' })).toBe('');
  });

  // Decision 6 (2026-10-17): a free unlock is not a sale. A free recipe's
  // "opened" counts its free unlocks and a paid one's "sold" its paid unlocks,
  // whatever the other count holds: a recipe can change price.
  it('counts free unlocks on a free recipe and paid unlocks on a paid one', () => {
    expect(formatLockedBundleFacts({ accessMode: 'free', salesCount: 2, freeUnlockCount: 20, updatedAt: null })).toBe('20 opened');
    expect(formatLockedBundleFacts({ accessMode: 'paid', salesCount: 2, freeUnlockCount: 20, updatedAt: null })).toBe('2 sold');
    // A record without the free count says nothing, never its sales as opens.
    expect(formatLockedBundleFacts({ accessMode: 'free', salesCount: 3, updatedAt: null })).toBe('');
  });
});
