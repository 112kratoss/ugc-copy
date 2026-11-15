import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { readAddressParam, useAddressParam, writeAddressParam } from '@/lib/address-param';

// A page's own control kept in its address (Templates' input filter, Recipe sales' filter and
// order, the workflow library's order; each page's test presses its own).

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('a control kept in the address', () => {
  // Review of #815: a write Next took for a navigation of its own ended the one still loading, so a
  // template pressed and then a filter while it loaded never opened. The write keeps the entry's
  // state with Next's mark, which Next hands straight to the browser, as the search page's does.
  it("writes in place, keeping the entry's state with Next's mark", () => {
    window.history.replaceState({ __PRIVATE_NEXTJS_INTERNALS_TREE: 'tree', kept: 1 }, '', '/templates?from=home');
    const entries = window.history.length;

    writeAddressParam('input', 'image');

    expect(window.location.pathname + window.location.search).toBe('/templates?from=home&input=image');
    expect(window.history.state).toEqual({ __PRIVATE_NEXTJS_INTERNALS_TREE: 'tree', kept: 1, __NA: true });
    expect(window.history.length).toBe(entries);
  });

  it('leaves the default unsaid, and writes nothing that is already there', () => {
    window.history.replaceState({ kept: 1 }, '', '/templates?input=video');

    writeAddressParam('input', null);
    expect(window.location.search).toBe('');

    window.history.replaceState({ kept: 2 }, '', '/templates?input=video');
    writeAddressParam('input', 'video');
    expect(window.history.state).toEqual({ kept: 2 });
  });

  it('is read from the address as it changes, by a write and by Back', () => {
    window.history.replaceState(null, '', '/templates');
    const { result } = renderHook(() => useAddressParam('input'));
    expect(result.current).toBeNull();

    act(() => writeAddressParam('input', 'audio'));
    expect(result.current).toBe('audio');

    act(() => {
      window.history.replaceState(null, '', '/templates?input=image');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(result.current).toBe('image');
    expect(readAddressParam('input')).toBe('image');
  });
});
