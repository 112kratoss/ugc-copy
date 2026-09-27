import { menuAction, type NativeMenuAction, type NativeMenuModel } from '@/lib/native-menu';
import type { PostLifecycleVisibility } from '@/lib/post-lifecycle-policy';

/** Who can see a post, in the words the composer has always used. */
export const POST_VISIBILITY_CHOICES: ReadonlyArray<{
  value: PostLifecycleVisibility;
  label: string;
  body: string;
}> = [
  { value: 'public', label: 'Public', body: 'Visible in Explore and your profile.' },
  { value: 'unlisted', label: 'Unlisted', body: 'Only people with the link can open it.' },
  { value: 'private', label: 'Private', body: 'Only you can see it in Studio.' },
];

/**
 * The three choices as pick-one menu rows, the current one checked. Pull-down
 * buttons sends a list of mutually exclusive choices to a pop-up button, and
 * these are the rows one shows. Choosing the current value again changes
 * nothing.
 */
export function postVisibilityChoices(
  current: PostLifecycleVisibility,
  onPick: (next: PostLifecycleVisibility) => void,
): NativeMenuAction[] {
  return POST_VISIBILITY_CHOICES.map((choice) => menuAction({
    id: `visibility-${choice.value}`,
    label: choice.label,
    subtitle: choice.body,
    checked: choice.value === current,
    onSelect: () => {
      if (choice.value !== current) onPick(choice.value);
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
