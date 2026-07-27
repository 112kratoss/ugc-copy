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
