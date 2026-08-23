import { describe, expect, it } from 'vitest';

import {
  getResourceGroupSubtitle,
  parseGenerationSetupNotes,
  shouldShowResourceItemTitle,
} from '@/lib/post-resource-bundle-view-model';

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
