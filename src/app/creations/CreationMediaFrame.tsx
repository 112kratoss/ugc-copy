'use client';

import { useState, type MouseEvent } from 'react';
import { AlertTriangle, Loader2, UploadCloud, Volume2 } from 'lucide-react';

export type CreationMediaKind = 'image' | 'video' | 'audio';

interface CreationMediaFrameProps {
    id: string;
    mediaKind: CreationMediaKind;
    src: string;
    posterSrc?: string | null;
    alt: string;
    outputCount?: number;
    onOpen: () => void;
    onRestore?: () => void;
    isRestoring?: boolean;
}

export default function CreationMediaFrame({
    id,
    mediaKind,
    src,
    posterSrc,
    alt,
    outputCount = 1,
    onOpen,
    onRestore,
    isRestoring = false,
}: CreationMediaFrameProps) {
    // The studio grid puts up to 36 of these on screen at once, and `src` is a
    // signed URL, which caches far worse than a public one. At preload
    // "metadata" that is 36 range requests for bytes nobody asked to watch. A
    // poster shows the same thing for the price of one image, so when we have
    // one the video fetches nothing until the pointer asks for playback.
    //
    // Without a poster the element still needs metadata to render a first
    // frame, so those tiles keep today's behaviour rather than going black.
    const defersVideoBytes = mediaKind === 'video' && Boolean(posterSrc);
    // Nothing will load, so nothing can report itself loaded -- start settled
    // or the spinner would sit over the poster forever.
    const [loadState, setLoadState] = useState<'loading' | 'loaded' | 'error'>(
        defersVideoBytes ? 'loaded' : 'loading',
    );

    const safelyPlayVideo = (event: MouseEvent<HTMLVideoElement>) => {
        const playback = event.currentTarget.play();
        if (playback) {
            void playback.catch(() => undefined);
        }
    };

    const resetVideo = (event: MouseEvent<HTMLVideoElement>) => {
        event.currentTarget.pause();
        if (event.currentTarget.readyState >= 1) {
            event.currentTarget.currentTime = 0;
        }
    };

    return (
        <div
            data-testid={`creation-media-frame-${id}`}
            className="relative aspect-[4/5] w-full overflow-hidden bg-black"
        >
            {loadState === 'loading' ? (
                <div className="absolute inset-0 z-10 flex items-center justify-center bg-zinc-950 text-zinc-500">
                    <Loader2 className="h-5 w-5 animate-spin" aria-label="Loading media" />
                </div>
            ) : null}

            {loadState === 'error' ? (
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-zinc-950 px-5 text-center text-zinc-500">
                    <AlertTriangle className="h-5 w-5" />
                    <span className="text-xs font-medium">Preview unavailable</span>
                    {onRestore ? (
                        <button
                            type="button"
                            onClick={onRestore}
                            disabled={isRestoring}
                            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-zinc-200 transition hover:border-white/20 hover:bg-white/10 disabled:cursor-wait disabled:opacity-60"
                        >
                            {isRestoring ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                                <UploadCloud className="h-3.5 w-3.5" />
                            )}
                            {isRestoring ? 'Restoring...' : 'Restore preview'}
                        </button>
                    ) : null}
                </div>
            ) : null}

            {mediaKind === 'image' ? (
                <button
                    type="button"
                    onClick={onOpen}
                    className="block h-full w-full bg-black text-left"
                    aria-label="Open image details"
                >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                        src={src}
                        alt={alt}
                        loading="lazy"
                        decoding="async"
                        onLoad={() => setLoadState('loaded')}
                        onError={() => setLoadState('error')}
                        className="h-full w-full object-contain transition duration-500 group-hover:scale-[1.015]"
                    />
                </button>
            ) : mediaKind === 'audio' ? (
                <div className="flex h-full w-full flex-col items-center justify-center gap-5 p-5">
                    <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-emerald-300">
                        <Volume2 className="h-7 w-7" />
                    </div>
                    <audio
                        src={src}
                        controls
                        preload="metadata"
                        onLoadedMetadata={() => setLoadState('loaded')}
                        onError={() => setLoadState('error')}
                        className="relative z-20 w-full"
                    />
                </div>
            ) : (
                <button
                    type="button"
                    onClick={onOpen}
                    className="block h-full w-full bg-black text-left cursor-pointer"
                    aria-label="Open video details"
                >
                    <video
                        src={src}
                        poster={posterSrc ?? undefined}
                        muted
                        loop
                        playsInline
                        preload={defersVideoBytes ? 'none' : 'metadata'}
                        onLoadedMetadata={() => setLoadState('loaded')}
                        onError={() => setLoadState('error')}
                        onMouseEnter={safelyPlayVideo}
                        onMouseLeave={resetVideo}
                        className="h-full w-full object-contain"
                    />
                </button>
            )}

            {outputCount > 1 ? (
                <button
                    type="button"
                    onClick={onOpen}
                    className="absolute bottom-3 right-3 z-20 rounded-full border border-white/10 bg-black/70 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-white backdrop-blur-md transition hover:bg-black/90"
                    aria-label={`Open ${outputCount} outputs`}
                >
                    {outputCount} outputs
                </button>
            ) : null}
        </div>
    );
}
