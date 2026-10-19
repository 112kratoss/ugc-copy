import { afterEach, describe, expect, it, vi } from 'vitest';

import * as feedbackState from '@/components/feedback-state';
import { readFeedbackSnapshot, resetFeedbackState } from '@/components/feedback-state';
import {
  SAVER_NOTICE_MESSAGE,
  creatorSeesSaverFields,
  resetSaverNoticeForTests,
} from '@/components/saver-notice';

function noticesShown() {
  return readFeedbackSnapshot().toasts.filter((toast) => toast.message === SAVER_NOTICE_MESSAGE).length;
}

describe('saver notice', () => {
  afterEach(() => {
    resetFeedbackState();
    resetSaverNoticeForTests();
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('tells a browser once, at its first save, and lets every save after it name the saver', () => {
    expect(creatorSeesSaverFields(true)).toEqual({ creatorSeesSaver: true });
    expect(creatorSeesSaverFields(true)).toEqual({ creatorSeesSaver: true });
    expect(noticesShown()).toBe(1);
    expect(readFeedbackSnapshot().toasts[0]).toMatchObject({ tone: 'info', durationMs: 6000 });

    // A later page load in the same browser has been told already.
    resetSaverNoticeForTests();
    resetFeedbackState();
    expect(creatorSeesSaverFields(true)).toEqual({ creatorSeesSaver: true });
    expect(noticesShown()).toBe(0);
  });

  it('adds nothing to taking a save back, and says nothing', () => {
    expect(creatorSeesSaverFields(false)).toEqual({});
    expect(noticesShown()).toBe(0);
  });

  it('still tells a browser that refuses storage, once a page', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });

    expect(creatorSeesSaverFields(true)).toEqual({ creatorSeesSaver: true });
    expect(creatorSeesSaverFields(true)).toEqual({ creatorSeesSaver: true });
    expect(noticesShown()).toBe(1);
  });

  it('leaves a save unnamed, and the save itself alone, when the notice cannot be shown', () => {
    vi.spyOn(feedbackState, 'pushToast').mockImplementation(() => {
      throw new Error('no toast host');
    });

    expect(creatorSeesSaverFields(true)).toEqual({});
    // Not marked as told, so the next save tries again.
    expect(window.localStorage.getItem('magicbooklet:saver-notice:v1')).toBeNull();
  });
});
