import type { ImmersivePreviewItem } from './immersive-preview-view-model';
import type { CreatorToolId } from './types';

export const SAVE_HEART_COLOR = '#ff3b64';
const ENABLED_HEART_COLOR = '#ffffff';
const DISABLED_HEART_COLOR = 'rgba(255,255,255,0.5)';
const SAVE_HEART_HALO_COLOR = 'rgba(255,59,100,0.18)';

const DOUBLE_TAP_SAVE_HEART_PALETTES = [
  {
    startColor: '#ff2d8d',
    endColor: '#ff2d8d',
  },
  {
    startColor: '#ff5a24',
    endColor: '#ffb000',
  },
] as const;

const WEB_CREATE_PATH_TO_NATIVE_TOOL: Record<string, CreatorToolId> = {
  '/create-image': 'image',
  '/create-video': 'video',
  '/create-motion': 'motion',
  '/create/image': 'image',
  '/create/video': 'video',
  '/create/motion': 'motion',
};

function createPromptHref(tool: CreatorToolId, prompt?: string | null) {
  const trimmedPrompt = prompt?.trim();
  if (!trimmedPrompt) return null;
  return `/create/${tool}?prompt=${encodeURIComponent(trimmedPrompt)}`;
}

export function getNativeRemixCreateHref({
  redirectTo,
  recreateTool,
  prompt,
}: {
  redirectTo?: string | null;
  recreateTool: CreatorToolId;
  prompt?: string | null;
}) {
  if (redirectTo) {
    try {
      const url = new URL(redirectTo, 'https://magicbooklet.local');
      const remixId = url.searchParams.get('remix');
      const nativeTool = WEB_CREATE_PATH_TO_NATIVE_TOOL[url.pathname];
      if (remixId && nativeTool) {
        const params = new URLSearchParams({ remix: remixId });
        const remixPost = url.searchParams.get('remixPost');
        if (remixPost) params.set('remixPost', remixPost);
        return `/create/${nativeTool}?${params.toString()}`;
      }
    } catch {
      return createPromptHref(recreateTool, prompt);
    }
  }

  return createPromptHref(recreateTool, prompt);
}

export function getSaveHeartIconProps({
  isSaved,
  enabled = true,
}: {
  isSaved: boolean;
  enabled?: boolean;
}) {
  const activeColor = isSaved ? SAVE_HEART_COLOR : enabled ? ENABLED_HEART_COLOR : DISABLED_HEART_COLOR;

  return {
    color: activeColor,
    fill: isSaved ? SAVE_HEART_COLOR : 'transparent',
    strokeWidth: 2.6,
  };
}

export function getSaveHeartTapAnimationSpec({
  willSave,
}: {
  willSave: boolean;
  enabled?: boolean;
}) {
  return {
    pressInScale: willSave ? 0.88 : 0.94,
    peakScale: willSave ? 1.1 : 0.98,
    haloPeakScale: 1,
    haloPeakOpacity: 0,
    pressInDurationMs: 65,
    settleDurationMs: 230,
    haloColor: SAVE_HEART_HALO_COLOR,
  };
}

export type SaveHeartTapAnimationSpec = ReturnType<typeof getSaveHeartTapAnimationSpec>;

export function canSaveViewerItemOnDoubleTap({
  canSave,
  isSaved,
  saveLoading,
}: {
  canSave: boolean;
  isSaved: boolean;
  saveLoading: boolean;
}) {
  return canSave && !isSaved && !saveLoading;
}

export function getDoubleTapSaveHeartAnimationSpec(reducedMotion: boolean) {
  return reducedMotion
    ? {
        startScale: 1,
        peakScale: 1,
        settleScale: 1,
        restingScale: 1,
        exitScale: 1,
        entryDurationMs: 0,
        settleDurationMs: 0,
        reboundDurationMs: 0,
        holdDurationMs: 320,
        exitDurationMs: 180,
      }
    : {
        startScale: 0.22,
        peakScale: 1.08,
        settleScale: 0.86,
        restingScale: 0.92,
        exitScale: 0.16,
        entryDurationMs: 120,
        settleDurationMs: 90,
        reboundDurationMs: 60,
        holdDurationMs: 650,
        exitDurationMs: 170,
      };
}

export function getDoubleTapSaveHeartPalette(playCount: number) {
  const normalizedPlayCount = Number.isFinite(playCount)
    ? Math.max(0, Math.floor(playCount))
    : 0;
  return DOUBLE_TAP_SAVE_HEART_PALETTES[
    normalizedPlayCount % DOUBLE_TAP_SAVE_HEART_PALETTES.length
  ];
}

export function getDoubleTapSaveHeartPosition({
  x,
  y,
  width,
  height,
  heartSize,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  heartSize: number;
}) {
  const halfHeart = Math.max(0, heartSize / 2);
  const maxX = Math.max(halfHeart, width - halfHeart);
  const maxY = Math.max(halfHeart, height - halfHeart);

  return {
    x: Math.min(maxX, Math.max(halfHeart, x)),
    y: Math.min(maxY, Math.max(halfHeart, y)),
  };
}

export function getRailActionOpacity({
  disabled,
  pressed,
  showAsActive,
}: {
  disabled?: boolean;
  pressed?: boolean;
  showAsActive?: boolean;
}) {
  if (disabled && !showAsActive) {
    return 0.42;
  }

  return pressed ? 0.72 : 1;
}

export function getViewerActionLabel(action: string) {
  switch (action) {
    case 'save':
      return 'Save';
    case 'unsave':
      return 'Unsave';
    case 'comment':
      return 'Comments';
    case 'share':
      return 'Share';
    case 'recreate':
      return 'Recreate / Remix';
    case 'unlock-remix':
      return 'Remix';
    case 'publish':
      return 'Post this creation';
    case 'archive':
      return 'Archive';
    case 'restore':
      return 'Restore';
    case 'delete-post':
      return 'Delete permanently';
    case 'edit-post':
      return 'Edit post';
    case 'change-visibility':
      return 'Change visibility';
    case 'view-linked':
      return 'View linked post';
    case 'edit-linked':
      return 'Edit linked post';
    case 'edit-linked-resources':
      return 'Manage unlock';
    case 'make-private':
      return 'Make private';
    case 'make-public':
      return 'Make public';
    case 'open-original':
      return 'Open original post';
    case 'view-details':
      return 'View details';
    case 'download':
      return 'Download media';
    case 'not-interested':
      return 'Not interested';
    case 'hide-creator':
      return 'Hide this creator';
    case 'report-content':
      return 'Report content';
    case 'report-user':
      return 'Report user';
    case 'block-user':
      return 'Block user';
    case 'report-ai-output':
      return 'Report offensive AI output';
    default:
      return action.charAt(0).toUpperCase() + action.slice(1).replaceAll('-', ' ');
  }
}

export function isDestructiveViewerAction(action: string) {
  return action === 'unsave'
    || action === 'archive'
    || action === 'delete-post'
    || action === 'hide-creator'
    || action === 'report-content'
    || action === 'report-user'
    || action === 'block-user'
    || action === 'report-ai-output';
}

export function getViewerActionGroupLabel(action: string) {
  if (action === 'report-content' || action === 'report-user' || action === 'block-user' || action === 'report-ai-output') {
    return 'Safety';
  }
  if (action === 'not-interested' || action === 'hide-creator') {
    return 'Showcase preferences';
  }
  if (
    action === 'publish'
    || action === 'view-linked'
    || action === 'edit-linked'
    || action === 'edit-linked-resources'
    || action === 'make-private'
    || action === 'make-public'
    || action === 'edit-post'
    || action === 'change-visibility'
  ) {
    return 'Creation to post';
  }

  if (action === 'archive' || action === 'restore' || action === 'unsave' || action === 'delete-post') {
    return 'Library';
  }

  return 'Media actions';
}

/**
 * Which actions a viewer surface offers for an item. The reel renders these as a
 * right rail and the profile card feed renders them as an action row, but the
 * policy is one function so the two surfaces can never disagree about what a
 * creation or post can do.
 *
 * The contextual positions vary by what the item actually is:
 * contextual ones depends on what the item actually is. Saved showcase media leads
 * with save/comment; owned media leads with the ownership action that matters for
 * its current state, so publishing or flipping visibility stays one tap away
 * instead of being buried in the More sheet.
 *
 * A slot is only emitted when its action is genuinely available, so the rail never
 * renders a dead button — an absent slot collapses and the rail closes up.
 */
export type ViewerActionSlotId =
  | 'save'
  | 'comment'
  | 'share'
  | 'details'
  | 'create'
  | 'publish'
  | 'visibility'
  | 'unlock';

export interface ViewerActionSlot {
  id: ViewerActionSlotId;
  /** The `ViewerActionSheet` action this slot delegates to, when it maps to one. */
  action?: string;
  /**
   * Rail labels sit in a ~64pt column, so they stay to a single short word and let
   * the icon and the state chip carry the rest. `a11yLabel` keeps the full phrasing
   * for screen readers, where nothing is truncated.
   */
  label: string;
  a11yLabel?: string;
  tone?: 'default' | 'primary' | 'success' | 'warning';
}

export function getViewerActionSlots(item: ImmersivePreviewItem): ViewerActionSlot[] {
  const available = new Set(item.availableActions);
  const slots: ViewerActionSlot[] = [];

  if (item.sourceType === 'generation') {
    // A creation's headline question is "is this published, and where?".
    if (available.has('publish')) {
      slots.push({
        id: 'publish',
        action: 'publish',
        label: 'Publish',
        a11yLabel: 'Publish this creation',
        tone: 'primary',
      });
    }
    if (available.has('make-private')) {
      slots.push({
        id: 'visibility',
        action: 'make-private',
        label: 'Private',
        a11yLabel: 'Make linked post private',
        tone: 'warning',
      });
    } else if (available.has('make-public')) {
      slots.push({
        id: 'visibility',
        action: 'make-public',
        label: 'Public',
        a11yLabel: 'Make linked post public',
        tone: 'success',
      });
    }
    if (available.has('edit-linked-resources')) {
      slots.push({
        id: 'unlock',
        action: 'edit-linked-resources',
        label: 'Unlock',
        a11yLabel: item.linkedPostBundle ? 'Manage unlock bundle' : 'Add an unlock bundle',
        tone: 'success',
      });
    }
  } else if (item.sourceType === 'owner-post') {
    // An owned post is already published, so visibility is the lead control. The state
    // chip reports where it currently sits, so the button names the action instead.
    if (available.has('change-visibility')) {
      slots.push({
        id: 'visibility',
        action: 'change-visibility',
        label: 'Visibility',
        a11yLabel: 'Change who can see this post',
        tone: item.visibility === 'public' ? 'success' : 'warning',
      });
    }
  } else if (item.canSave) {
    slots.push({ id: 'save', action: item.isSaved ? 'unsave' : 'save', label: item.isSaved ? 'Saved' : item.saveLabel });
  }

  if (item.canComment) {
    slots.push({
      id: 'comment',
      action: 'comment',
      label: item.commentCount > 0 ? item.commentLabel : 'Comment',
    });
  }
  if (item.canShare) {
    slots.push({ id: 'share', action: 'share', label: 'Share' });
  }
  slots.push({ id: 'details', action: 'view-details', label: 'Details' });

  if (available.has('unlock-remix')) {
    slots.push({ id: 'create', action: 'unlock-remix', label: 'Remix', tone: 'primary' });
  } else if (available.has('recreate')) {
    slots.push({ id: 'create', action: 'recreate', label: 'Create', tone: 'primary' });
  }

  return slots;
}

export type ViewerStateTone = 'neutral' | 'success' | 'warning' | 'danger';

/**
 * The publish/visibility state of owned media, surfaced next to the badge pill.
 * Showcase items return null — their badge already says everything the viewer
 * needs, and a second pill would just be noise.
 */
export function getViewerStateChip(
  item: ImmersivePreviewItem
): { label: string; tone: ViewerStateTone } | null {
  if (item.archivedAt) {
    return { label: 'Archived', tone: 'danger' };
  }

  if (item.sourceType === 'generation') {
    if (!item.linkedPostId) return { label: 'Not posted', tone: 'neutral' };
    if (item.linkedPostVisibility === 'public') return { label: 'Public post', tone: 'success' };
    if (item.linkedPostVisibility === 'private') return { label: 'Private post', tone: 'warning' };
    if (item.linkedPostVisibility === 'unlisted') return { label: 'Unlisted post', tone: 'warning' };
    return { label: 'Linked post', tone: 'neutral' };
  }

  if (item.sourceType === 'owner-post') {
    if (item.visibility === 'public') return { label: 'Public post', tone: 'success' };
    if (item.visibility === 'private') return { label: 'Private post', tone: 'warning' };
    if (item.visibility === 'unlisted') return { label: 'Unlisted post', tone: 'warning' };
    return { label: 'Published post', tone: 'neutral' };
  }

  return null;
}
