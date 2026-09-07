/** Metadata is advisory; server-side probing remains authoritative. */
export function readVideoDurationSeconds(source: File | string, signal?: AbortSignal): Promise<number | null> {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(null); return; }
    const video = document.createElement('video');
    let objectUrl: string | null = null;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (duration: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      video.removeEventListener('loadedmetadata', loaded);
      video.removeEventListener('error', failed);
      signal?.removeEventListener('abort', failed);
      try {
        video.removeAttribute('src');
        video.load();
      } catch {
        // Cleanup failures must not leave the upload waiting for metadata.
      }
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      resolve(duration);
    };
    const failed = () => finish(null);
    const loaded = () => finish(Number.isFinite(video.duration) && video.duration >= 0 ? video.duration : null);
    try {
      if (typeof source !== 'string' && video.canPlayType(source.type) === '') {
        resolve(null);
        return;
      }
      const url = typeof source === 'string' ? source : (objectUrl = URL.createObjectURL(source));
      video.preload = 'metadata';
      video.addEventListener('loadedmetadata', loaded);
      video.addEventListener('error', failed);
      signal?.addEventListener('abort', failed, { once: true });
      timeout = setTimeout(failed, 4000);
      video.src = url;
    } catch { finish(null); }
  });
}
