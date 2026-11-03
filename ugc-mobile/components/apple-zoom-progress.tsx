import type { ZoomVeilDrop } from '@/lib/zoom-veil';

export function AppleZoomProgress(_props: { veil: ZoomVeilDrop | null }) { return null; }

/** Android's flight mounts the reel's top controls once it has landed (`useMediaZoomLanded`). */
export function AppleZoomTopControlsCue(_props: { onShownChange: (shown: boolean) => void }) { return null; }
