export interface EditProfileFormSnapshot {
  username?: string | null;
  displayName?: string | null;
  bio?: string | null;
  avatarUrl?: string | null;
  coverUrl?: string | null;
}

export function hasEditProfileChanges({
  current,
  initial,
  hasAvatarDraft,
  hasCoverDraft,
}: {
  current: EditProfileFormSnapshot;
  initial: EditProfileFormSnapshot;
  hasAvatarDraft: boolean;
  hasCoverDraft: boolean;
}) {
  if (hasAvatarDraft || hasCoverDraft) return true;

  return (
    cleanField(current.username) !== cleanField(initial.username) ||
    cleanField(current.displayName) !== cleanField(initial.displayName) ||
    cleanField(current.bio) !== cleanField(initial.bio) ||
    cleanField(current.avatarUrl) !== cleanField(initial.avatarUrl) ||
    cleanField(current.coverUrl) !== cleanField(initial.coverUrl)
  );
}

function cleanField(value: string | null | undefined) {
  return value ?? '';
}
