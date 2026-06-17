const SAVE_HEART_COLOR = '#fb7185';
const ENABLED_HEART_COLOR = '#ffffff';
const DISABLED_HEART_COLOR = 'rgba(255,255,255,0.5)';

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
    case 'publish':
      return 'Post this creation';
    case 'archive':
      return 'Archive';
    case 'restore':
      return 'Restore';
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
    default:
      return action.charAt(0).toUpperCase() + action.slice(1).replaceAll('-', ' ');
  }
}

export function isDestructiveViewerAction(action: string) {
  return action === 'unsave' || action === 'archive';
}

export function getViewerActionGroupLabel(action: string) {
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

  if (action === 'archive' || action === 'restore' || action === 'unsave') {
    return 'Library';
  }

  return 'Media actions';
}
