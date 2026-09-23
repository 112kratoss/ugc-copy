import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { createFeedVideoActivationStore, useFeedVideoActivation } from '../lib/feed-video-activation';

describe('createFeedVideoActivationStore', () => {
  it('notifies only the tiles whose activation changed', () => {
    const store = createFeedVideoActivationStore();
    const seen = { a: 0, b: 0, c: 0 };
    store.subscribe('a', () => { seen.a += 1; });
    store.subscribe('b', () => { seen.b += 1; });
    store.subscribe('c', () => { seen.c += 1; });

    store.publish({ activeIds: ['a'] });
    expect(seen).toEqual({ a: 1, b: 0, c: 0 });
    store.publish({ preparedIds: ['b'] });
    expect(seen).toEqual({ a: 1, b: 1, c: 0 });
    // The same lists again change nothing, so nobody hears about them.
    store.publish({ activeIds: ['a'], preparedIds: ['b'] });
    expect(seen).toEqual({ a: 1, b: 1, c: 0 });
    // A handoff concerns the two tiles trading places; 'c' stays quiet.
    store.publish({ activeIds: ['b'], preparedIds: ['a'] });
    expect(seen).toEqual({ a: 2, b: 2, c: 0 });
    expect(store.activationOf('a')).toBe('prepared');
    expect(store.activationOf('b')).toBe('visible');
    expect(store.activationOf('c')).toBe('never');
  });

  it('lets playing win over prepared and keeps a list it was not given', () => {
    const store = createFeedVideoActivationStore();
    store.publish({ activeIds: ['a'], preparedIds: ['a', 'b'] });
    expect(store.activationOf('a')).toBe('visible');
    store.publish({ activeIds: [] });
    expect(store.activationOf('a')).toBe('prepared');
    expect(store.snapshot()).toEqual({ activeIds: [], preparedIds: ['a', 'b'] });
  });

  it('records readiness once per change and tells its listeners until they leave', () => {
    const store = createFeedVideoActivationStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribeReady(listener);
    store.setReady('a', true);
    store.setReady('a', true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith('a', true);
    expect(store.isReady('a')).toBe(true);
    store.setReady('a', false);
    expect(store.isReady('a')).toBe(false);
    unsubscribe();
    store.setReady('a', true);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('forgets a tile listener that unsubscribed', () => {
    const store = createFeedVideoActivationStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe('a', listener);
    store.publish({ activeIds: ['a'] });
    unsubscribe();
    store.publish({ activeIds: [] });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('useFeedVideoActivation', () => {
  it('re-renders a tile for its own activation only', () => {
    const store = createFeedVideoActivationStore();
    const renders: string[] = [];
    function Tile({ id }: { id: string }) {
      const activation = useFeedVideoActivation(store, id);
      renders.push(`${id}:${activation}`);
      return React.createElement('tile', { id, activation });
    }
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(React.createElement(React.Fragment, null,
        React.createElement(Tile, { id: 'a' }),
        React.createElement(Tile, { id: 'b' })));
    });
    renders.length = 0;
    renderer.act(() => { store.publish({ activeIds: ['a'] }); });
    expect(renders).toEqual(['a:visible']);
    renderer.act(() => { store.publish({ activeIds: ['b'], preparedIds: ['a'] }); });
    expect(renders).toEqual(['a:visible', 'a:prepared', 'b:visible']);
    expect(tree.root.findAll((node) => String(node.type) === 'tile').map((node) => node.props.activation))
      .toEqual(['prepared', 'visible']);
    renderer.act(() => tree.unmount());
  });

  it('reads never without a store', () => {
    function Bare() {
      return React.createElement('tile', { activation: useFeedVideoActivation(null, 'a') });
    }
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => { tree = renderer.create(React.createElement(Bare)); });
    expect(tree.root.findAll((node) => String(node.type) === 'tile')[0].props.activation).toBe('never');
    renderer.act(() => tree.unmount());
  });
});
