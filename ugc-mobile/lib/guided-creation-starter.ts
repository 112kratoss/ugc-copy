import type { CreationStarter } from './generation-model-draft';
import type { CreatorToolId } from './types';

/**
 * Where a guided first creation starts (onboarding's last step opens `/(tabs)/creator?guided=1` on the goal's
 * tool), for a tool whose catalog default costs more than the 25 welcome credits a new account receives.
 *
 * Video's default was Kling 3.0 at 5 s, 70 credits: of the 11 people who picked "Video" in the 30 days to
 * 2026-10-18 one made anything, against 3 of the 10 who picked image (Nano Banana 2 at 1K, 8 credits). Since
 * 2026-10-28 it is Seedance 2 Mini at 480p for 5 s without sound, 19 credits, which the grant covers; the
 * starters below are cheaper still. Seedance 1.5 Pro at 720p for 4 s without sound is 14 credits and takes a
 * prompt alone. The three settings
 * that set its price are pinned, so a change to the model's own defaults cannot raise it; a repricing or a
 * changed control in a catalog release can (docs/model-onboarding.md says to check this file).
 *
 * A tool lists its starters in order of preference, and the first the catalog still carries is used. Kie took
 * Seedance 1.5 Pro off its site (checked 2026-10-20) while its API still runs it, so the day the catalog drops
 * it a guided video starts on Seedance 2 Mini at 480p for 4 s without sound, 16 credits at Kie's 3.8 a second,
 * with no app release. A tool with no entry, or whose starters the catalog has all dropped, starts on the
 * catalog default.
 */
export const GUIDED_CREATION_STARTERS: Readonly<Partial<Record<CreatorToolId, readonly CreationStarter[]>>> = {
  video: [
    { modelId: 'seedance-1.5-pro', settings: { resolution: '720p', duration: '4', sound: false } },
    { modelId: 'seedance-2-mini', settings: { resolution: '480p', duration: 4, sound: false } },
  ],
};

/** Every starter a guided screen may seed this tool's draft with, in order: only for the tool it opened on. */
export function guidedCreationStarters(
  tool: CreatorToolId,
  screen: { guided: boolean; initialTool: CreatorToolId },
): readonly CreationStarter[] {
  return screen.guided && tool === screen.initialTool ? GUIDED_CREATION_STARTERS[tool] ?? [] : [];
}

/**
 * The starter for a draft of this tool: the first the catalog has not said it dropped (`missingIds`). When it
 * has dropped them all, the last, which the catalog reconcile then reads as gone and replaces with the default.
 */
export function guidedCreationStarter(
  tool: CreatorToolId,
  screen: { guided: boolean; initialTool: CreatorToolId },
  missingIds: readonly string[] = [],
): CreationStarter | null {
  const starters = guidedCreationStarters(tool, screen);
  return starters.find((starter) => !missingIds.includes(starter.modelId)) ?? starters.at(-1) ?? null;
}
