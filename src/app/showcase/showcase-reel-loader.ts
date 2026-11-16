import { useSyncExternalStore } from 'react';

type ShowcaseReelViewerModule = typeof import('@/app/showcase/ShowcaseReelViewer');

/** How long a host's idle-time load of the reel's code waits for the page to fall idle. */
export const SHOWCASE_REEL_WARM_IDLE_TIMEOUT_MS = 2_000;

let showcaseReelViewerPromise: Promise<ShowcaseReelViewerModule> | null = null;
// The module once it has arrived in this document (`useLoadedShowcaseReelViewer`).
let loadedShowcaseReelViewer: ShowcaseReelViewerModule | null = null;
const loadedShowcaseReelViewerListeners = new Set<() => void>();

export function loadShowcaseReelViewer(): Promise<ShowcaseReelViewerModule> {
    showcaseReelViewerPromise ??= import('@/app/showcase/ShowcaseReelViewer')
        .then((module) => {
            loadedShowcaseReelViewer = module;
            loadedShowcaseReelViewerListeners.forEach((listener) => listener());
            return module;
        })
        .catch((error) => {
            showcaseReelViewerPromise = null;
            throw error;
        });

    return showcaseReelViewerPromise;
}

export function warmShowcaseReelViewer(): void {
    void loadShowcaseReelViewer().catch(() => undefined);
}

function subscribeToLoadedShowcaseReelViewer(listener: () => void): () => void {
    loadedShowcaseReelViewerListeners.add(listener);
    return () => {
        loadedShowcaseReelViewerListeners.delete(listener);
    };
}

/**
 * The reel's module once it is in this document, else null (and always null on the server):
 * a host draws a reel opened after that at once, in the render that opens it (`ShowcaseReel`).
 */
export function useLoadedShowcaseReelViewer(): ShowcaseReelViewerModule | null {
    return useSyncExternalStore(
        subscribeToLoadedShowcaseReelViewer,
        () => loadedShowcaseReelViewer,
        () => null,
    );
}
