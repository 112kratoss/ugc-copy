import { describe, expect, it } from 'vitest';

import { getCreationAvailability, isCreationLibraryMember, selectCreationLibraryItems } from '../lib/creation-library';
import { generationToProfileMediaCard } from '../lib/profile-view-model';
import type { GenerationListItem } from '../lib/types';

function generation(id: string, overrides: Partial<GenerationListItem> = {}): GenerationListItem {
  return {
    id,
    output_url: `https://cdn.example.com/${id}.png`,
    status: 'succeeded',
    created_at: '2026-09-02T10:00:00.000Z',
    model: 'nano-banana-2',
    category: 'image',
    title: id,
    prompt: 'A prompt.',
    ...overrides,
  };
}

describe('creation library', () => {
  it.each([
    ['available', generation('ready'), true],
    ['source-unavailable', generation('gone', { output_url: null, source_unavailable_at: '2026-09-08T06:15:00.000Z' }), true],
    ['no-output', generation('empty', { output_url: null }), false],
    ['rendering', generation('processing', { status: 'processing', output_url: null }), false],
    ['rendering', generation('waiting', { status: 'waiting', output_url: null }), false],
    ['rendering', generation('pending', { status: 'pending', output_url: null }), false],
    ['failed', generation('failed', { status: 'failed', output_url: null }), false],
  ] as const)('treats a %s creation the same way in the grid and the viewers', (availability, item, member) => {
    expect(getCreationAvailability(item)).toBe(availability);
    expect(isCreationLibraryMember(item)).toBe(member);
    // The grid decides tiles with the rule the feed and reel filter by.
    expect(generationToProfileMediaCard(item).isGridReady).toBe(member);
  });

  it('keeps archived creations out, whatever else is true of them', () => {
    const archived = generation('archived', { archived_at: '2026-09-10T00:00:00.000Z' });

    expect(getCreationAvailability(archived)).toBe('available');
    expect(isCreationLibraryMember(archived)).toBe(false);
    expect(generationToProfileMediaCard(archived).isGridReady).toBe(false);
  });

  it('counts a finished text creation as available without a file', () => {
    expect(getCreationAvailability(generation('text', { category: 'text', output_url: null }))).toBe('available');
  });

  it('keeps the one item a route named, in place, whatever its state', () => {
    const items = [
      generation('ready'),
      generation('failed', { status: 'failed', output_url: null }),
      generation('archived', { archived_at: '2026-09-10T00:00:00.000Z' }),
    ];

    expect(selectCreationLibraryItems(items).map((item) => item.id)).toEqual(['ready']);
    expect(selectCreationLibraryItems(items, 'failed').map((item) => item.id)).toEqual(['ready', 'failed']);
    expect(selectCreationLibraryItems(items, 'archived').map((item) => item.id)).toEqual(['ready', 'archived']);
    expect(selectCreationLibraryItems(items, '').map((item) => item.id)).toEqual(['ready']);
  });
});
