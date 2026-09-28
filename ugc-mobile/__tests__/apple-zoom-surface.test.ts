import { describe, expect, it, vi } from 'vitest';
import { clearAppleZoomReturn, forgetAppleZoomSurface, prepareAppleZoomReturn, registerAppleZoomSurface } from '../lib/apple-zoom-surface';

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
