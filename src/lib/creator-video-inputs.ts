import type { VideoInputAffordances } from '@/lib/generation-model-affordances';

/**
 * The video creator's inputs as one choice, frames or references (the artboard Inputs; PR 4 of
 * the creator redesign, the owner's answers of 2026-10-29). A model that takes both shows one
 * side at a time behind a switch, and a switch that would clear something asks first, offering
 * to bring what it can along: a start image becomes a reference, a picture becomes a frame.
 *
 * Providers split three ways here (docs/model-api-references): Seedance 2.5 calls first-frame,
 * first-and-last-frame and multimodal references "three mutually exclusive scenarios", Wan 3.0's
 * first frame "cannot be provided together with reference_*_urls", Veo picks one generation
 * type. Only Wan 2.7's reference endpoint takes a first frame beside its references, so its
 * references side keeps the start image (`keepsStart`).
 *
 * The run's own shape is not decided here: it is still read off what the run carries
 * (`getVideoRunAffordances`), so a switch changes what the card shows and asks, never what a
 * run sends for the inputs it holds.
 */

export type VideoInputSide = 'frames' | 'references';
export type VideoFrame = 'start' | 'end';

/** What each side of the selected model takes with the current settings. */
export type VideoInputSides = {
  /** The frame slots; null for a model with none (Gemini Omni video). */
  frames: { start: boolean; end: boolean; startRequired: boolean } | null;
  /**
   * What the references side holds; null where the model takes no reference with these
   * settings (Kling 3.0, Hailuo 2.3) and in a multi-shot run, which sends none.
   */
  references: { pictures: number; clips: number; tracks: number; keepsStart: boolean } | null;
  /** The switch's words: the options of the catalog's `referenceMode` control. */
  labels: Record<VideoInputSide, string>;
};

/** What a draft holds that the run would send: frames, and the references the model carries. */
export type HeldVideoInputs = {
  start: boolean;
  end: boolean;
  /** References of a kind the model has no slot for are on standby and not counted. */
  pictures: number;
  clips: number;
  tracks: number;
};

export const DEFAULT_VIDEO_INPUT_LABELS: Record<VideoInputSide, string> = { frames: 'Frames', references: 'References' };

/** The two sides of the selected model, as its descriptor (or the built-in tables before it arrives) says. */
export function videoInputSides(affordances: VideoInputAffordances, { isMultiShot }: { isMultiShot: boolean }): VideoInputSides {
  const { frames, elements, referenceVideos, referenceAudios, inputChoice } = affordances;
  const takesReferences = !isMultiShot && (elements.enabled || referenceVideos.max > 0 || referenceAudios.max > 0);
  return {
    frames: frames.start || frames.end
      // A multi-shot run sends no end frame (its page shows none).
      ? { start: frames.start, end: frames.end && !isMultiShot, startRequired: frames.startRequired }
      : null,
    references: takesReferences
      ? {
          pictures: elements.enabled ? elements.maxTotal : 0,
          clips: referenceVideos.max,
          tracks: referenceAudios.max,
          keepsStart: inputChoice.referencesKeep.start,
        }
      : null,
    labels: inputChoice.labels ?? DEFAULT_VIDEO_INPUT_LABELS,
  };
}

export type VideoInputView = {
  /** The side the card shows; null for a model with no inputs to show. */
  side: VideoInputSide | null;
  /** The model offers both sides, so the switch is drawn. */
  switchable: boolean;
  /**
   * The side what is attached holds the card to. A picture, clip or track holds it to
   * references; a frame the references side cannot keep, to frames. Null while nothing does,
   * and the card shows the side last picked.
   */
  heldSide: VideoInputSide | null;
  /**
   * Frames a draft holds beside its references, which the run leaves out: a draft from before
   * the switch, or Wan 2.7's start image carried to a model that takes no frame with references.
   */
  framesLeftOut: VideoFrame[];
};

/** The frames the frames side holds that the references side cannot keep. */
function framesOnly(sides: VideoInputSides, held: HeldVideoInputs): VideoFrame[] {
  if (!sides.frames || !sides.references) return [];
  return [
    ...(held.start && sides.frames.start && !sides.references.keepsStart ? ['start' as const] : []),
    ...(held.end && sides.frames.end ? ['end' as const] : []),
  ];
}

function holdsReferences(held: HeldVideoInputs): boolean {
  return held.pictures + held.clips + held.tracks > 0;
}

/** The side the inputs card shows: the one what is attached belongs to, else the one last picked. */
export function videoInputView(sides: VideoInputSides, held: HeldVideoInputs, picked: VideoInputSide): VideoInputView {
  if (!sides.frames && !sides.references) return { side: null, switchable: false, heldSide: null, framesLeftOut: [] };
  if (!sides.references) return { side: 'frames', switchable: false, heldSide: null, framesLeftOut: [] };
  if (!sides.frames) return { side: 'references', switchable: false, heldSide: null, framesLeftOut: [] };
  const frames = framesOnly(sides, held);
  // References win where a draft holds both: the run sends them and leaves the frames out.
  if (holdsReferences(held)) return { side: 'references', switchable: true, heldSide: 'references', framesLeftOut: frames };
  if (frames.length > 0) return { side: 'frames', switchable: true, heldSide: 'frames', framesLeftOut: [] };
  return { side: picked, switchable: true, heldSide: null, framesLeftOut: [] };
}

/** How a switch's question names what it would carry or clear. */
export type VideoInputNames = {
  /** The model's name: "Seedance 2.5". */
  model: string;
  /** The start and end images' file names, where they came from a file. */
  start: string | null;
  end: string | null;
  /** The carried pictures' @handles, in their order. */
  pictures: readonly string[];
};

export type VideoInputQuestion = {
  title: string;
  message: string;
  /** Cancels: the card stays on the side it shows. */
  keepLabel: string;
  confirmLabel: string;
};

/** What switching sides does: nothing to ask, or a question and what its yes carries and clears. */
export type VideoInputSwitch = {
  to: VideoInputSide;
  /** Null when nothing would be cleared, and the card switches at once. */
  question: VideoInputQuestion | null;
  /** Frames that come along as references, in order. */
  framesToReferences: VideoFrame[];
  /** Frames that go. */
  framesCleared: VideoFrame[];
  /** Pictures (their place among the carried pictures) that come along as frames, and the frame each fills. */
  picturesToFrames: Array<{ index: number; frame: VideoFrame }>;
  /** Every carried reference not brought along goes: pictures, clips and tracks. */
  clearsReferences: boolean;
};

/**
 * A long file name in a button, kept to `max` characters with its extension:
 * "IMG_20261028_2….jpg".
 */
export function shortFileName(name: string, max = 24): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 && name.length - dot <= 6 ? name.slice(dot) : '';
  return `${name.slice(0, Math.max(1, max - extension.length - 1))}…${extension}`;
}

function frameWords(frames: readonly VideoFrame[]): string {
  if (frames.length === 2) return 'start and end images';
  return `${frames[0]} image`;
}

function sidesSentence(names: VideoInputNames, sides: VideoInputSides): string {
  const frames = sides.labels.frames.toLowerCase();
  const references = sides.labels.references.toLowerCase();
  return sides.references?.keepsStart
    ? `${names.model} takes a start and end image, or ${references} with a start image.`
    : `${names.model} takes ${frames} or ${references}, not both.`;
}

/**
 * What switching to `to` does to what the draft holds. Switching to references brings the
 * frames along as pictures where the model has room for them; switching to frames brings the
 * first pictures along as the free frames (the start image first, then the end image where the
 * model takes one), and clears the clips, tracks and other pictures. Nothing that would be
 * lost goes without a question.
 */
export function planVideoInputSwitch(
  sides: VideoInputSides,
  held: HeldVideoInputs,
  to: VideoInputSide,
  names: VideoInputNames,
): VideoInputSwitch {
  const none: VideoInputSwitch = { to, question: null, framesToReferences: [], framesCleared: [], picturesToFrames: [], clearsReferences: false };
  if (!sides.frames || !sides.references) return none;
  const label = (side: VideoInputSide) => sides.labels[side].toLowerCase();

  if (to === 'references') {
    const frames = framesOnly(sides, held);
    if (frames.length === 0) return none;
    const room = Math.max(0, sides.references.pictures - held.pictures);
    const moving = frames.slice(0, room);
    const cleared = frames.slice(moving.length);
    const nameOf = (frame: VideoFrame) => {
      const fileName = frame === 'start' ? names.start : names.end;
      return fileName ? shortFileName(fileName) : `the ${frame} image`;
    };
    const message = [
      sidesSentence(names, sides),
      moving.length > 0
        ? `Your ${frameWords(moving)} can come with you as ${moving.length === 1 ? 'a reference' : 'references'}.`
        : null,
      cleared.length > 0 ? `Your ${frameWords(cleared)} ${cleared.length === 1 ? 'is' : 'are'} cleared.` : null,
    ].filter(Boolean).join(' ');
    return {
      ...none,
      question: {
        title: `Switch to ${label('references')}?`,
        message,
        keepLabel: `Keep ${label('frames')}`,
        confirmLabel: moving.length === 1
          ? `Move ${nameOf(moving[0])} to ${label('references')}`
          : moving.length === 2 ? `Move both to ${label('references')}` : `Switch to ${label('references')}`,
      },
      framesToReferences: moving,
      framesCleared: cleared,
    };
  }

  if (!holdsReferences(held)) return none;
  const freeFrames: VideoFrame[] = [
    ...(sides.frames.start && !held.start ? ['start' as const] : []),
    ...(sides.frames.end && !held.end ? ['end' as const] : []),
  ];
  const moving = freeFrames.slice(0, held.pictures).map((frame, index) => ({ index, frame }));
  const handles = moving.map(({ index }) => names.pictures[index] ?? `picture ${index + 1}`);
  const left = held.pictures - moving.length + held.clips + held.tracks;
  const message = [
    sidesSentence(names, sides),
    moving.length === 1 ? `${handles[0]} can come with you as the ${moving[0].frame} image.` : null,
    moving.length === 2 ? `${handles[0]} and ${handles[1]} can come with you as the start and end images.` : null,
    left > 0
      ? moving.length > 0
        ? left === 1 ? 'The other reference is cleared.' : `The other ${left} references are cleared.`
        : left === 1 ? 'Your reference is cleared.' : `Your ${left} references are cleared.`
      : null,
  ].filter(Boolean).join(' ');
  return {
    ...none,
    question: {
      title: `Switch to ${label('frames')}?`,
      message,
      keepLabel: `Keep ${label('references')}`,
      confirmLabel: moving.length === 1
        ? `Move ${handles[0]} to ${label('frames')}`
        : moving.length === 2 ? `Move both to ${label('frames')}` : `Switch to ${label('frames')}`,
    },
    picturesToFrames: moving,
    clearsReferences: true,
  };
}

/** What the card says of frames a draft holds beside its references, which the run leaves out. */
export function framesLeftOutLine(frames: readonly VideoFrame[], labels: Record<VideoInputSide, string>): string {
  const one = frames.length === 1;
  return `Your ${frameWords(frames)} ${one ? 'is' : 'are'} kept for ${labels.frames}. This run uses your ${labels.references.toLowerCase()} and leaves ${one ? 'it' : 'them'} out.`;
}

/** The line under the switch: what the side shown does, in the artboards' words. */
export function videoInputsHint({
  view,
  sides,
  model,
  held,
  remixPictures,
}: {
  view: VideoInputView;
  sides: VideoInputSides;
  model: string;
  held: HeldVideoInputs;
  /** Pictures a remix brought back from its original, which Replace makes the creator's own. */
  remixPictures: number;
}): string | null {
  if (view.side === 'frames' && sides.frames) {
    const { end, startRequired } = sides.frames;
    if (held.start || held.end) {
      return end ? `${model} starts from the first image and ends on the last one you set.` : `${model} starts from the image you set.`;
    }
    if (startRequired) return `${model} needs a first image to start from.`;
    const base = end ? 'Optional. Set a first and last image' : 'Optional. Set a first image';
    return view.switchable
      ? `${base}, or switch to ${sides.labels.references} to bring in people and products by name.`
      : `${base}.`;
  }
  if (view.side === 'references' && sides.references) {
    const { pictures } = sides.references;
    if (pictures === 0) return null;
    const count = ` ${held.pictures} of ${pictures}.`;
    return remixPictures > 0
      ? `Replace the photos to make it yours. Each keeps its @handle, so the prompt still works.${count}`
      : `Type @ in the prompt, or tap a handle, to use a reference.${count}`;
  }
  return null;
}
