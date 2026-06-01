export type CreateMenuActionId = 'create' | 'post';

export interface CreateMenuAction {
  id: CreateMenuActionId;
  label: string;
  body: string;
  href: '/(tabs)/creator' | '/post/new';
}

export const CREATE_MENU_ACTIONS: CreateMenuAction[] = [
  {
    id: 'create',
    label: 'Create',
    body: 'Image, AI Video, and Motion',
    href: '/(tabs)/creator',
  },
  {
    id: 'post',
    label: 'Post',
    body: 'Publish an existing creation',
    href: '/post/new',
  },
];

export function getCreateMenuActionHref(id: CreateMenuActionId) {
  return CREATE_MENU_ACTIONS.find((action) => action.id === id)?.href ?? '/(tabs)/creator';
}
