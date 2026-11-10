import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APPLE_ZOOM_RETURN_LANDING_DEADLINE_MS,
  APPLE_ZOOM_RETURN_LANDS_AFTER_MS,
  clearAppleZoomReturn,
  forgetAppleZoomSurface,
  holdAppleZoomReturnPicture,
  isAppleZoomReturnPictureHeld,
  noteAppleZoomPopBegan,
  noteAppleZoomPopEnded,
  prepareAppleZoomReturn,
  registerAppleZoomSurface,
  releaseAppleZoomReturnPicture,
  resetAppleZoomReturnPictures,
  subscribeToAppleZoomReturnPictures,
} from '../lib/apple-zoom-surface';

describe('preparing the return tile', () => {
  it('only scrolls the originating surface and retries when a new page arrives', () => {
    const firstPage = vi.fn();
    const other = vi.fn();
    const unregister = registerAppleZoomSurface('saved', firstPage);
    registerAppleZoomSurface('home', other);
    prepareAppleZoomReturn('saved', 'post-50');
    expect(firstPage).toHaveBeenCalledWith('post-50');
    expect(other).not.toHaveBeenCalled();
    unregister();
    const nextPage = vi.fn();
    registerAppleZoomSurface('saved', nextPage);
    expect(nextPage).toHaveBeenCalledWith('post-50');
    clearAppleZoomReturn('saved', 'post-50');
    const afterClose = vi.fn();
    registerAppleZoomSurface('saved', afterClose);
    expect(afterClose).not.toHaveBeenCalled();
    forgetAppleZoomSurface('saved');
    forgetAppleZoomSurface('home');
  });
});

/**
 * The picture a close lands on: the tile of the post a reel is showing holds
 * its picture in the view UIKit's zoom shrinks the reel into, from the reel's
 * asking until the reel lets go (lib/apple-zoom-surface.ts).
 */
describe('the picture a close lands on', () => {
  afterEach(() => {
    resetAppleZoomReturnPictures();
    vi.useRealTimers();
  });

  it('is held by the one tile the reel names, and tells the tiles when that changes', () => {
    const heard = vi.fn();
    const stop = subscribeToAppleZoomReturnPictures(heard);
    expect(isAppleZoomReturnPictureHeld('explore', 'post-1')).toBe(false);

    holdAppleZoomReturnPicture('explore', 'post-1');
    expect(isAppleZoomReturnPictureHeld('explore', 'post-1')).toBe(true);
    // Another post, and the same post on another surface, hold nothing.
    expect(isAppleZoomReturnPictureHeld('explore', 'post-2')).toBe(false);
    expect(isAppleZoomReturnPictureHeld('home', 'post-1')).toBe(false);
    expect(isAppleZoomReturnPictureHeld(null, 'post-1')).toBe(false);
    expect(heard).toHaveBeenCalledTimes(1);

    // Asked for again, it is already held: nobody is told twice.
    holdAppleZoomReturnPicture('explore', 'post-1');
    expect(heard).toHaveBeenCalledTimes(1);

    releaseAppleZoomReturnPicture('explore', 'post-1', false);
    expect(isAppleZoomReturnPictureHeld('explore', 'post-1')).toBe(false);
    expect(heard).toHaveBeenCalledTimes(2);

    // Letting go of what is not held is nothing.
    releaseAppleZoomReturnPicture('explore', 'post-1', false);
    expect(heard).toHaveBeenCalledTimes(2);
    stop();
  });

  it('stays through a pop the app asked for, until the navigator says the pop has ended', () => {
    const heard = vi.fn();
    subscribeToAppleZoomReturnPictures(heard);
    holdAppleZoomReturnPicture('explore', 'post-1');
    holdAppleZoomReturnPicture('profile', 'post-9');
    heard.mockClear();

    // The reel is out of React before UIKit has asked what to shrink it into.
    releaseAppleZoomReturnPicture('explore', 'post-1', true);
    expect(isAppleZoomReturnPictureHeld('explore', 'post-1')).toBe(true);
    expect(heard).not.toHaveBeenCalled();

    noteAppleZoomPopEnded();
    expect(isAppleZoomReturnPictureHeld('explore', 'post-1')).toBe(false);
    // A reel still up under another screen keeps its tile's picture.
    expect(isAppleZoomReturnPictureHeld('profile', 'post-9')).toBe(true);
    expect(heard).toHaveBeenCalledTimes(1);

    // A screen coming back with nothing waiting changes nothing.
    noteAppleZoomPopEnded();
    expect(heard).toHaveBeenCalledTimes(1);
  });

  // The reel is gone, so nothing in it can say when its picture has landed:
  // the pop's start is the cue, and the pop takes the same time to land it.
  it('lets go once the pop it was waiting on has had the time to land it', () => {
    vi.useFakeTimers();
    const heard = vi.fn();
    holdAppleZoomReturnPicture('explore', 'post-1');
    holdAppleZoomReturnPicture('profile', 'post-9');
    subscribeToAppleZoomReturnPictures(heard);
    releaseAppleZoomReturnPicture('explore', 'post-1', true);

    // The pop has yet to begin: nothing counts down but the deadline.
    vi.advanceTimersByTime(APPLE_ZOOM_RETURN_LANDS_AFTER_MS * 2);
    expect(isAppleZoomReturnPictureHeld('explore', 'post-1')).toBe(true);

    noteAppleZoomPopBegan();
    vi.advanceTimersByTime(APPLE_ZOOM_RETURN_LANDS_AFTER_MS - 1);
    expect(isAppleZoomReturnPictureHeld('explore', 'post-1')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(isAppleZoomReturnPictureHeld('explore', 'post-1')).toBe(false);
    expect(heard).toHaveBeenCalledTimes(1);
    // A picture a reel is still showing waits on no pop.
    expect(isAppleZoomReturnPictureHeld('profile', 'post-9')).toBe(true);

    // The pop's end finds nothing left to let go.
    noteAppleZoomPopEnded();
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('lets go at the pop\'s end if that comes first', () => {
    vi.useFakeTimers();
    holdAppleZoomReturnPicture('explore', 'post-1');
    releaseAppleZoomReturnPicture('explore', 'post-1', true);
    noteAppleZoomPopBegan();
    noteAppleZoomPopEnded();
    expect(isAppleZoomReturnPictureHeld('explore', 'post-1')).toBe(false);
    // And the timer the pop's start set has nothing left to do.
    const heard = vi.fn();
    subscribeToAppleZoomReturnPictures(heard);
    vi.advanceTimersByTime(APPLE_ZOOM_RETURN_LANDING_DEADLINE_MS);
    expect(heard).not.toHaveBeenCalled();
  });

  it('lets go after a deadline when the end of the pop is never heard', () => {
    vi.useFakeTimers();
    holdAppleZoomReturnPicture('explore', 'post-1');
    releaseAppleZoomReturnPicture('explore', 'post-1', true);

    vi.advanceTimersByTime(APPLE_ZOOM_RETURN_LANDING_DEADLINE_MS - 1);
    expect(isAppleZoomReturnPictureHeld('explore', 'post-1')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(isAppleZoomReturnPictureHeld('explore', 'post-1')).toBe(false);
  });

  it('keeps a picture that is asked for again while a pop was landing it', () => {
    vi.useFakeTimers();
    holdAppleZoomReturnPicture('explore', 'post-1');
    releaseAppleZoomReturnPicture('explore', 'post-1', true);
    holdAppleZoomReturnPicture('explore', 'post-1');

    noteAppleZoomPopEnded();
    vi.advanceTimersByTime(APPLE_ZOOM_RETURN_LANDING_DEADLINE_MS);
    expect(isAppleZoomReturnPictureHeld('explore', 'post-1')).toBe(true);
  });

  it('lets go at once when asked to while a pop was landing it', () => {
    holdAppleZoomReturnPicture('explore', 'post-1');
    releaseAppleZoomReturnPicture('explore', 'post-1', true);
    releaseAppleZoomReturnPicture('explore', 'post-1', false);
    expect(isAppleZoomReturnPictureHeld('explore', 'post-1')).toBe(false);
  });

  it('forgets a surface\'s pictures with the surface', () => {
    const heard = vi.fn();
    holdAppleZoomReturnPicture('explore', 'post-1');
    holdAppleZoomReturnPicture('explore-2', 'post-1');
    subscribeToAppleZoomReturnPictures(heard);

    forgetAppleZoomSurface('explore');
    expect(isAppleZoomReturnPictureHeld('explore', 'post-1')).toBe(false);
    // A surface whose id only begins the same way is another surface.
    expect(isAppleZoomReturnPictureHeld('explore-2', 'post-1')).toBe(true);
    expect(heard).toHaveBeenCalledTimes(1);
  });
});
