/**
 * The model and settings each of the app's creators opens on, drawn from its first frame. The app
 * has no server render, and its catalog arrives over the network: half a second on the Pixel 9a
 * against production, seconds on a slow link. Each opening is the catalog's default for the tool
 * at that model's published settings, with its name, so the screen shows from the start what the
 * catalog settles a new draft on, and words typed in the meantime stay on the default.
 *
 * Until 2026-10-30 the creators opened on a stand-in instead (Kling 3.0 at 720p and 9:16 for video
 * and motion, Nano Banana 2 at 4:5 for image) under "Loading model settings…", and a draft started
 * before the catalog arrived kept Kling 3.0 at 70 credits for good.
 *
 * `src/__tests__/app-creator-opening.test.ts` holds these to the code catalog
 * (`buildGenerationModelCatalog` in src/lib/generation-model-catalog.ts, the mobile platform): a
 * new default, a new name for it or a new published setting fails it until this file follows, and
 * phones learn the change with the app's next update (an OTA). Until then an installed app opens
 * on the old default and moves to the new one, with any words typed meanwhile, once the network
 * confirms the catalog's revision (normalizeCreationDraftForCatalog).
 *
 * The web tests compile this file too: keep it free of imports, React Native, Expo and Node alike.
 */

export type AppCreatorTool = 'image' | 'video' | 'motion';

export interface AppCreatorOpening {
  /** The catalog's default model for the tool. */
  readonly modelId: string;
  /** Its name, which the model chip shows until the model's descriptor is in. */
  readonly displayName: string;
  /** Every control's published default, by catalog key, as the descriptor writes it (a choice is a string). */
  readonly settings: Readonly<Record<string, string | number | boolean>>;
}

export const APP_CREATOR_OPENINGS: Readonly<Record<AppCreatorTool, AppCreatorOpening>> = {
  image: {
    modelId: 'nano-banana-2',
    displayName: 'Nano Banana 2.0',
    settings: { aspectRatio: 'auto', resolution: '1K', outputFormat: 'jpg' },
  },
  video: {
    modelId: 'seedance-2-mini',
    displayName: 'Seedance 2 Mini',
    settings: { aspectRatio: '16:9', resolution: '480p', duration: 5, sound: false, referenceMode: 'frames' },
  },
  motion: {
    modelId: 'kling-2.6',
    displayName: 'Kling 2.6',
    settings: { resolution: '720p', characterOrientation: 'video', duration: 10 },
  },
};
