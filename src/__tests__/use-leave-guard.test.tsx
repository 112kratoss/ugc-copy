import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import FeedbackViewport from '@/components/FeedbackViewport';
import type { ConfirmationRequest } from '@/components/feedback-state';
import { holdForLeaveGuard, useLeaveGuard } from '@/lib/use-leave-guard';

const routerMocks = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => routerMocks,
}));

const QUESTION: ConfirmationRequest = {
  title: 'Leave this draft?',
  message: 'Your draft will be lost.',
  confirmLabel: 'Leave',
  cancelLabel: 'Stay',
  tone: 'danger',
};

/** A page with one field: unsaved while it holds text. */
function DraftPage({
  guardBack,
  historyKey = 'draftLeaveGuard',
  onLeave,
  question = QUESTION,
}: {
  guardBack?: boolean;
  historyKey?: string;
  onLeave?: () => void;
  question?: ConfirmationRequest;
}) {
  const [draft, setDraft] = useState('');
  const { leave } = useLeaveGuard({ isDirty: draft !== '', question, historyKey, guardBack, onLeave });
  return (
    <>
      <input aria-label="Draft" value={draft} onChange={(event) => setDraft(event.target.value)} />
      <button type="button" onClick={() => leave(() => routerMocks.replace('/drafts/saved'))}>
        Save and go
      </button>
    </>
  );
}

const typeDraft = (value: string) => fireEvent.change(screen.getByLabelText('Draft'), { target: { value } });

// A traversal of the browser's own: popstate follows with the state of the
// entry reached (jsdom answers later). Next's own popstate reloads the page on
// an entry whose state is neither empty nor Next's (`__NA`), so none may be reached.
const traverse = (delta: number) => act(async () => {
  const reached = new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`No popstate after history.go(${delta})`)), 2000);
    window.addEventListener('popstate', () => {
      window.clearTimeout(timer);
      resolve();
    }, { once: true });
  });
  History.prototype.go.call(window.history, delta);
  await reached;
  const state = window.history.state as Record<string, unknown> | null;
  expect(state === null || state.__NA === true, 'an entry Next would reload the page on').toBe(true);
});
const pressBack = () => traverse(-1);

const pageLinks: HTMLAnchorElement[] = [];
/** A plain link elsewhere in the document, as the app shell's are. */
const addLink = (href: string) => {
  const link = document.createElement('a');
  link.href = href;
  link.textContent = 'Elsewhere';
  document.body.append(link);
  pageLinks.push(link);
  return link;
};

/** Dispatches `beforeunload` as the browser does, and says whether the page asked to stay. */
const unloadIsHeld = () => {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};

describe('useLeaveGuard', () => {
  beforeEach(() => {
    routerMocks.push.mockReset();
    routerMocks.replace.mockReset();
    // An address before the page's, so a Back that leaves has somewhere to land.
    window.history.pushState(null, '', '/drafts');
    window.history.pushState(null, '', '/drafts/new');
    // Next's patched history methods copy its own fields in from the entry on
    // top when an object is written without them.
    for (const method of ['pushState', 'replaceState'] as const) {
      const write = History.prototype[method];
      window.history[method] = function (data: unknown, unused: string, url?: string | URL | null) {
        const current = window.history.state as Record<string, unknown> | null;
        const withNextFields = data && typeof data === 'object' && !('__NA' in data)
          ? { ...data, ...(current?.__NA ? { __NA: current.__NA } : {}) }
          : data;
        write.call(this, withNextFields, unused, url);
      };
    }
  });

  afterEach(() => {
    pageLinks.splice(0).forEach((link) => link.remove());
    vi.restoreAllMocks();
    Reflect.deleteProperty(window.history, 'pushState');
    Reflect.deleteProperty(window.history, 'replaceState');
  });

  it('puts nothing up while the page is clean', () => {
    const pushState = vi.spyOn(window.history, 'pushState');
    const navigate = vi.fn();
    render(
      <>
        <DraftPage />
        <FeedbackViewport />
      </>
    );
    const link = addLink('/showcase');
    let heldBeforeTheLink: boolean | null = null;
    link.addEventListener('click', (event) => {
      heldBeforeTheLink = event.defaultPrevented;
      // jsdom would try to navigate this document.
      event.preventDefault();
    });

    fireEvent.click(link);

    expect(heldBeforeTheLink).toBe(false);
    expect(holdForLeaveGuard(navigate)).toBe(false);
    expect(unloadIsHeld()).toBe(false);
    expect(pushState).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('marks the page entry and puts its own entry over it, under the key it is given, once the page is dirty', () => {
    const replaceState = vi.spyOn(window.history, 'replaceState');
    const pushState = vi.spyOn(window.history, 'pushState');
    render(<DraftPage />);

    typeDraft('A first line');

    const page = replaceState.mock.calls[0][0] as Record<string, unknown>;
    const guard = pushState.mock.calls[0][0] as Record<string, unknown>;
    expect(page).toMatchObject({ __NA: true, draftLeaveGuardPage: expect.any(String) });
    expect(guard).toEqual({ draftLeaveGuard: page.draftLeaveGuardPage });
    expect(pushState.mock.calls[0][2]).toBe(window.location.href);
    expect(window.location.pathname).toBe('/drafts/new');
    expect(unloadIsHeld()).toBe(true);
  });

  it('asks its question before Back leaves, and runs onLeave only for a leave', async () => {
    const onLeave = vi.fn();
    const back = vi.spyOn(window.history, 'back');
    render(
      <>
        <DraftPage onLeave={onLeave} />
        <FeedbackViewport />
      </>
    );
    typeDraft('A first line');

    await pressBack();
    const question = await screen.findByRole('alertdialog', { name: 'Leave this draft?' });
    expect(question).toHaveAccessibleDescription('Your draft will be lost.');
    // Forward onto its guard entry again while the question is up.
    await waitFor(() => expect(window.history.state).toHaveProperty('draftLeaveGuard'));
    fireEvent.click(within(question).getByRole('button', { name: 'Stay' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());

    expect(onLeave).not.toHaveBeenCalled();
    expect(back).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Draft')).toHaveValue('A first line');

    await pressBack();
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Leave' }));

    // Off the guard entry, then the Back that was asked for.
    await waitFor(() => expect(window.location.pathname).toBe('/drafts'));
    expect(back).toHaveBeenCalledTimes(2);
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it('asks before a link leaves, then steps off its entry before the router follows the link', async () => {
    const onLeave = vi.fn();
    const back = vi.spyOn(window.history, 'back');
    render(
      <>
        <DraftPage onLeave={onLeave} />
        <FeedbackViewport />
      </>
    );
    typeDraft('A first line');
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });

    fireEvent(addLink('/showcase?tab=new'), click);

    expect(click.defaultPrevented).toBe(true);
    fireEvent.click(within(await screen.findByRole('alertdialog', { name: 'Leave this draft?' })).getByRole('button', { name: 'Leave' }));
    await waitFor(() => expect(routerMocks.push).toHaveBeenCalledWith('/showcase?tab=new'));
    expect(back.mock.invocationCallOrder[0]).toBeLessThan(routerMocks.push.mock.invocationCallOrder[0]);
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  // The layout's "Skip to content" (`#main-content`) is the first link a
  // keyboard reaches; a fragment of this page leaves nothing behind.
  it('lets a link to a place on this page through without asking', () => {
    render(
      <>
        <DraftPage />
        <FeedbackViewport />
      </>
    );
    typeDraft('A first line');
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });

    fireEvent(addLink('/drafts/new#main-content'), click);

    expect(click.defaultPrevented).toBe(false);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(routerMocks.push).not.toHaveBeenCalled();
  });

  it('asks with the words of its latest render', async () => {
    const view = render(
      <>
        <DraftPage />
        <FeedbackViewport />
      </>
    );
    typeDraft('A first line');
    view.rerender(
      <>
        <DraftPage question={{ ...QUESTION, title: 'Leave this post?' }} />
        <FeedbackViewport />
      </>
    );

    fireEvent.click(addLink('/showcase'));

    expect(await screen.findByRole('alertdialog', { name: 'Leave this post?' })).toBeInTheDocument();
  });

  it("steps off its entry, unmarked, before the page's own way out, and asks nothing", async () => {
    const back = vi.spyOn(window.history, 'back');
    render(
      <>
        <DraftPage />
        <FeedbackViewport />
      </>
    );
    typeDraft('A first line');
    const replaceState = vi.spyOn(window.history, 'replaceState');

    fireEvent.click(screen.getByRole('button', { name: 'Save and go' }));

    // The entry it steps off keeps no mark for a later page to adopt.
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(replaceState.mock.calls[0][0]).not.toHaveProperty('draftLeaveGuard');
    expect(back).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith('/drafts/saved'));
    expect(back.mock.invocationCallOrder[0]).toBeLessThan(routerMocks.replace.mock.invocationCallOrder[0]);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('writes nothing into history with guardBack off, and still asks before a link', async () => {
    const replaceState = vi.spyOn(window.history, 'replaceState');
    const pushState = vi.spyOn(window.history, 'pushState');
    const back = vi.spyOn(window.history, 'back');
    render(
      <>
        <DraftPage guardBack={false} />
        <FeedbackViewport />
      </>
    );
    typeDraft('A first line');

    expect(replaceState).not.toHaveBeenCalled();
    expect(pushState).not.toHaveBeenCalled();

    fireEvent.click(addLink('/showcase'));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Leave' }));

    await waitFor(() => expect(routerMocks.push).toHaveBeenCalledWith('/showcase'));
    expect(back).not.toHaveBeenCalled();
  });

  it("holds the shell's other ways out for its question, and lets the one chosen come through", async () => {
    const back = vi.spyOn(window.history, 'back');
    const onLeave = vi.fn();
    const page = render(
      <>
        <DraftPage onLeave={onLeave} />
        <FeedbackViewport />
      </>
    );
    typeDraft('A first line');
    const heldAgain: boolean[] = [];
    const search = vi.fn(() => {
      // The form submitted again: the way out the person chose.
      heldAgain.push(holdForLeaveGuard(search));
    });
    const holdSearch = () => {
      let held = false;
      act(() => {
        held = holdForLeaveGuard(search);
      });
      return held;
    };

    expect(holdSearch()).toBe(true);
    fireEvent.click(within(await screen.findByRole('alertdialog', { name: 'Leave this draft?' })).getByRole('button', { name: 'Stay' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(search).not.toHaveBeenCalled();

    expect(holdSearch()).toBe(true);
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Leave' }));

    await waitFor(() => expect(search).toHaveBeenCalledTimes(1));
    expect(back.mock.invocationCallOrder[0]).toBeLessThan(search.mock.invocationCallOrder[0]);
    expect(heldAgain).toEqual([false]);
    expect(onLeave).toHaveBeenCalledTimes(1);

    page.unmount();
    expect(holdForLeaveGuard(search)).toBe(false);
  });

  // The key is how a page knows its own entries: a reload or a Back lands it
  // on its guard entry, which it adopts, and only its own.
  it('takes only an entry marked with its own key for its guard entry', () => {
    window.history.replaceState({ __NA: true, otherLeaveGuard: 'another-page' }, '', window.location.href);
    const pushState = vi.spyOn(window.history, 'pushState');
    const other = render(<DraftPage />);
    typeDraft('A first line');
    expect(pushState).toHaveBeenCalledTimes(1);
    other.unmount();

    window.history.replaceState({ __NA: true, draftLeaveGuard: 'an-earlier-visit' }, '', window.location.href);
    pushState.mockClear();
    render(<DraftPage />);
    typeDraft('A first line');
    expect(pushState).not.toHaveBeenCalled();
  });
});
