/**
 * What the video and motion creators' settings chip reads, on the web and in the app:
 * the web creators (src/app/create-video, src/app/create-motion) and the app's creator
 * bar (`creatorParameterSummary`, ugc-mobile/lib/creator-parameter-summary.ts) each read
 * their own form or draft into these inputs and take the words from here, so the two
 * chips cannot drift apart. The web bundle compiles this file too: keep it free of
 * React Native, Expo and Node imports.
 */

/**
 * A video's resolution, or the mode that names one ("Pro 1080p"), then its ratio and
 * its length: "720P · 16:9 · 5s". A model with neither drops the first part.
 */
export function videoSettingsSummary({
  modeLabel,
  resolution,
  aspectRatio,
  durationSeconds,
}: {
  /** The chosen mode's label, or its value where it has none; only a resolution it names is read. */
  modeLabel: string;
  /** The resolution setting, read where the mode names none; '' leaves it out. */
  resolution: string;
  aspectRatio: string;
  /** The whole run's: a multi-shot run's is its shots' together. */
  durationSeconds: number;
}): string {
  const shownResolution = modeLabel.match(/(?:\d{3,4}p|4k)/i)?.[0] ?? resolution;
  return [shownResolution.toUpperCase(), aspectRatio, `${durationSeconds}s`].filter(Boolean).join(' · ');
}

/**
 * A motion run's quality, then the length its reference video gives it, in whole
 * seconds rounded up: "720P · 8s", or "720P · Add motion" until there is a reference
 * video.
 */
export function motionSettingsSummary({
  quality,
  referenceSeconds,
}: {
  quality: string;
  /** The reference video's length; 0 or null while there is none. */
  referenceSeconds: number | null;
}): string {
  const seconds = Math.max(0, Math.ceil(referenceSeconds ?? 0));
  return [quality.toUpperCase(), seconds > 0 ? `${seconds}s` : 'Add motion'].join(' · ');
}
