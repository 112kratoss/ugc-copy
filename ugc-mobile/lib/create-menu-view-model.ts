export type CreateMenuActionId = 'create' | 'post';

export interface CreateMenuAction {
  id: CreateMenuActionId;
  label: string;
  body: string;
  href: '/(tabs)/creator' | '/post/new';
}

export const CREATE_MENU_ACTIONS: CreateMenuAction[] = [
  {
    id: 'post',
    label: 'Post',
    body: 'Publish a post or unlockable',
    href: '/post/new',
  },
  {
    id: 'create',
    label: 'Create',
    body: 'Image, AI Video, and Motion',
    href: '/(tabs)/creator',
  },
];

export function getCreateMenuActionHref(id: CreateMenuActionId) {
  return CREATE_MENU_ACTIONS.find((action) => action.id === id)?.href ?? '/post/new';
}
