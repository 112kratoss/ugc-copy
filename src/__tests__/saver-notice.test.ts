import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readFeedbackSnapshot, resetFeedbackState, subscribeToFeedback } from '@/components/feedback-state';
import {
  SAVER_NOTICE_MESSAGE,
  creatorSeesSaverFields,
  resetSaverNoticeForTests,
} from '@/components/saver-notice';

function noticesShown() {
  return readFeedbackSnapshot().toasts.filter((toast) => toast.message === SAVER_NOTICE_MESSAGE).length;
}

describe('saver notice', () => {
  let unsubscribe = () => {};

  beforeEach(() => {
    // The root layout's FeedbackViewport, which draws every toast.
    unsubscribe = subscribeToFeedback(() => {});
  });

  afterEach(() => {
    unsubscribe();
    resetFeedbackState();
    resetSaverNoticeForTests();
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('tells an account at its first save, which goes out unnamed, and names it from the next save on', () => {
    expect(creatorSeesSaverFields('user-1', true)).toEqual({});
    expect(noticesShown()).toBe(1);
    expect(readFeedbackSnapshot().toasts[0]).toMatchObject({ tone: 'info', durationMs: 6000 });

    expect(creatorSeesSaverFields('user-1', true)).toEqual({ creatorSeesSaver: true });
    expect(noticesShown()).toBe(1);

    // A later page load in the same browser has been told already.
    resetSaverNoticeForTests();
    resetFeedbackState();
    expect(creatorSeesSaverFields('user-1', true)).toEqual({ creatorSeesSaver: true });
    expect(noticesShown()).toBe(0);
  });

  it('tells each account on a shared browser for itself', () => {
    creatorSeesSaverFields('user-1', true);
    expect(creatorSeesSaverFields('user-1', true)).toEqual({ creatorSeesSaver: true });

    // Someone else signs in, with or without a reload: they have not been told.
    expect(creatorSeesSaverFields('user-2', true)).toEqual({});
    expect(noticesShown()).toBe(2);
    expect(creatorSeesSaverFields('user-2', true)).toEqual({ creatorSeesSaver: true });
  });

  it('adds nothing to taking a save back, or to a save with no account, and says nothing', () => {
    expect(creatorSeesSaverFields('user-1', false)).toEqual({});
    expect(creatorSeesSaverFields(null, true)).toEqual({});
    expect(noticesShown()).toBe(0);
  });

  it('still tells a browser that refuses storage, once a page', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });

    expect(creatorSeesSaverFields('user-1', true)).toEqual({});
    expect(creatorSeesSaverFields('user-1', true)).toEqual({ creatorSeesSaver: true });
    expect(noticesShown()).toBe(1);
  });

  it('leaves saves unnamed, and the account untold, while nothing on the page could show the notice', () => {
    unsubscribe();

    expect(creatorSeesSaverFields('user-1', true)).toEqual({});
    expect(creatorSeesSaverFields('user-1', true)).toEqual({});
    expect(noticesShown()).toBe(0);
    expect(window.localStorage.length).toBe(0);
  });
});

describe('who may set creatorSeesSaver', () => {
  // The server takes the field as word that the person was told, so the web
  // sets it only through the notice module; the save route only reads it.
  it('is written only by the notice module and read only by the save route', () => {
    const srcRoot = path.resolve(__dirname, '..');
    const sourceFiles = (root: string): string[] => readdirSync(root).flatMap((entry) => {
      const absolutePath = path.join(root, entry);
      if (statSync(absolutePath).isDirectory()) return entry === '__tests__' ? [] : sourceFiles(absolutePath);
      return /\.(ts|tsx)$/.test(entry) ? [absolutePath] : [];
    });

    const mentioning = sourceFiles(srcRoot)
      .filter((filePath) => readFileSync(filePath, 'utf8').includes('creatorSeesSaver:'))
      .map((filePath) => path.relative(srcRoot, filePath).replaceAll(path.sep, '/'))
      .sort();

    expect(mentioning).toEqual(['components/saver-notice.ts', 'lib/showcase-save-route-adapter-service.ts']);
  });
});
