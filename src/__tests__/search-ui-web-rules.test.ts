import { describe, expect, it } from 'vitest';

import {
  searchTypeaheadEntityRoute,
  withoutRepeatedEntityNames,
} from '@/components/search/search-typeahead-rows';
import {
  SEARCH_FOLLOWING_LABEL,
  SEARCH_FOLLOW_FAILED,
  SEARCH_FOLLOW_LABEL,
  SEARCH_RELATED_SEARCHES_HEADING,
  searchCatalogModelActionLabel,
  searchCatalogModelLine,
  searchFollowButtonLabel,
} from '@/components/search/search-ui-words';
import type { SearchEntity } from '../../ugc-mobile/lib/public-search-policy/public-search-policy';
import type { SearchTypeaheadSection } from '../../ugc-mobile/lib/public-search-policy/search-typeahead';

// The web's rules around the new search answers (2026-11-15): the words the app
// draws too (search-ui-wording.md in the shared notes, the app's search-ui-words.ts),
// where a model's or tool's row leads, and a name the typeahead offers twice.

const seedance: SearchEntity = {
  kind: 'model', key: 'seedance-1.5-pro', label: 'Seedance 1.5 Pro', postCount: 0, postCountCapped: false, thumbnail: null,
  inCatalog: true, catalogModel: { id: 'seedance-1.5-pro', kind: 'video', web: true, mobile: true }, query: null,
};

describe('the words of the new search screens', () => {
  it('are the app’s, byte for byte', () => {
    expect(SEARCH_RELATED_SEARCHES_HEADING).toBe('Related searches');
    expect(SEARCH_FOLLOW_LABEL).toBe('Follow');
    expect(SEARCH_FOLLOWING_LABEL).toBe('Following');
    expect(SEARCH_FOLLOW_FAILED).toBe('Could not update follow. Your previous state was restored.');
  });

  it('say what a catalog model with no posts opens, never "0 posts"', () => {
    expect(searchCatalogModelLine('video')).toBe('Video model · Generate with it');
    expect(searchCatalogModelLine('image')).toBe('Image model · Generate with it');
    expect(searchCatalogModelLine('motion')).toBe('Motion model · Generate with it');
    expect(searchCatalogModelActionLabel('Seedance 1.5 Pro', 'video'))
      .toBe('Seedance 1.5 Pro, video model, no posts yet. Open the video creator with it');
  });

  it('name the creator on a Follow button: the display name, or the handle when that is all the name is', () => {
    expect(searchFollowButtonLabel({ displayName: 'Luna Studio', username: 'luna-studio' }, false)).toBe('Follow Luna Studio');
    expect(searchFollowButtonLabel({ displayName: 'Luna Studio', username: 'luna-studio' }, true)).toBe('Following Luna Studio');
    expect(searchFollowButtonLabel({ displayName: 'wren', username: 'wren' }, false)).toBe('Follow @wren');
    expect(searchFollowButtonLabel({ displayName: '@Wren', username: 'wren' }, true)).toBe('Following @wren');
  });
});

describe('where a model’s or tool’s typeahead row leads (searchTypeaheadEntityRoute)', () => {
  it('opens the creator with a catalog model chosen when nobody has posted with it', () => {
    expect(searchTypeaheadEntityRoute(seedance, 'see')).toEqual({ type: 'creator', href: '/create-video?model=seedance-1.5-pro' });
    expect(searchTypeaheadEntityRoute({ ...seedance, catalogModel: { id: 'nano banana', kind: 'image', web: true, mobile: false } }, 'na'))
      .toEqual({ type: 'creator', href: '/create-image?model=nano%20banana' });
    expect(searchTypeaheadEntityRoute({ ...seedance, catalogModel: { id: 'kling-2.6-motion', kind: 'motion', web: true, mobile: true } }, 'kl'))
      .toEqual({ type: 'creator', href: '/create-motion?model=kling-2.6-motion' });
  });

  it('opens Posts for the row’s own query when it carries one, else for what is typed', () => {
    const stability: SearchEntity = {
      kind: 'tool', key: 'stability-ai', label: 'Stability AI', postCount: 190, postCountCapped: false,
      inCatalog: false, catalogModel: null, query: 'stability ai',
    };
    expect(searchTypeaheadEntityRoute(stability, 'sdxl')).toEqual({ type: 'posts', query: 'stability ai', madeWith: 'tool:stability-ai' });
    expect(searchTypeaheadEntityRoute({ ...stability, query: null }, '  Stab  ai ')).toEqual({ type: 'posts', query: 'Stab ai', madeWith: 'tool:stability-ai' });
    // A catalog model with posts opens its posts, as any row does.
    expect(searchTypeaheadEntityRoute({ ...seedance, postCount: 3, query: 'seedance 1.5' }, 'see'))
      .toEqual({ type: 'posts', query: 'seedance 1.5', madeWith: 'model:seedance-1.5-pro' });
  });
});

describe('a name the typeahead offers twice (withoutRepeatedEntityNames)', () => {
  const nano: SearchEntity = {
    kind: 'model', key: 'nano-banana-pro', label: 'Nano Banana Pro', postCount: 40, postCountCapped: false, query: null,
  };
  const sections: SearchTypeaheadSection[] = [
    { id: 'recents', heading: 'Recent searches', rows: [{ kind: 'completion', key: 'recent:nano banana pro', text: 'nano banana pro', recent: true }] },
    { id: 'entities', heading: 'Models and tools', rows: [{ kind: 'entity', key: 'entity:model:nano-banana-pro', entity: nano }] },
    {
      id: 'completions',
      heading: 'Suggested searches',
      rows: [
        { kind: 'completion', key: 'completion:nano banana pro', text: 'Nano  Banana Pro' },
        { kind: 'completion', key: 'completion:nano banana', text: 'nano banana' },
      ],
    },
  ];

  it('keeps the model’s row and drops the completion that is its name', () => {
    const kept = withoutRepeatedEntityNames(sections);
    expect(kept.map((section) => section.rows.map((row) => row.key))).toEqual([
      ['recent:nano banana pro'],
      ['entity:model:nano-banana-pro'],
      ['completion:nano banana'],
    ]);
  });

  it('drops a completion that is the search a row carries, and a section left with nothing', () => {
    const named = { ...nano, query: 'nano banana' };
    const kept = withoutRepeatedEntityNames([
      { id: 'entities', heading: 'Models and tools', rows: [{ kind: 'entity', key: 'entity:model:nano-banana-pro', entity: named }] },
      { id: 'completions', heading: 'Suggested searches', rows: [{ kind: 'completion', key: 'completion:nano banana', text: 'nano banana' }] },
    ]);
    expect(kept.map((section) => section.id)).toEqual(['entities']);
  });

  it('leaves a list with no model or tool as it was', () => {
    const plain = sections.filter((section) => section.id !== 'entities');
    expect(withoutRepeatedEntityNames(plain)).toBe(plain);
  });
});
