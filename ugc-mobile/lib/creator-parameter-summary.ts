import type { AppCreatorOpening } from '@/lib/app-creator-opening/app-creator-opening';
import { motionSettingsSummary, videoSettingsSummary } from '@/lib/creator-settings-summary/creator-settings-summary';
import type { GenerationModelDescriptor } from '@/lib/generation-model-catalog';
import { multiShotTotalDuration } from '@/lib/generation-model-draft';
import { getMotionDuration, type MotionCreationDraft, type VideoCreationDraft } from '@/lib/media-creation-view-model';

/**
 * The video and motion bars' summary; the image bar builds its own from the image draft's fields.
 * The words are the web creators' as well (`creator-settings-summary/`): this only reads the draft
 * and its model into them. Until the model's descriptor is in, `opening` is the app's opening for a
 * draft on its model, whose published settings say what the descriptor would.
 */
export function creatorParameterSummary(
  draft: VideoCreationDraft | MotionCreationDraft,
  model: Pick<GenerationModelDescriptor, 'controls'> | null,
  opening: Pick<AppCreatorOpening, 'settings'> | null = null,
): string {
  if (draft.tool === 'video') {
    const modeControl = model?.controls.find((control) => control.key === 'mode' && control.type === 'choice');
    const switchesSound = model
      ? model.controls.some((control) => control.key === 'sound' && control.type === 'boolean')
      : typeof opening?.settings.sound === 'boolean';
    return videoSettingsSummary({
      modeLabel: modeControl?.type === 'choice'
        ? modeControl.options.find((option) => option.value === draft.mode)?.label ?? draft.mode
        : draft.mode,
      resolution: draft.resolution,
      aspectRatio: draft.aspectRatio,
      durationSeconds: draft.isMultiShot ? multiShotTotalDuration(draft.multiPrompts) : draft.duration,
      // Said only where the model has sound to switch, as the web chip says it.
      sound: switchesSound ? draft.sound : null,
    });
  }
  return motionSettingsSummary({
    quality: draft.mode,
    referenceSeconds: draft.referenceVideo ? getMotionDuration(draft) : null,
  });
}
