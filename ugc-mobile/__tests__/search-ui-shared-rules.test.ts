import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { SearchEntity } from '../lib/public-search-policy/public-search-policy';
import {
  SEARCH_TYPEAHEAD_MIN_CATALOG_ENTITY_QUERY_LENGTH,
  searchTypeaheadDrawn,
  searchTypeaheadSections,
  type SearchSuggestResponse,
  type SearchTypeaheadSection,
} from '../lib/public-search-policy/search-typeahead';
import {
  SEARCH_FOLLOWING_LABEL,
  SEARCH_FOLLOW_FAILED,
  SEARCH_FOLLOW_LABEL,
  SEARCH_RELATED_SEARCHES_HEADING,
  searchCatalogModelActionLabel,
  searchCatalogModelLine,
  searchFollowButtonLabel,
} from '../lib/public-search-policy/search-ui-words';

// The search screens' additions of 2026-11-15 that both clients draw by: the
// typeahead asked with the catalog (`catalog=1`), and the new words. The web
// reads the same module by relative import once the two branches are merged.

const seedance: SearchEntity = {
  kind: 'model',
  key: 'seedance-2',
  label: 'Seedance 2',
  postCount: 0,
  postCountCapped: false,
  thumbnail: null,
  inCatalog: true,
  catalogModel: { id: 'seedance-2', kind: 'video', web: true, mobile: true },
  query: null,
};
// A catalog model nobody has posted with that only the web offers.
const webOnly: SearchEntity = {
  ...seedance,
  key: 'sora-2',
  label: 'Sora 2',
  catalogModel: { id: 'sora-2', kind: 'video', web: true, mobile: false },
};
const nano: SearchEntity = {
  kind: 'model',
  key: 'nano-banana-pro',
  label: 'Nano Banana Pro',
  postCount: 14,
  postCountCapped: false,
  thumbnail: null,
  inCatalog: true,
  catalogModel: { id: 'nano-banana-pro', kind: 'image', web: true, mobile: true },
  query: 'nano banana pro',
};

function answer(over: Partial<SearchSuggestResponse> = {}): SearchSuggestResponse {
  return { query: 'se', normalizedQuery: 'se', creators: [], entities: [], completions: [], ...over };
}

function keys(sections: readonly SearchTypeaheadSection[]) {
  return sections.flatMap((section) => section.rows.map((row) => row.key));
}

describe('the typeahead asked with the catalog', () => {
  it('draws models and tools from two characters, as the server offers them', () => {
    expect(SEARCH_TYPEAHEAD_MIN_CATALOG_ENTITY_QUERY_LENGTH).toBe(2);
    const offered = answer({ entities: [seedance] });
    // An answer asked without the catalog: three characters, as before.
    expect(keys(searchTypeaheadSections(offered, 'se'))).toEqual([]);
    expect(keys(searchTypeaheadSections(offered, 'se', { catalog: true }))).toEqual(['entity:model:seedance-2']);
    expect(keys(searchTypeaheadSections(offered, 's', { catalog: true }))).toEqual([]);
    // A handle is a look for a creator, catalog or not.
    expect(keys(searchTypeaheadSections(offered, '@se', { catalog: true }))).toEqual([]);
  });

  it('leaves out a row with nothing to open on the client it is drawn on', () => {
    const offered = answer({ entities: [webOnly, seedance, { ...webOnly, key: 'veo-3', label: 'Veo 3', postCount: 3 }] });
    expect(keys(searchTypeaheadSections(offered, 'se', { catalog: true, platform: 'mobile' })))
      .toEqual(['entity:model:seedance-2', 'entity:model:veo-3']);
    expect(keys(searchTypeaheadSections(offered, 'se', { catalog: true, platform: 'web' })))
      .toEqual(['entity:model:sora-2', 'entity:model:seedance-2', 'entity:model:veo-3']);
    // A caller that names no client is drawn as before.
    expect(keys(searchTypeaheadSections(offered, 'se', { catalog: true })))
      .toEqual(['entity:model:sora-2', 'entity:model:seedance-2', 'entity:model:veo-3']);
  });

  it('offers a name once, as its model or tool row, not again as a suggested search', () => {
    const offered = answer({
      query: 'nano',
      entities: [nano, { ...webOnly, key: 'nano-x', label: 'Nano X' }],
      completions: [{ text: 'nano banana pro' }, { text: 'Nano X' }, { text: 'nano banana pro portrait' }],
    });
    expect(keys(searchTypeaheadSections(offered, 'nano', { catalog: true, platform: 'mobile' }))).toEqual([
      'entity:model:nano-banana-pro',
      // A row left out (nothing to open in the app) does not take its name from the suggestions.
      'completion:nano x',
      'completion:nano banana pro portrait',
    ]);
    // The person's own recent search of the name stays.
    expect(keys(searchTypeaheadSections(offered, 'nano', { catalog: true, platform: 'mobile', recents: ['Nano Banana Pro'] }))).toEqual([
      'recent:nano banana pro',
      'entity:model:nano-banana-pro',
      'completion:nano x',
      'completion:nano banana pro portrait',
    ]);
    // Without a client named, both stay, as before.
    expect(keys(searchTypeaheadSections(offered, 'nano', { catalog: true }))).toContain('completion:nano banana pro');
  });

  it('reads a row\'s own search as its name too', () => {
    // "sdxl" offers Stability AI, searched for "sdxl".
    const stability: SearchEntity = { ...nano, kind: 'tool', key: 'stability-ai', label: 'Stability AI', inCatalog: false, catalogModel: null, query: 'sdxl' };
    const offered = answer({ query: 'sdxl', entities: [stability], completions: [{ text: 'sdxl' }, { text: 'SDXL turbo' }] });
    expect(keys(searchTypeaheadSections(offered, 'sdx', { catalog: true, platform: 'mobile' })))
      .toEqual(['entity:tool:stability-ai', 'completion:sdxl turbo']);
  });

  it('holds a list kept on show for the next letters to the same rules', () => {
    // Both still named by "see"; only one has anything to open in the app.
    const before = { query: 'se', response: answer({ entities: [{ ...webOnly, key: 'seedream-web', label: 'Seedream Web' }, seedance] }) };
    const drawn = searchTypeaheadDrawn(before, 'see', { catalog: true, platform: 'mobile' });
    expect(drawn.stale).toBe(true);
    expect(keys(drawn.sections)).toEqual(['entity:model:seedance-2']);
  });
});

describe('the words of the search screens\' new parts', () => {
  it('are the ones the shared notes chose, byte for byte', () => {
    expect(SEARCH_RELATED_SEARCHES_HEADING).toBe('Related searches');
    expect(SEARCH_FOLLOW_LABEL).toBe('Follow');
    expect(SEARCH_FOLLOWING_LABEL).toBe('Following');
    expect(SEARCH_FOLLOW_FAILED).toBe('Could not update follow. Your previous state was restored.');
    expect(searchCatalogModelLine('video')).toBe('Video model · Generate with it');
    expect(searchCatalogModelLine('image')).toBe('Image model · Generate with it');
    expect(searchCatalogModelLine('motion')).toBe('Motion model · Generate with it');
    expect(searchCatalogModelActionLabel('Seedance 1.5 Pro', 'video'))
      .toBe('Seedance 1.5 Pro, video model, no posts yet. Open the video creator with it');
  });

  it('name a Follow button by the creator, by handle where the name is only the handle', () => {
    expect(searchFollowButtonLabel({ displayName: 'Luna Studio', username: 'luna' }, false)).toBe('Follow Luna Studio');
    expect(searchFollowButtonLabel({ displayName: 'Luna Studio', username: 'luna' }, true)).toBe('Following Luna Studio');
    expect(searchFollowButtonLabel({ displayName: 'Luna', username: 'luna' }, false)).toBe('Follow @luna');
    expect(searchFollowButtonLabel({ displayName: '@Luna ', username: 'luna' }, true)).toBe('Following @luna');
  });

  it('say a refused follow as the creator page does: one sentence for one thing', () => {
    const profile = readFileSync(join(__dirname, '../components/creator-profile-screen.tsx'), 'utf8');
    expect(profile).toContain(`'${SEARCH_FOLLOW_FAILED}'`);
  });

  it('import nothing but the shared search rules', () => {
    const source = readFileSync(join(__dirname, '../lib/public-search-policy/search-ui-words.ts'), 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
    expect(imports.every((path) => path.startsWith('./'))).toBe(true);
  });
});
