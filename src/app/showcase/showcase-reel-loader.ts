type ShowcaseReelViewerModule = typeof import('@/app/showcase/ShowcaseReelViewer');

let showcaseReelViewerPromise: Promise<ShowcaseReelViewerModule> | null = null;

export function loadShowcaseReelViewer(): Promise<ShowcaseReelViewerModule> {
    showcaseReelViewerPromise ??= import('@/app/showcase/ShowcaseReelViewer')
        .catch((error) => {
            showcaseReelViewerPromise = null;
            throw error;
        });

    return showcaseReelViewerPromise;
}

export function warmShowcaseReelViewer(): void {
    void loadShowcaseReelViewer().catch(() => undefined);
}
