import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import FeedMediaLightbox from '@/app/feed/FeedMediaLightbox';
import type { ShowcaseMediaItem } from '@/lib/showcase';

class IntersectionObserverMock {
    readonly root = null;
    readonly rootMargin = '0px';
    readonly thresholds = [0];
    disconnect = vi.fn();
    observe = vi.fn();
    takeRecords = vi.fn(() => []);
    unobserve = vi.fn();
}

function mediaItem(index: number): ShowcaseMediaItem {
    return {
        id: `media-${index}`,
        url: `https://cdn.example.test/frame-${index}.png`,
        previewUrl: `https://cdn.example.test/frame-${index}.preview.webp`,
        mediaKind: 'image',
        contentType: 'image/png',
        originalName: `frame-${index}.png`,
        width: 1080,
        height: 1350,
        sortOrder: index,
    } as ShowcaseMediaItem;
}

const TITLE = 'Moody Bathroom Portrait Study';

function renderLightbox(props: Partial<React.ComponentProps<typeof FeedMediaLightbox>> = {}) {
    const onClose = vi.fn();
    const view = render(
        <FeedMediaLightbox
            title={TITLE}
            mediaItems={[mediaItem(0), mediaItem(1), mediaItem(2)]}
            initialIndex={0}
            onClose={onClose}
            {...props}
        />
    );
    return { onClose, ...view };
}

describe('FeedMediaLightbox', () => {
    beforeEach(() => {
        vi.stubGlobal('IntersectionObserver', IntersectionObserverMock);
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('is a labelled modal dialog named for the post', () => {
        renderLightbox();

        const dialog = screen.getByRole('dialog');
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        expect(dialog).toHaveAttribute('aria-label', TITLE);
        expect(screen.getByRole('button', { name: 'Close media' })).toBeInTheDocument();
    });

    it.each([
        ['the close button', () => fireEvent.click(screen.getByRole('button', { name: 'Close media' }))],
        ['Escape', () => fireEvent.keyDown(document, { key: 'Escape' })],
        ['a backdrop click', () => fireEvent.click(screen.getByTestId('feed-media-lightbox'))],
    ])('closes on %s', (_label, act) => {
        const { onClose } = renderLightbox();

        act();

        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('stays open when the click lands inside the panel', () => {
        const { onClose } = renderLightbox();

        fireEvent.click(screen.getByRole('dialog'));
        fireEvent.click(screen.getByRole('button', { name: 'Next media' }));

        expect(onClose).not.toHaveBeenCalled();
    });

    it('yields Escape to a nested dialog', () => {
        const { onClose } = renderLightbox();
        const nested = document.createElement('div');
        nested.setAttribute('data-showcase-overlay-nested', 'true');
        document.body.appendChild(nested);

        fireEvent.keyDown(document, { key: 'Escape' });

        expect(onClose).not.toHaveBeenCalled();
        nested.remove();
    });

    it('marks the document while open so the reel viewer yields Escape', () => {
        const { unmount } = renderLightbox();

        expect(document.body.dataset.showcaseOverlayOpen).toBe('true');

        unmount();

        expect(document.body.dataset.showcaseOverlayOpen).toBeUndefined();
    });

    it('locks body scroll and restores the previous value', () => {
        document.body.style.overflow = 'scroll';
        const { unmount } = renderLightbox();

        expect(document.body.style.overflow).toBe('hidden');

        unmount();

        expect(document.body.style.overflow).toBe('scroll');
        document.body.style.overflow = '';
    });

    it('returns focus to whatever opened it', async () => {
        const trigger = document.createElement('button');
        document.body.appendChild(trigger);
        trigger.focus();
        expect(document.activeElement).toBe(trigger);

        const { unmount } = renderLightbox();
        unmount();

        await waitFor(() => expect(document.activeElement).toBe(trigger));
        trigger.remove();
    });

    it('cycles Tab within the dialog', () => {
        renderLightbox();
        const dialog = screen.getByRole('dialog');
        const focusable = Array.from(
            dialog.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')
        );
        expect(focusable.length).toBeGreaterThan(1);

        const last = focusable[focusable.length - 1];
        last.focus();
        fireEvent.keyDown(document, { key: 'Tab' });

        expect(dialog.contains(document.activeElement)).toBe(true);
        expect(document.activeElement).toBe(focusable[0]);
    });

    it('opens on the slide that was clicked', () => {
        renderLightbox({ initialIndex: 1 });

        expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'Media 2 of 3');
    });

    it('moves slides with the arrow keys', () => {
        renderLightbox({ initialIndex: 0 });

        fireEvent.keyDown(document, { key: 'ArrowRight' });

        expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'Media 2 of 3');

        fireEvent.keyDown(document, { key: 'ArrowLeft' });

        expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'Media 1 of 3');
    });

    it('renders no full-bleed open button that would swallow video controls', () => {
        renderLightbox();

        // The carousel only renders that transparent overlay button when it is
        // given `onOpen`; it is labelled with the media title and would sit
        // above the <video>, eating every click meant for the controls.
        expect(screen.queryByRole('button', { name: TITLE })).toBeNull();
    });
});
