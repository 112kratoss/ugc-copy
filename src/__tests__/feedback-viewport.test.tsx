import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import FeedbackViewport from '@/app/components/FeedbackViewport';
import {
  dismissToast,
  pushToast,
  readFeedbackSnapshot,
  requestConfirmation,
  resetFeedbackState,
} from '@/app/components/feedback-state';

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
