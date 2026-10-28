import { motionSettingsSummary, videoSettingsSummary } from '@/lib/creator-settings-summary/creator-settings-summary';
import type { GenerationModelDescriptor } from '@/lib/generation-model-catalog';
import { multiShotTotalDuration } from '@/lib/generation-model-draft';
import { getMotionDuration, type MotionCreationDraft, type VideoCreationDraft } from '@/lib/media-creation-view-model';

/**
 * The video and motion bars' summary; the image bar builds its own from the image draft's fields.
 * The words are the web creators' as well (`creator-settings-summary/`): this only reads the draft
 * and its model into them.
 */
export function creatorParameterSummary(
  draft: VideoCreationDraft | MotionCreationDraft,
  model: Pick<GenerationModelDescriptor, 'controls'> | null,
): string {
  if (draft.tool === 'video') {
    const modeControl = model?.controls.find((control) => control.key === 'mode' && control.type === 'choice');
    return videoSettingsSummary({
      modeLabel: modeControl?.type === 'choice'
        ? modeControl.options.find((option) => option.value === draft.mode)?.label ?? draft.mode
        : draft.mode,
      resolution: draft.resolution,
      aspectRatio: draft.aspectRatio,
      durationSeconds: draft.isMultiShot ? multiShotTotalDuration(draft.multiPrompts) : draft.duration,
      // Said only where the model has sound to switch, as the web chip says it.
      sound: model?.controls.some((control) => control.key === 'sound' && control.type === 'boolean') ? draft.sound : null,
    });
  }
  return motionSettingsSummary({
    quality: draft.mode,
    referenceSeconds: draft.referenceVideo ? getMotionDuration(draft) : null,
  });
}
