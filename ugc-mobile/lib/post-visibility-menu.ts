import { menuAction, type NativeMenuAction, type NativeMenuModel } from '@/lib/native-menu';
import type { PostLifecycleVisibility } from '@/lib/post-lifecycle-policy';

/**
 * Who can see a post, in the words the composer has always used. A post is
 * public or private: Unlisted was dropped (product decisions 2026-10-17), and
 * the server stores a requested unlisted as private.
 */
export const POST_VISIBILITY_CHOICES: ReadonlyArray<{
  value: Exclude<PostLifecycleVisibility, 'unlisted'>;
  label: string;
  body: string;
}> = [
  { value: 'public', label: 'Public', body: 'Visible in Explore and your profile.' },
  { value: 'private', label: 'Private', body: 'Only you can see it in Studio.' },
];

/**
 * The two choices as pick-one menu rows, the current one checked. Pull-down
 * buttons sends a list of mutually exclusive choices to a pop-up button, and
 * these are the rows one shows. Choosing the current value again changes
 * nothing. An old unlisted post reads as the private post its next save
 * makes it.
 */
export function postVisibilityChoices(
  current: PostLifecycleVisibility,
  onPick: (next: PostLifecycleVisibility) => void,
): NativeMenuAction[] {
  const shown = current === 'unlisted' ? 'private' : current;
  return POST_VISIBILITY_CHOICES.map((choice) => menuAction({
    id: `visibility-${choice.value}`,
    label: choice.label,
    subtitle: choice.body,
    checked: choice.value === shown,
    onSelect: () => {
      if (choice.value !== shown) onPick(choice.value);
    },
  }));
}

/** The composer's visibility button as a pop-up menu (`lib/native-menu.ts`). */
export function buildPostVisibilityMenu(
  current: PostLifecycleVisibility,
  onPick: (next: PostLifecycleVisibility) => void,
): NativeMenuModel {
  return {
    quickActions: [],
    sections: [{ id: 'visibility', title: 'Who can see this?', items: postVisibilityChoices(current, onPick) }],
  };
}
