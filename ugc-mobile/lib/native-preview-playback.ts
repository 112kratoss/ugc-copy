export type PreviewRect = { x: number; y: number; width: number; height: number };
export function previewIntersectsViewport(preview: PreviewRect, viewport: PreviewRect): boolean {
  return preview.width > 0 && preview.height > 0 && viewport.width > 0 && viewport.height > 0
    && preview.x < viewport.x + viewport.width && preview.x + preview.width > viewport.x
    && preview.y < viewport.y + viewport.height && preview.y + preview.height > viewport.y;
}

type Playback = { pause: () => void };
/** Shared only by recoverable native previews; feed/viewer policy remains separate. */
export function createPreviewPlaybackOwner() {
  let owner: Playback | null = null;
  return {
    claim(next: Playback) { const previous = owner; owner = next; if (previous && previous !== next) previous.pause(); },
    release(player: Playback) { if (owner === player) owner = null; },
  };
}
export const nativePreviewPlaybackOwner = createPreviewPlaybackOwner();
