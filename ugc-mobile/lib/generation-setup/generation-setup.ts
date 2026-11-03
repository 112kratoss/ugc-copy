/**
 * A creation's generation setup as its post shows it to everyone: the settings
 * the creator chose for the run, in one quiet line under the post's Made with
 * ("9:16 · 1K · JPG"), on the web's post page and in the app's post Details.
 * The owner's decision of 2026-11-03: the setup is a standard detail, seen
 * without unlocking anything. Until then a recipe made from a creation held it
 * as a protected "Saved generation setup" note, which the recipes published
 * before keep (`parseGenerationSetupNotes` in ../recipe-reading/recipe-reading.ts
 * reads them).
 *
 * The server builds the pairs with the labels below
 * (`buildPublicGenerationSetup`, src/lib/public-generation-setup.ts) from the
 * run's model as the published catalog lists it: a setting shows only where the
 * model offered a choice for it in that run (two options or more, or a switch
 * such as sound), so a model with one resolution or one format, or no sound to
 * switch, says nothing of it. It leaves out the model, which Made with names,
 * the inputs, which a locked recipe's preview counts by kind, Google Search
 * grounding unless it was on, and a template's result, whose settings are its
 * author's. Each client draws them in the words below, so the web and the app
 * read alike.
 *
 * It is shared with the web by relative import, like the recipe reading rule:
 * keep it free of React Native, Expo and Node imports. The folder keeps its own
 * self-contained tsconfig.json.
 */

/** One setting as the server sends it: what it is and what it was set to. */
export interface GenerationSetupEntry {
  label: string;
  value: string;
}

/**
 * The label of every setting a post can show: the server writes them, and the
 * line reads them. A model's quality goes by the name its catalog gives the
 * control ("Quality", or "Speed" on Ideogram's), `quality` where it gives none.
 */
export const GENERATION_SETUP_LABELS = {
  aspectRatio: 'Aspect ratio',
  resolution: 'Resolution',
  mode: 'Mode',
  quality: 'Quality',
  outputFormat: 'Output format',
  googleSearch: 'Google Search grounding',
  duration: 'Duration',
  sound: 'Sound',
  camera: 'Camera',
  shots: 'Shots',
  renderMode: 'Render mode',
  characterOrientation: 'Character orientation',
} as const;

/** A switch's two values, as the server words them. */
export const GENERATION_SETUP_SWITCH = { on: 'On', off: 'Off' } as const;

function isSwitchValue(value: string): boolean {
  return value === GENERATION_SETUP_SWITCH.on || value === GENERATION_SETUP_SWITCH.off;
}

/**
 * One setting as the line says it: the value where it names itself ("9:16",
 * "1K", "Fast", "JPG", "5s", "Fixed lens"), and a switch or a count with what
 * it is ("Sound off", "Search grounding on", "3 shots"). A label this build
 * does not know keeps its value, or is named beside a switch's.
 */
export function generationSetupTerm({ label, value }: GenerationSetupEntry): string {
  if (label === GENERATION_SETUP_LABELS.aspectRatio && value.toLowerCase() === 'auto') return 'Auto ratio';
  if (label === GENERATION_SETUP_LABELS.googleSearch) return `Search grounding ${value.toLowerCase()}`;
  if (label === GENERATION_SETUP_LABELS.shots) return `${value} ${value === '1' ? 'shot' : 'shots'}`;
  return isSwitchValue(value) ? `${label} ${value.toLowerCase()}` : value;
}

/** "9:16 · 1K · JPG", or "16:9 · Fast · 1080P · Sound on": the setup as the post's line. */
export function formatGenerationSetupLine(entries: readonly GenerationSetupEntry[]): string {
  return entries.map(generationSetupTerm).join(' · ');
}

/**
 * "Generation settings: Aspect ratio: 9:16, Resolution: 1K, …": the line as a
 * screen reader says it on both clients, each value with its name.
 */
export function describeGenerationSetup(entries: readonly GenerationSetupEntry[]): string {
  return `Generation settings: ${entries.map(({ label, value }) => `${label}: ${value}`).join(', ')}`;
}

/**
 * The setup an answer carries, or undefined where it carries none: a server
 * that could not read it, or one from before the setup was public. An empty
 * list is a post with none to show. A pair with an empty label or value is
 * dropped rather than drawn as a stray separator.
 */
export function readGenerationSetup(value: unknown): GenerationSetupEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((entry): GenerationSetupEntry[] => {
    if (!entry || typeof entry !== 'object') return [];
    const { label, value: setting } = entry as { label?: unknown; value?: unknown };
    if (typeof label !== 'string' || typeof setting !== 'string') return [];
    const trimmedLabel = label.trim();
    const trimmedValue = setting.trim();
    return trimmedLabel && trimmedValue ? [{ label: trimmedLabel, value: trimmedValue }] : [];
  });
}
