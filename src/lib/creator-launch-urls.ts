/**
 * Launch URLs for the creator entry points.
 *
 * These live apart from `workflow-blueprint` on purpose. They are pure string
 * construction and the only thing client components need from that module, but
 * `workflow-blueprint` itself reaches server-side code:
 *
 *   workflow-blueprint -> prompt-enhancer -> provider-fetch
 *     -> provider-fetch-attempts -> server-helpers (createServiceClient)
 *
 * Importing the builders from `workflow-blueprint` therefore pulled the whole
 * chain into the client bundle and blocked `server-only` on the modules that
 * read the service-role key. Keeping them here lets client code take just the
 * URL helpers, and lets the server modules carry their guard.
 *
 * Nothing in this file may import server-side code -- that is the entire point.
 */

export function buildImageLaunchUrl(prompt: string, model = 'nano-banana-pro', aspectRatio = '9:16'): string {
  const params = new URLSearchParams({ prompt, model, aspectRatio });
  return `/create-image?${params.toString()}`;
}

export function buildVideoLaunchUrl(prompt: string, model = 'kling-3.0-video', aspectRatio = '9:16', duration = '5'): string {
  const params = new URLSearchParams({ prompt, model, aspectRatio, duration });
  return `/create-video?${params.toString()}`;
}

export function buildMotionLaunchUrl(prompt: string, model = 'kling-3.0'): string {
  const params = new URLSearchParams({ prompt, model });
  return `/create-motion?${params.toString()}`;
}
