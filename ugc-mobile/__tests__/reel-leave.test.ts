import { describe, expect, it } from 'vitest';

import { reelLeaveFor } from '@/lib/reel-leave';

// Review of #947: an Android close keeps the reel's route until the picture
// has landed, up to half a second after Back, and went back from whatever was
// on top by then: a screen pushed meanwhile was popped in the reel's place.
describe('reelLeaveFor', () => {
  const stack = (index: number, ...keys: string[]) => ({ key: 'root', index, routes: keys.map((key) => ({ key })) });

  it('goes back the usual way while the reel is in front', () => {
    expect(reelLeaveFor(stack(1, 'tabs', 'reel'), 'reel')).toEqual({ kind: 'back' });
    // A reel that is the first screen: the usual way is Explore in its place.
    expect(reelLeaveFor(stack(0, 'reel'), 'reel')).toEqual({ kind: 'back' });
  });

  it('takes the reel out by its key from under a screen pushed while it closed', () => {
    expect(reelLeaveFor(stack(2, 'tabs', 'reel', 'auth'), 'reel')).toEqual({
      kind: 'dispatch',
      action: { type: 'POP', payload: { count: 1 }, source: 'reel', target: 'root' },
    });
  });

  it('puts Explore in the place of a first-screen reel under such a screen', () => {
    expect(reelLeaveFor(stack(1, 'reel', 'auth'), 'reel')).toEqual({
      kind: 'dispatch',
      action: { type: 'REPLACE', payload: { name: '(tabs)', params: { screen: 'showcase' } }, source: 'reel', target: 'root' },
    });
  });

  it('does nothing once the reel is gone from its stack', () => {
    expect(reelLeaveFor(stack(1, 'tabs', 'creator'), 'reel')).toEqual({ kind: 'gone' });
  });

  it('goes back the usual way when the stack cannot be read', () => {
    expect(reelLeaveFor(undefined, 'reel')).toEqual({ kind: 'back' });
  });
});
