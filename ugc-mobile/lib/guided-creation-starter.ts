import type { CreationStarter } from './generation-model-draft';
import type { CreatorToolId } from './types';

/**
 * Where a guided first creation starts (onboarding's last step opens `/(tabs)/creator?guided=1` on the goal's
 * tool), for a tool whose catalog default costs more than the 25 welcome credits a new account receives.
 *
 * Video's default, Kling 3.0 at 5 s, is 70 credits: of the 11 people who picked "Video" in the 30 days to
 * 2026-10-18 one made anything, against 3 of the 10 who picked image (Nano Banana 2 at 1K, 8 credits).
 * Seedance 1.5 Pro at 720p for 4 s without sound is 14 credits and takes a prompt alone. The three settings
 * that set its price are pinned, so a change to the model's own defaults cannot raise it; a repricing or a
 * changed control in a catalog release can (docs/model-onboarding.md says to check this file). A tool with
 * no entry, or a starter the catalog no longer carries, starts on the catalog default.
 */
export const GUIDED_CREATION_STARTERS: Readonly<Partial<Record<CreatorToolId, CreationStarter>>> = {
  video: { modelId: 'seedance-1.5-pro', settings: { resolution: '720p', duration: '4', sound: false } },
};

/** The starter for a draft of this tool: only on a guided screen, and only for the tool it opened on. */
export function guidedCreationStarter(
  tool: CreatorToolId,
  screen: { guided: boolean; initialTool: CreatorToolId },
): CreationStarter | null {
  return screen.guided && tool === screen.initialTool ? GUIDED_CREATION_STARTERS[tool] ?? null : null;
}
