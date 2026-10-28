/**
 * What the video and motion creators' settings chip reads, on the web and in the app:
 * the web creators (src/app/create-video, src/app/create-motion) and the app's creator
 * bar (`creatorParameterSummary`, ugc-mobile/lib/creator-parameter-summary.ts) each read
 * their own form or draft into these inputs and take the words from here, so the two
 * chips cannot word the same settings differently. The inputs are each side's own: the
 * web passes '' for a model without resolutions, the app the resolution its draft holds.
 * The web bundle compiles this file too: keep it free of React Native, Expo and Node
 * imports.
 */

/** The resolution a run shows: the one its mode names ("Pro 1080p"), else its own setting. */
function shownVideoResolution(modeLabel: string, resolution: string): string {
  return (modeLabel.match(/(?:\d{3,4}p|4k)/i)?.[0] ?? resolution).toUpperCase();
}

/**
 * A video's resolution, or the mode that names one ("Pro 1080p"), then its ratio, its
 * length and its sound: "480P · 9:16 · 5s · Sound off". With neither resolution, the
 * first part is left out; on a model with no sound to switch, the last.
 */
export function videoSettingsSummary({
  modeLabel,
  resolution,
  aspectRatio,
  durationSeconds,
  sound = null,
}: {
  /** The chosen mode's label, or its value where it has none; only a resolution it names is read. */
  modeLabel: string;
  /** The resolution setting, read where the mode names none; '' leaves it out. */
  resolution: string;
  aspectRatio: string;
  /** The whole run's: a multi-shot run's is its shots' together. */
  durationSeconds: number;
  /** Whether the run makes sound, on a model that can switch it; null where it cannot. */
  sound?: boolean | null;
}): string {
  return [
    shownVideoResolution(modeLabel, resolution),
    aspectRatio,
    `${durationSeconds}s`,
    sound === null ? '' : sound ? 'Sound on' : 'Sound off',
  ].filter(Boolean).join(' · ');
}

/**
 * A video run's resolution and length alone, "480P · 5s": what a narrow chip keeps of
 * the settings, and what a model row says its price is for.
 */
export function videoRunShortSummary({
  modeLabel,
  resolution,
  durationSeconds,
}: {
  modeLabel: string;
  resolution: string;
  durationSeconds: number;
}): string {
  return [shownVideoResolution(modeLabel, resolution), `${durationSeconds}s`].filter(Boolean).join(' · ');
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
