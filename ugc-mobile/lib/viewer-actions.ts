export function getViewerActionLabel(action: string) {
  switch (action) {
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
  if (action === 'publish' || action === 'view-linked' || action === 'edit-linked' || action === 'edit-post' || action === 'change-visibility') {
    return 'Creation to post';
  }

  if (action === 'archive' || action === 'restore' || action === 'unsave') {
    return 'Library';
  }

  return 'Media actions';
}
