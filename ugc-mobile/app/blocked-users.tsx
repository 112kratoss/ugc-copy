import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { CardListSkeleton } from '@/components/skeleton';
import {
  AppText,
  Card,
  CreatorAvatar,
  PrimaryButton,
  Screen,
  SecondaryButton,
  SectionTitle,
  StatusBlock,
} from '@/components/ui';
import type { BlockedUser } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import {
  BLOCKED_USERS_EMPTY_BODY,
  BLOCKED_USERS_EMPTY_TITLE,
  BLOCKED_USERS_MORE_NOTE,
  UNBLOCK_CONFIRM_MESSAGE,
  blockedUserDetailLines,
  blockedUserLabel,
  blockedUsersQueryKey,
  visibleBlockedUsers,
  withoutBlockedUser,
} from '@/lib/blocked-users-view-model';
import { showConfirmDialog, showErrorDialog } from '@/lib/dialog';
import { haptic } from '@/lib/haptics';

/**
 * Settings → Blocked users: whom the viewer has blocked, and the way to take a
 * block back. A blocked creator is left out of every feed, search and profile
 * that would show them, so until this screen a block could not be undone.
 */
export default function BlockedUsersScreen() {
  const { user, api } = useAuth();
  const queryClient = useQueryClient();
  const queryKey = blockedUsersQueryKey(user?.id);
  const listQuery = useQuery({
    queryKey,
    enabled: Boolean(user),
    queryFn: api.listBlockedUsers,
  });
  // The people whose unblock has been answered "yes". Their rows are left out
  // the moment the answer is given: a button that waits on the network reads as
  // a tap that did not land. Left out, not taken off the list: when the server
  // refuses, taking the id out again puts the row back in its place, whoever
  // else was unblocked meanwhile.
  const [unblockedIds, setUnblockedIds] = useState<ReadonlySet<string>>(() => new Set());
  const blockedUsers = listQuery.data ? visibleBlockedUsers(listQuery.data.blockedUsers, unblockedIds) : [];
  const unblock = async (blocked: BlockedUser) => {
    const listWasCut = Boolean(listQuery.data?.hasMore);
    const confirmed = await showConfirmDialog({
      title: `Unblock ${blockedUserLabel(blocked)}?`,
      message: UNBLOCK_CONFIRM_MESSAGE,
      confirmLabel: 'Unblock',
    });
    if (!confirmed) return;

    setUnblockedIds((current) => new Set(current).add(blocked.id));
    try {
      await api.unblockUser(blocked.id);
    } catch (error) {
      // Nobody was unblocked: the row is drawn again, where it was.
      haptic.error();
      setUnblockedIds((current) => {
        const next = new Set(current);
        next.delete(blocked.id);
        return next;
      });
      showErrorDialog('Could not unblock', error);
      return;
    }
    haptic.success();
    // The saved list agrees from now on, for the next time this screen opens.
    queryClient.setQueryData<Awaited<ReturnType<typeof api.listBlockedUsers>>>(
      queryKey,
      (current) => withoutBlockedUser(current, blocked.id),
    );
    await Promise.all([
      // Their posts may be drawn again: the lists a block emptied are read afresh.
      queryClient.invalidateQueries({ queryKey: ['showcase-feed'] }),
      queryClient.invalidateQueries({ queryKey: ['immersive-preview-source'] }),
      queryClient.invalidateQueries({ queryKey: ['profile-saved-media', user?.id] }),
      // A list cut at its limit has a place free now: it is read again for the
      // people blocked before the ones shown.
      ...(listWasCut ? [queryClient.invalidateQueries({ queryKey })] : []),
    ]);
  };

  return (
    <Screen>
      <SectionTitle
        eyebrow="Privacy"
        title="Blocked users."
        body="Someone you block cannot follow you, and their posts stay out of your feeds. Unblock them to undo that."
      />

      {!user ? (
        <>
          <StatusBlock title="Sign in to see whom you blocked" body="Blocks belong to your account." />
          <PrimaryButton label="Sign in" onPress={() => router.push('/auth' as never)} />
        </>
      ) : listQuery.isPending ? (
        <CardListSkeleton rows={3} label="Loading blocked users" />
      ) : listQuery.isError ? (
        <>
          <StatusBlock
            tone="danger"
            title="Could not load your blocked users"
            body={listQuery.error instanceof Error && listQuery.error.message
              ? listQuery.error.message
              : 'Check your connection, then try again.'}
          />
          <SecondaryButton label="Try again" onPress={() => void listQuery.refetch()} />
        </>
      ) : blockedUsers.length === 0 && listQuery.data.hasMore ? (
        // Every row shown has been unblocked, and the list was cut: there are
        // earlier blocks to read, so this is not the empty list.
        <CardListSkeleton rows={3} label="Loading blocked users" />
      ) : blockedUsers.length === 0 ? (
        <StatusBlock title={BLOCKED_USERS_EMPTY_TITLE} body={BLOCKED_USERS_EMPTY_BODY} />
      ) : (
        <>
          {blockedUsers.map((blocked) => (
            <Card key={blocked.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <CreatorAvatar uri={blocked.avatar} name={blocked.name} size={44} />
              <View style={{ flex: 1, gap: 2 }}>
                <AppText variant="cardTitle" numberOfLines={1}>{blocked.name}</AppText>
                {blockedUserDetailLines(blocked).map((line) => (
                  <AppText key={line} variant="bodySm" color="muted" numberOfLines={1}>{line}</AppText>
                ))}
              </View>
              <View style={{ flexShrink: 0 }}>
                <SecondaryButton
                  label="Unblock"
                  accessibilityHint={`Unblocks ${blockedUserLabel(blocked)}.`}
                  onPress={() => void unblock(blocked)}
                />
              </View>
            </Card>
          ))}
          {listQuery.data.hasMore ? (
            <AppText variant="caption" color="muted" style={{ textAlign: 'center' }}>
              {BLOCKED_USERS_MORE_NOTE}
            </AppText>
          ) : null}
        </>
      )}
    </Screen>
  );
}
