import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import FeedbackViewport from '@/components/FeedbackViewport';
import {
  dismissToast,
  pushToast,
  readFeedbackSnapshot,
  readToastHost,
  requestConfirmation,
  resetFeedbackState,
  setToastHost,
} from '@/components/feedback-state';
import {
  SAVER_NOTICE_MESSAGE,
  creatorSeesSaverFields,
  resetSaverNoticeForTests,
} from '@/components/saver-notice';

describe('feedback viewport', () => {
  afterEach(() => {
    resetFeedbackState();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('announces toasts in a polite live region and clears them on their own', () => {
    vi.useFakeTimers();
    render(<FeedbackViewport />);

    act(() => {
      pushToast({ tone: 'success', message: 'Post archived.', durationMs: 1000 });
    });

    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveTextContent('Post archived.');

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(region).not.toHaveTextContent('Post archived.');
  });

  it('lets the viewer dismiss a toast early', () => {
    render(<FeedbackViewport />);
    act(() => {
      pushToast({ tone: 'error', message: 'Could not archive.' });
    });

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    expect(screen.getByRole('status')).not.toHaveTextContent('Could not archive.');
  });

  it('ignores a dismiss for a toast that is already gone', () => {
    render(<FeedbackViewport />);
    let id = 0;
    act(() => {
      id = pushToast({ tone: 'info', message: 'Saved.' });
    });
    const before = readFeedbackSnapshot();
    act(() => {
      dismissToast(id);
      dismissToast(id);
    });
    expect(readFeedbackSnapshot().toasts).toEqual([]);
    expect(before.toasts).toHaveLength(1);
  });

  it('resolves a confirmation with the viewer\'s choice and restores focus', async () => {
    render(
      <>
        <button type="button">Archive post</button>
        <FeedbackViewport />
      </>,
    );
    const opener = screen.getByRole('button', { name: 'Archive post' });
    opener.focus();

    let answer: Promise<boolean> | null = null;
    act(() => {
      answer = requestConfirmation({
        title: 'Archive this post?',
        message: 'It will disappear from public surfaces.',
        confirmLabel: 'Archive',
      });
    });

    const dialog = await screen.findByRole('alertdialog', { name: 'Archive this post?' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleDescription('It will disappear from public surfaces.');

    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    await expect(answer).resolves.toBe(true);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('treats Escape and the backdrop as cancel', async () => {
    render(<FeedbackViewport />);

    let first: Promise<boolean> | null = null;
    act(() => {
      first = requestConfirmation({ title: 'Delete?', message: 'Gone for good.', confirmLabel: 'Delete', tone: 'danger' });
    });
    await screen.findByRole('alertdialog');
    fireEvent.keyDown(document, { key: 'Escape' });
    await expect(first).resolves.toBe(false);

    let second: Promise<boolean> | null = null;
    act(() => {
      second = requestConfirmation({ title: 'Delete?', message: 'Gone for good.', confirmLabel: 'Delete' });
    });
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(dialog.parentElement as HTMLElement);
    await expect(second).resolves.toBe(false);
  });

  it('answers an open confirmation with cancel when another one arrives', async () => {
    render(<FeedbackViewport />);

    let first: Promise<boolean> | null = null;
    let second: Promise<boolean> | null = null;
    act(() => {
      first = requestConfirmation({ title: 'First?', message: 'm', confirmLabel: 'Yes' });
    });
    await screen.findByRole('alertdialog', { name: 'First?' });
    act(() => {
      second = requestConfirmation({ title: 'Second?', message: 'm', confirmLabel: 'Yes' });
    });

    await expect(first).resolves.toBe(false);
    expect(screen.getByRole('alertdialog', { name: 'Second?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    await expect(second).resolves.toBe(true);
  });

  it('falls back to the native dialog when no viewport is mounted', async () => {
    const nativeConfirm = vi.spyOn(window, 'confirm').mockReturnValue(true);

    await expect(requestConfirmation({ title: 'Archive?', message: 'Hidden until restored.', confirmLabel: 'Archive' }))
      .resolves.toBe(true);
    expect(nativeConfirm).toHaveBeenCalledWith('Archive?\n\nHidden until restored.');
  });
});

describe('a dialog that hosts the toasts', () => {
  let dialog: HTMLElement | null = null;

  afterEach(() => {
    resetFeedbackState();
    dialog?.remove();
    dialog = null;
  });

  // Inside an `aria-modal` dialog (the reel) a toast drawn on the page is inert
  // to a screen reader and outside the dialog's focus order.
  it('draws the toasts inside the dialog while it hosts them, and on the page once it lets go', () => {
    render(<FeedbackViewport />);
    const host = document.createElement('div');
    host.setAttribute('role', 'dialog');
    host.setAttribute('aria-modal', 'true');
    document.body.appendChild(host);
    dialog = host;

    act(() => {
      setToastHost(host);
      pushToast({ tone: 'info', message: 'Saved to bookmarks.' });
    });

    const hosted = screen.getByRole('status');
    expect(host).toContainElement(hosted);
    expect(hosted).toHaveClass('ui-toast-viewport', 'ui-toast-viewport-in-dialog');
    expect(hosted).toHaveTextContent('Saved to bookmarks.');
    expect(within(host).getByRole('button', { name: 'Dismiss notification' })).toBeInTheDocument();

    act(() => setToastHost(null));

    const onPage = screen.getByRole('status');
    expect(host).not.toContainElement(onPage);
    expect(onPage).toHaveClass('ui-toast-viewport');
    expect(onPage).not.toHaveClass('ui-toast-viewport-in-dialog');
    // The same toast, still up.
    expect(onPage).toHaveTextContent('Saved to bookmarks.');
  });

  it('lets go of its host when the store is reset', () => {
    act(() => setToastHost(document.createElement('div')));
    resetFeedbackState();
    expect(readToastHost()).toBeNull();
  });
});

describe('the saver notice in the viewport', () => {
  const told = () => window.localStorage.getItem('magicbooklet:saver-notice:v2:user-1');
  const recordWrites = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls
    .filter(([input, init]) => String(input) === '/api/profile/saver-notice' && (init as RequestInit | undefined)?.method === 'POST');
  let fetchMock: ReturnType<typeof vi.fn>;

  /** Lets the record's request settle under fake timers. */
  async function flush() {
    await act(async () => {
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    });
  }

  function tell() {
    let fields: ReturnType<typeof creatorSeesSaverFields> = {};
    act(() => {
      fields = creatorSeesSaverFields('user-1', true, 'token-1');
    });
    return fields;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ seen: true }) }) as Response);
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    resetFeedbackState();
    resetSaverNoticeForTests();
    window.localStorage.clear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('counts a notice left to run out on a page in view as read, and puts it on record', async () => {
    render(<FeedbackViewport />);
    expect(tell()).toEqual({ saverNotYetTold: true });
    const region = screen.getByRole('status');
    expect(region).toHaveTextContent(SAVER_NOTICE_MESSAGE);

    act(() => {
      vi.advanceTimersByTime(5999);
    });
    expect(region).toHaveTextContent(SAVER_NOTICE_MESSAGE);
    expect(told()).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(region).not.toHaveTextContent(SAVER_NOTICE_MESSAGE);
    // Told at once; on record once the server has it.
    expect(told()).toBe('pending');
    expect(recordWrites(fetchMock)).toEqual([
      ['/api/profile/saver-notice', { method: 'POST', headers: { Authorization: 'Bearer token-1' } }],
    ]);
    await flush();
    expect(told()).toBe('recorded');
    expect(tell()).toEqual({ creatorSeesSaver: true });
  });

  /** The page goes out of view, or comes back. */
  function pageVisibility(state: DocumentVisibilityState, spy = vi.spyOn(document, 'visibilityState', 'get')) {
    spy.mockReturnValue(state);
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    return spy;
  }

  // Review 4 finding #5: leaving the page takes it down unread, as leaving the
  // app takes the app's down.
  it('takes the notice down unread when the page is hidden, whenever that is', async () => {
    render(<FeedbackViewport />);
    expect(tell()).toEqual({ saverNotYetTold: true });
    act(() => {
      vi.advanceTimersByTime(5_500);
    });

    const visibility = pageVisibility('hidden');
    await flush();

    expect(screen.getByRole('status')).not.toHaveTextContent(SAVER_NOTICE_MESSAGE);
    expect(told()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    // Back on the page: not told, so the next save tells them again.
    pageVisibility('visible', visibility);
    expect(tell()).toEqual({ saverNotYetTold: true });
    expect(screen.getByRole('status')).toHaveTextContent(SAVER_NOTICE_MESSAGE);
  });

  it('never counts one pushed onto a page already hidden', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    render(<FeedbackViewport />);
    expect(tell()).toEqual({ saverNotYetTold: true });
    act(() => {
      vi.advanceTimersByTime(6_000);
    });
    await flush();

    expect(told()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Review 4 finding #5: another window in front of the browser.
  it('stops counting while the window is out of focus, and goes on with the time it had left', async () => {
    render(<FeedbackViewport />);
    tell();
    act(() => {
      vi.advanceTimersByTime(2_000);
    });

    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByRole('status')).toHaveTextContent(SAVER_NOTICE_MESSAGE);
    expect(told()).toBeNull();

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    act(() => {
      vi.advanceTimersByTime(3_999);
    });
    expect(screen.getByRole('status')).toHaveTextContent(SAVER_NOTICE_MESSAGE);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole('status')).not.toHaveTextContent(SAVER_NOTICE_MESSAGE);
    expect(told()).toBe('pending');
    await flush();
  });

  // Review 4 finding #2: the root confirmation ("Report content?", "Unlock
  // this recipe?") is drawn over the reel, and with it over the notice.
  it('stops counting while a confirmation is open over it, and goes on once it is answered', async () => {
    render(<FeedbackViewport />);
    tell();
    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    let answer: Promise<boolean> | null = null;
    act(() => {
      answer = requestConfirmation({ title: 'Report content?', message: 'm', confirmLabel: 'Report' });
    });
    await flush();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByRole('status')).toHaveTextContent(SAVER_NOTICE_MESSAGE);
    expect(told()).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await expect(answer).resolves.toBe(false);
    await flush();
    act(() => {
      vi.advanceTimersByTime(4_999);
    });
    expect(told()).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(told()).toBe('pending');
    await flush();
  });

  // Review 4 finding #2: a dialog inside the reel (its reference preview)
  // covers a toast the reel hosts.
  it('stops counting while another dialog inside its host is open, and not for the host itself', async () => {
    render(<FeedbackViewport />);
    const host = document.createElement('div');
    host.setAttribute('role', 'dialog');
    host.setAttribute('aria-modal', 'true');
    document.body.appendChild(host);
    act(() => setToastHost(host));
    tell();
    await flush();

    const preview = document.createElement('div');
    preview.setAttribute('role', 'dialog');
    preview.setAttribute('aria-modal', 'true');
    act(() => {
      host.appendChild(preview);
    });
    await flush();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(within(host).getByRole('status')).toHaveTextContent(SAVER_NOTICE_MESSAGE);
    expect(told()).toBeNull();

    act(() => {
      preview.remove();
    });
    await flush();
    act(() => {
      vi.advanceTimersByTime(6_000);
    });
    expect(told()).toBe('pending');
    await flush();
    host.remove();
  });

  // Review 5 finding #1: layers that are not `aria-modal` cover it too.
  describe('under something drawn over it that is not a modal dialog', () => {
    const toastWords = () => screen.getByText(SAVER_NOTICE_MESSAGE);

    /** What the page draws at each point: the menu over the words, or the words. */
    function drawOverWords(over: () => Element | null) {
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function rect(this: HTMLElement) {
        return this.tagName === 'P'
          ? ({ left: 16, top: 70, width: 300, height: 20, right: 316, bottom: 90, x: 16, y: 70, toJSON: () => ({}) } as DOMRect)
          : ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
      });
      const elementFromPoint = vi.fn(() => over() ?? toastWords());
      Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: elementFromPoint });
      return elementFromPoint;
    }

    afterEach(() => {
      Reflect.deleteProperty(document, 'elementFromPoint');
      Reflect.deleteProperty(document, 'fullscreenElement');
    });

    it("stops counting while a menu is drawn over its words, as the reel's ⋯ is on a phone", async () => {
      render(<FeedbackViewport />);
      tell();
      let menu: HTMLElement | null = null;
      const elementFromPoint = drawOverWords(() => menu);
      act(() => {
        vi.advanceTimersByTime(1_000);
      });

      act(() => {
        menu = document.createElement('div');
        menu.setAttribute('role', 'menu');
        document.body.appendChild(menu);
      });
      await flush();
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(elementFromPoint).toHaveBeenCalled();
      expect(screen.getByRole('status')).toHaveTextContent(SAVER_NOTICE_MESSAGE);
      expect(told()).toBeNull();

      act(() => {
        menu?.remove();
        menu = null;
      });
      await flush();
      act(() => {
        vi.advanceTimersByTime(4_999);
      });
      expect(told()).toBeNull();
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(told()).toBe('pending');
      await flush();
    });

    it('stops counting while the browser shows something else full screen, and goes on after', async () => {
      render(<FeedbackViewport />);
      tell();
      act(() => {
        vi.advanceTimersByTime(1_000);
      });

      const player = document.createElement('div');
      document.body.appendChild(player);
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => player });
      act(() => {
        document.dispatchEvent(new Event('fullscreenchange'));
      });
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(told()).toBeNull();

      Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => null });
      act(() => {
        document.dispatchEvent(new Event('fullscreenchange'));
      });
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(told()).toBe('pending');
      player.remove();
      await flush();
    });

    it("stops counting while iOS Safari plays a video in its own full-screen player", async () => {
      render(<FeedbackViewport />);
      tell();
      const video = document.createElement('video');
      document.body.appendChild(video);
      act(() => {
        vi.advanceTimersByTime(1_000);
      });

      // Fired on the video, not bubbling: heard in the capture phase.
      act(() => {
        video.dispatchEvent(new Event('webkitbeginfullscreen'));
      });
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(told()).toBeNull();

      act(() => {
        video.dispatchEvent(new Event('webkitendfullscreen'));
      });
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(told()).toBe('pending');
      video.remove();
      await flush();
    });

    it('counts on while its words are clear, and while the page has nothing to say about it', async () => {
      render(<FeedbackViewport />);
      tell();
      drawOverWords(() => null);
      act(() => {
        vi.advanceTimersByTime(6_000);
      });
      expect(told()).toBe('pending');
      await flush();
    });
  });

  it('leaves every other toast to its own clock, focus or no focus', () => {
    render(<FeedbackViewport />);
    act(() => {
      pushToast({ tone: 'success', message: 'Post archived.', durationMs: 1000 });
      window.dispatchEvent(new Event('blur'));
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByRole('status')).not.toHaveTextContent('Post archived.');
  });

  // The notice comes up where a finger is already on its way: under the save
  // the person just tapped, or over the reel's controls.
  it('takes no press on its close button in its first 700 ms, and takes one after', async () => {
    render(<FeedbackViewport />);
    expect(tell()).toEqual({ saverNotYetTold: true });
    const close = screen.getByRole('button', { name: 'Dismiss notification' });

    act(() => {
      vi.advanceTimersByTime(699);
    });
    fireEvent.click(close);
    expect(screen.getByRole('status')).toHaveTextContent(SAVER_NOTICE_MESSAGE);
    expect(told()).toBeNull();
    expect(tell()).toEqual({ saverNotYetTold: true });

    act(() => {
      vi.advanceTimersByTime(1);
    });
    fireEvent.click(close);
    expect(screen.getByRole('status')).not.toHaveTextContent(SAVER_NOTICE_MESSAGE);
    expect(told()).toBe('pending');
    expect(tell()).toEqual({ creatorSeesSaver: true });
    await flush();
  });

  it('leaves any other toast to close at the first press', () => {
    render(<FeedbackViewport />);
    act(() => {
      pushToast({ tone: 'success', message: 'Post archived.' });
    });

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    expect(screen.getByRole('status')).not.toHaveTextContent('Post archived.');
  });
});
