import { router } from 'expo-router';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { NoticeCard, NoticePlacement, useAnnounceNotice, useScreenReaderRunning } from '@/components/notice-card';
import { SaverNoticeOverlay } from '@/components/saver-notice-overlay';
import { useOverlayPresence } from '@/lib/motion';
import {
  RECIPE_UNLOCKED_MESSAGE,
  RECIPE_UNLOCKED_NOTICE_MS,
  UNLOCKED_RECIPES_LABEL,
  UNLOCKED_RECIPES_PATH,
  dismissRecipeUnlockedNotice,
  readRecipeUnlockedNotice,
  subscribeToRecipeUnlockedNotice,
} from '@/lib/recipe-unlocked-notice';
import { viewerTopBadgeTop } from '@/lib/viewer-chrome';

/**
 * "Recipe unlocked", with Unlocked recipes as its action, after any unlock
 * (`lib/recipe-unlocked-notice.ts`). Mounted once at the root, above every
 * screen: the remix sheet goes straight on to the editor once it is paid, and
 * the notice is drawn over that. It sits where the saver notice does, below
 * the top control row of every screen, and on iOS above any presented Modal
 * (the same full-window overlay).
 *
 * It leaves by itself after five seconds, or at its action; with VoiceOver or
 * TalkBack running it waits for the action or the reader's Dismiss, as the
 * feed's Undo notice does.
 */
export function RecipeUnlockedNotice() {
  const notice = useSyncExternalStore(subscribeToRecipeUnlockedNotice, readRecipeUnlockedNotice, readRecipeUnlockedNotice);
  const insets = useSafeAreaInsets();
  const screenReaderRunning = useScreenReaderRunning();
  // Still drawn while it fades out once it is done.
  const presence = useOverlayPresence(Boolean(notice));
  const [shown, setShown] = useState(notice);
  if (notice && notice !== shown) setShown(notice);
  const id = notice?.id ?? null;

  useEffect(() => {
    if (id === null || screenReaderRunning) return undefined;
    const timer = setTimeout(() => dismissRecipeUnlockedNotice(id), RECIPE_UNLOCKED_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [id, screenReaderRunning]);

  useAnnounceNotice(id, notice ? RECIPE_UNLOCKED_MESSAGE : null);

  if (!presence.mounted || !shown) return null;

  const dismiss = () => {
    if (id !== null) dismissRecipeUnlockedNotice(id);
  };
  const openLibrary = () => {
    if (id === null) return;
    dismissRecipeUnlockedNotice(id);
    router.push(UNLOCKED_RECIPES_PATH as never);
  };

  return (
    <SaverNoticeOverlay>
      <NoticePlacement top={viewerTopBadgeTop(insets.top)}>
        <NoticeCard
          message={RECIPE_UNLOCKED_MESSAGE}
          active={id !== null}
          actionLabel={UNLOCKED_RECIPES_LABEL}
          onAction={openLibrary}
          onDismiss={dismiss}
          animatedStyle={presence.animatedStyle}
        />
      </NoticePlacement>
    </SaverNoticeOverlay>
  );
}
