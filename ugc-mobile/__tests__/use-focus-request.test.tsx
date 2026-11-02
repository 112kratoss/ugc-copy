import React, { useRef } from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { useFocusRequest } from '../lib/use-focus-request';

// A composer focuses its prompt for each request the screen makes while it is mounted, and for none
// made before it mounted: a blocked prompt's request was for another tool's field (2026-11-02).
describe('useFocusRequest', () => {
  function Composer({ request, focus }: { request: number; focus: () => void }) {
    const fieldRef = useRef({ focus });
    useFocusRequest(request, fieldRef);
    return null;
  }

  it('focuses the field for a request made while it is mounted, once', () => {
    const focus = vi.fn();
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => { tree = renderer.create(<Composer request={2} focus={focus} />); });
    expect(focus).not.toHaveBeenCalled();

    renderer.act(() => { tree.update(<Composer request={3} focus={focus} />); });
    expect(focus).toHaveBeenCalledTimes(1);
    renderer.act(() => { tree.update(<Composer request={3} focus={focus} />); });
    expect(focus).toHaveBeenCalledTimes(1);

    // Another tool's composer mounted after the request leaves its field alone.
    renderer.act(() => { tree.unmount(); });
    renderer.act(() => { tree = renderer.create(<Composer request={3} focus={focus} />); });
    expect(focus).toHaveBeenCalledTimes(1);
  });
});
