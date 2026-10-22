import { useEffect, useLayoutEffect, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
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

/** Shows "Shown" on the click and asks for "Later" from a zero-delay timer. */
function ZeroDelayProbe() {
  const [shown, setShown] = useState(false);
  const [later, setLater] = useState(false);
  return (
    <>
      <button type="button" onClick={() => {
        setShown(true);
        setTimeout(() => setLater(true), 0);
      }}>Show</button>
      {shown ? <p>Shown</p> : null}
      {later ? <p>Later</p> : null}
    </>
  );
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
    // Runs right after the probe's own reaction to `ready`, whose setState has
    // by then asked React for a render: React queues that render's setImmediate
    // in the next microtask, so this one is queued behind it. It holds the
    // thread for 3 ms after the commit, the loaded runner's case: Testing
    // Library's setTimeout(0) is then due before React's next setImmediate, the
    // one that runs the commit's effects.
    void ready.then(() => queueMicrotask(() => {
      realSetImmediate(() => {
        holdThread(3);
        steps.push('other work');
      });
    }));

    const found = screen.findByText('Shown');
    open();
    expect(await found).toBeInTheDocument();
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

  it('still let a zero-delay timer set before them fire, and the render it asks for land', async () => {
    // Testing Library's own setTimeout(0) comes after any zero-delay timer set
    // before the query, and the setImmediate after it lets the render that timer
    // asked for commit. A wait on the setImmediate alone returns before that
    // timer has fired.
    render(<ZeroDelayProbe />);
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));

    expect(await screen.findByText('Shown')).toBeInTheDocument();
    expect(screen.getByText('Later')).toBeInTheDocument();
  });
});
