import { useEffect, useLayoutEffect, useState } from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Pins the async wrapper in setup.ts. A findBy* or waitFor returns only after
// React has run the passive effects of the commit it found; without that, a
// test that acts straight after the query can act before those effects, which
// is how four tests failed on main's loaded runner while their PR runs passed.
// The wait must also survive faked timers, both a faked setImmediate and a
// fake clock advanced across the query.

// Taken before any test fakes timers, like setup.ts's own copy.
const realSetImmediate = globalThis.setImmediate;

/** Holds the thread, as a loaded runner does between a commit and its effects. */
function holdThread(ms: number) {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // Spin.
  }
}

/** Shows "Shown" once `ready` settles: a render React schedules itself, outside act. */
function Probe({ ready, onStep }: { ready: Promise<void>; onStep: (step: string) => void }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    void ready.then(() => setShown(true));
  }, [ready]);
  useLayoutEffect(() => {
    if (shown) onStep('commit');
  }, [onStep, shown]);
  useEffect(() => {
    if (shown) onStep('effects');
  }, [onStep, shown]);
  return shown ? <p>Shown</p> : null;
}

describe('async queries', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['real timers', () => {}],
    // vi.useFakeTimers() fakes setImmediate by default. A wait on the faked one
    // would never end here, and the query would hang until the test timed out.
    ['a faked setImmediate', () => {
      vi.useFakeTimers({ toFake: ['setImmediate', 'clearImmediate'] });
    }],
  ])('return after the effects of the commit they found, with %s', async (_timers, fakeTimers) => {
    fakeTimers();
    const steps: string[] = [];
    const { promise: ready, resolve: open } = Promise.withResolvers<void>();
    render(<Probe ready={ready} onStep={(step) => steps.push(step)} />);

    // Both timers fire in one timers phase. The first lets the probe set state
    // outside act, so React renders on its scheduler, in a setImmediate; the
    // second queues 3 ms of other work right behind that render. Testing
    // Library's own setTimeout(0) is then due before React's next setImmediate,
    // the one that runs the commit's effects: the loaded runner's order, every
    // time.
    setTimeout(() => open(), 0);
    setTimeout(() => {
      realSetImmediate(() => {
        holdThread(3);
        steps.push('other work');
      });
    }, 0);

    expect(await screen.findByText('Shown')).toBeInTheDocument();
    // 'other work' in the middle shows the race was set up; 'effects' at the end
    // shows the query waited them out.
    expect(steps).toEqual(['commit', 'other work', 'effects']);
  });

  it('still return when a fake-clock advance is what shows the element', async () => {
    // Testing Library's own setTimeout(0), faked here, has to be scheduled while
    // the advance that found the element is still running, or nothing ever fires
    // it and the query hangs. A wait put in front of that timer moves it past the
    // advance's end.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const { promise: ready, resolve: open } = Promise.withResolvers<void>();
    render(<Probe ready={ready} onStep={() => {}} />);
    setTimeout(() => open(), 100);

    const found = screen.findByText('Shown');
    await vi.advanceTimersByTimeAsync(200);
    expect(await found).toBeInTheDocument();
  });
});
