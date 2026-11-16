'use client';

import dynamic from 'next/dynamic';
import { Loader2 } from 'lucide-react';

import type { ShowcaseReelViewerProps } from '@/app/showcase/ShowcaseReelViewer';
import { loadShowcaseReelViewer, useLoadedShowcaseReelViewer } from '@/app/showcase/showcase-reel-loader';

function ShowcaseReelLoadingFallback() {
    return (
        <div
            role="status"
            aria-live="polite"
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 text-sm font-bold text-white backdrop-blur-sm"
        >
            <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-zinc-950 px-5 py-3 shadow-2xl">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Opening preview
            </span>
        </div>
    );
}

const ShowcaseReelViewerOnItsWay = dynamic(
    () => loadShowcaseReelViewer(),
    {
        ssr: false,
        loading: ShowcaseReelLoadingFallback,
    }
);

/**
 * The reel over the page that opens it: Explore, and a creator's page.
 *
 * Once the reel's code is in the document (the hosts load it ahead, on idle and on intent) the
 * reel is drawn directly, in the render that opens it. Through `next/dynamic` alone every first
 * open waited in a Suspense boundary, its code loaded or not: the lazy component suspends for at
 * least a microtask, React commits the boundary's fallback, and then holds the reel back until
 * 300 ms after that fallback was shown (React's FALLBACK_THROTTLE_MS). A tap drew the page dimmed
 * under "Opening preview" first (owner's recording, 2026-11-16). That fallback is now drawn only
 * while the code is truly on its way, as on a page loaded on a reel's address, where the page is
 * covered by the reel's stage meanwhile (`reel-opening-restore.ts`).
 */
export default function ShowcaseReel(props: ShowcaseReelViewerProps) {
    const loadedModule = useLoadedShowcaseReelViewer();
    if (loadedModule) {
        const ShowcaseReelViewer = loadedModule.default;
        return <ShowcaseReelViewer {...props} />;
    }

    return <ShowcaseReelViewerOnItsWay {...props} />;
}
