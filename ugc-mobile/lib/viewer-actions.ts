import type { CreatorToolId } from './types';

const SAVE_HEART_COLOR = '#fb7185';
const ENABLED_HEART_COLOR = '#ffffff';
const DISABLED_HEART_COLOR = 'rgba(255,255,255,0.5)';
const SAVE_HEART_HALO_COLOR = 'rgba(251,113,133,0.22)';

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
  enabled = true,
}: {
  willSave: boolean;
  enabled?: boolean;
}) {
  return {
    pressInScale: 0.96,
    peakScale: willSave ? 1.04 : 0.99,
    haloPeakScale: willSave ? 1.14 : 1.06,
    haloPeakOpacity: enabled ? (willSave ? 0.14 : 0.07) : 0,
    pressInDurationMs: 70,
    settleDurationMs: 220,
    haloColor: SAVE_HEART_HALO_COLOR,
  };
}

export type SaveHeartTapAnimationSpec = ReturnType<typeof getSaveHeartTapAnimationSpec>;

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
    default:
      return action.charAt(0).toUpperCase() + action.slice(1).replaceAll('-', ' ');
  }
}

export function isDestructiveViewerAction(action: string) {
  return action === 'unsave' || action === 'archive' || action === 'delete-post' || action === 'hide-creator';
}

export function getViewerActionGroupLabel(action: string) {
  if (action === 'not-interested' || action === 'hide-creator') {
    return 'Feed controls';
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
