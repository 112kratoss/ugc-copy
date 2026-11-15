import { describe, expect, it } from 'vitest';

import { searchTypeaheadEntityRoute } from '@/components/search/search-typeahead-rows';
import type { SearchEntity } from '../../ugc-mobile/lib/public-search-policy/public-search-policy';

// Where a model's or tool's typeahead row leads on the web (2026-11-15). The words
// both clients draw (search-ui-words.ts), and the typeahead's catalog and platform
// options (a row the web cannot open left out, a name not offered twice), are the
// shared rules', held by ugc-mobile/__tests__/search-ui-shared-rules.test.ts.

const seedance: SearchEntity = {
  kind: 'model', key: 'seedance-1.5-pro', label: 'Seedance 1.5 Pro', postCount: 0, postCountCapped: false, thumbnail: null,
  inCatalog: true, catalogModel: { id: 'seedance-1.5-pro', kind: 'video', web: true, mobile: true }, query: null,
};

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

  it('opens Top, narrowed to nothing, for a text Posts does not search yet (review of #828, N1)', () => {
    const kling: SearchEntity = {
      kind: 'model', key: 'kling-2.6', label: 'Kling 2.6', postCount: 412, postCountCapped: false, inCatalog: false, catalogModel: null, query: null,
    };
    // A row kept on show from "kli", pressed at "kl": Posts would be idle under a filter it does not draw.
    expect(searchTypeaheadEntityRoute(kling, 'kl')).toEqual({ type: 'top', query: 'kl' });
    // Counted as the server counts: without a leading "@", an emoji as one.
    expect(searchTypeaheadEntityRoute(kling, '@kl')).toEqual({ type: 'top', query: '@kl' });
    expect(searchTypeaheadEntityRoute(kling, 'kli')).toEqual({ type: 'posts', query: 'kli', madeWith: 'model:kling-2.6' });
    // A row's own search is held to the same rule.
    expect(searchTypeaheadEntityRoute({ ...kling, query: 'kl' }, 'k')).toEqual({ type: 'top', query: 'kl' });
  });
});
