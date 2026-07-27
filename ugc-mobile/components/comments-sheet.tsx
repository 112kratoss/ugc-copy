import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { router } from 'expo-router';
import { MoreHorizontal, SendHorizontal } from 'lucide-react-native';
import { useCallback, useMemo, useState } from 'react';
import type React from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  type ModalProps,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';

import { CreatorAvatar, StatusBlock } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import {
  POST_COMMENTS_PAGE_SIZE,
  POST_COMMENT_MAX_LENGTH,
  applyCommentCountToInfiniteFeed,
  applyCommentCountToPostResponse,
  buildCommentThreads,
  canDeleteComment,
  canRemoveComment,
  canReportComment,
  createPostCommentRepliesQueryKey,
  createPostCommentsQueryKey,
  flattenCommentPages,
  getCommentDisplay,
  getCommentsPageParams,
  getNextCommentsPageOffset,
  incrementParentReplyCountInPages,
  markCommentRemovedInPages,
  prependCommentToPages,
  type CommentThreadRow,
  type PostCommentSort,
} from '@/lib/comments-view-model';
import { useReducedMotion } from '@/lib/motion';
import { appTheme } from '@/lib/theme';
import type {
  PostComment,
  PostCommentsResponse,
  ShowcaseFeedResponse,
  ShowcasePostResponse,
} from '@/lib/types';

const IS_TEST_ENVIRONMENT = typeof process !== 'undefined' && process.env.NODE_ENV === 'test';
const FallbackModal = ({ children, visible }: ModalProps) => (visible ? <>{children}</> : null);
const ModalSurface: React.ComponentType<ModalProps> = IS_TEST_ENVIRONMENT ? FallbackModal : Modal;

export function CommentsSheet({
  postId,
  postCreatorId,
  postTitle,
  commentCount,
  visible,
  onClose,
  onCommentCountChange,
}: {
  postId: string;
  postCreatorId: string | null;
  /** Anchors the sheet when it is opened as a text post's discussion. */
  postTitle?: string | null;
  commentCount: number;
  visible: boolean;
  onClose: () => void;
  onCommentCountChange?: (commentCount: number) => void;
}) {
  const reducedMotion = useReducedMotion();
  const queryClient = useQueryClient();
  const { api, user } = useAuth();

  const [sort] = useState<PostCommentSort>('top');
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<PostComment | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [submitting, setSubmitting] = useState(false);

  const commentsQueryKey = createPostCommentsQueryKey(postId, sort, user?.id);

  const commentsQuery = useInfiniteQuery({
    queryKey: commentsQueryKey,
    enabled: visible,
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api.listPostComments(
      postId,
      getCommentsPageParams({ offset: pageParam as number, sort, limit: POST_COMMENTS_PAGE_SIZE })
    ),
    getNextPageParam: getNextCommentsPageOffset,
  });

  const topLevel = useMemo(
    () => flattenCommentPages(commentsQuery.data?.pages),
    [commentsQuery.data?.pages]
  );

  const repliesByParent = useMemo(() => {
    const map: Record<string, PostComment[]> = {};
    for (const parentId of expandedIds) {
      const cached = queryClient.getQueryData<InfiniteData<PostCommentsResponse>>(
        createPostCommentRepliesQueryKey(postId, parentId, user?.id)
      );
      map[parentId] = flattenCommentPages(cached?.pages);
    }
    return map;
  }, [expandedIds, postId, queryClient, user?.id, commentsQuery.dataUpdatedAt]);

  const rows = useMemo(
    () => buildCommentThreads({ topLevel, repliesByParent, expandedIds }),
    [topLevel, repliesByParent, expandedIds]
  );

  const serverCommentCount = commentsQuery.data?.pages?.[0]?.commentCount ?? commentCount;
  const resolvedPostCreatorId = commentsQuery.data?.pages?.[0]?.postCreatorId ?? postCreatorId;

  const publishCommentCount = useCallback((nextCount: number) => {
    const result = { postId, commentCount: nextCount };

    queryClient.setQueriesData<InfiniteData<ShowcaseFeedResponse>>(
      { queryKey: ['showcase-feed'] },
      (current) => applyCommentCountToInfiniteFeed(current, result)
    );
    queryClient.setQueriesData<ShowcasePostResponse>(
      { queryKey: ['showcase-post', postId] },
      (current) => applyCommentCountToPostResponse(current, result)
    );
    onCommentCountChange?.(nextCount);
  }, [onCommentCountChange, postId, queryClient]);

  const requireSignIn = useCallback(() => {
    if (user) return true;
    onClose();
    router.push('/auth' as never);
    return false;
  }, [onClose, user]);

  const toggleReplies = useCallback(async (parentId: string) => {
    if (expandedIds.has(parentId)) {
      setExpandedIds((current) => {
        const next = new Set(current);
        next.delete(parentId);
        return next;
      });
      return;
    }

    const repliesKey = createPostCommentRepliesQueryKey(postId, parentId, user?.id);
    try {
      await queryClient.fetchInfiniteQuery({
        queryKey: repliesKey,
        initialPageParam: 0,
        queryFn: ({ pageParam }) => api.listPostComments(
          postId,
          getCommentsPageParams({ offset: pageParam as number, parentId })
        ),
      });
      setExpandedIds((current) => new Set(current).add(parentId));
    } catch (error) {
      Alert.alert('Could not load replies', error instanceof Error ? error.message : 'Please try again.');
    }
  }, [api, expandedIds, postId, queryClient, user?.id]);

  const submitComment = useCallback(async () => {
    const body = draft.trim();
    if (!body || submitting) return;
    if (!requireSignIn()) return;

    setSubmitting(true);
    try {
      const parentId = replyTo?.id ?? null;
      const response = await api.createPostComment(postId, { body, parentId });
      setDraft('');
      setReplyTo(null);

      if (parentId) {
        queryClient.setQueryData<InfiniteData<PostCommentsResponse>>(
          commentsQueryKey,
          (current) => incrementParentReplyCountInPages(current, parentId, 1)
        );
        await queryClient.invalidateQueries({
          queryKey: createPostCommentRepliesQueryKey(postId, parentId, user?.id),
        });
        setExpandedIds((current) => new Set(current).add(parentId));
      } else {
        queryClient.setQueryData<InfiniteData<PostCommentsResponse>>(
          commentsQueryKey,
          (current) => prependCommentToPages(current, response.comment, response.commentCount)
        );
      }

      publishCommentCount(response.commentCount);
    } catch (error) {
      Alert.alert('Could not post comment', error instanceof Error ? error.message : 'Please try again.');
    } finally {
      setSubmitting(false);
    }
  }, [api, commentsQueryKey, draft, postId, publishCommentCount, queryClient, replyTo, requireSignIn, submitting, user?.id]);

  const removeComment = useCallback((comment: PostComment, asOwner: boolean) => {
    Alert.alert(
      asOwner ? 'Remove this comment?' : 'Delete your comment?',
      asOwner
        ? 'It will be hidden from everyone viewing your post.'
        : 'Your comment will be replaced with “[deleted]”. Replies to it stay visible.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: asOwner ? 'Remove' : 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              const response = await api.deletePostComment(postId, comment.id);
              if (comment.parentId) {
                queryClient.setQueryData<InfiniteData<PostCommentsResponse>>(
                  createPostCommentRepliesQueryKey(postId, comment.parentId, user?.id),
                  (current) => markCommentRemovedInPages(current, comment.id, response.status, response.commentCount)
                );
                queryClient.setQueryData<InfiniteData<PostCommentsResponse>>(
                  commentsQueryKey,
                  (current) => incrementParentReplyCountInPages(current, comment.parentId!, -1)
                );
              } else {
                queryClient.setQueryData<InfiniteData<PostCommentsResponse>>(
                  commentsQueryKey,
                  (current) => markCommentRemovedInPages(current, comment.id, response.status, response.commentCount)
                );
              }
              publishCommentCount(response.commentCount);
            } catch (error) {
              Alert.alert('Could not remove comment', error instanceof Error ? error.message : 'Please try again.');
            }
          },
        },
      ]
    );
  }, [api, commentsQueryKey, postId, publishCommentCount, queryClient, user?.id]);

  const reportComment = useCallback((comment: PostComment) => {
    if (!requireSignIn()) return;
    Alert.alert(
      'Report this comment?',
      'Magicbooklet will send it to the moderation team for a safety review.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Report',
          style: 'destructive',
          onPress: async () => {
            try {
              await api.reportComment(comment.id, { reason: 'harassment' });
              Alert.alert('Thanks for the report', 'Our moderation team will take a look.');
            } catch (error) {
              Alert.alert('Could not report comment', error instanceof Error ? error.message : 'Please try again.');
            }
          },
        },
      ]
    );
  }, [api, requireSignIn]);

  const openCommentActions = useCallback((comment: PostComment) => {
    const options: Array<{ text: string; style?: 'cancel' | 'destructive'; onPress?: () => void }> = [];

    if (canDeleteComment(comment, user?.id)) {
      options.push({ text: 'Delete', style: 'destructive', onPress: () => removeComment(comment, false) });
    }
    if (canRemoveComment(comment, resolvedPostCreatorId, user?.id)) {
      options.push({ text: 'Remove from post', style: 'destructive', onPress: () => removeComment(comment, true) });
    }
    if (canReportComment(comment, user?.id)) {
      options.push({ text: 'Report', style: 'destructive', onPress: () => reportComment(comment) });
    }
    if (!options.length) return;

    Alert.alert('Comment options', undefined, [...options, { text: 'Cancel', style: 'cancel' }]);
  }, [removeComment, reportComment, resolvedPostCreatorId, user?.id]);

  const renderRow = useCallback(({ item }: { item: CommentThreadRow }) => {
    if (item.kind === 'replies-toggle') {
      return (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={item.expanded ? 'Hide replies' : `View ${item.replyCount} replies`}
          onPress={() => item.parentId && void toggleReplies(item.parentId)}
          style={({ pressed }) => ({
            minHeight: 44,
            justifyContent: 'center',
            paddingLeft: appTheme.spacing.panel + 33,
            paddingRight: appTheme.spacing.panel,
            opacity: pressed ? appTheme.opacity.pressed : 1,
          })}
        >
          <Text style={{ color: appTheme.colors.primary, ...appTheme.type.caption, fontWeight: '800' }}>
            {item.expanded ? 'Hide replies' : `View ${item.replyCount} ${item.replyCount === 1 ? 'reply' : 'replies'}`}
          </Text>
        </Pressable>
      );
    }

    const comment = item.comment!;
    const display = getCommentDisplay(comment);
    const isReply = item.kind === 'reply';

    return (
      <View
        style={{
          flexDirection: 'row',
          gap: appTheme.spacing.compact,
          paddingLeft: appTheme.spacing.panel + (isReply ? 33 : 0),
          paddingRight: appTheme.spacing.panel,
          paddingVertical: appTheme.spacing.gap,
        }}
      >
        <CreatorAvatar uri={comment.author?.avatarUrl ?? null} name={display.authorLabel} size={25} />
        <View style={{ flex: 1, gap: 3 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: appTheme.spacing.compact }}>
            <Text numberOfLines={1} style={{ color: appTheme.colors.textSecondary, ...appTheme.type.caption, fontWeight: '800', flexShrink: 1 }}>
              {display.authorLabel}
            </Text>
            <Text style={{ color: appTheme.colors.faint, ...appTheme.type.caption }}>{display.timeLabel}</Text>
          </View>
          <Text
            style={{
              color: display.isDeleted ? appTheme.colors.faint : appTheme.colors.text,
              ...appTheme.type.bodySm,
              fontStyle: display.isDeleted ? 'italic' : 'normal',
            }}
          >
            {display.bodyText}
          </Text>
          {display.isDeleted ? null : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Reply to ${display.authorLabel}`}
              onPress={() => requireSignIn() && setReplyTo(comment)}
              style={{ minHeight: 32, justifyContent: 'center' }}
            >
              <Text style={{ color: appTheme.colors.faint, ...appTheme.type.caption, fontWeight: '800' }}>Reply</Text>
            </Pressable>
          )}
        </View>
        {display.isDeleted ? null : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Comment options"
            hitSlop={10}
            onPress={() => openCommentActions(comment)}
            style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}
          >
            <MoreHorizontal size={16} color={appTheme.colors.faint} />
          </Pressable>
        )}
      </View>
    );
  }, [openCommentActions, requireSignIn, toggleReplies]);

  const canSubmit = draft.trim().length > 0 && !submitting;

  return (
    <ModalSurface
      animationType={reducedMotion ? 'none' : 'slide'}
      accessibilityViewIsModal
      onRequestClose={onClose}
      transparent
      visible={visible}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}
        style={{ flex: 1, justifyContent: 'flex-end' }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close comments"
          onPress={onClose}
          style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.58)' }}
        />
        <View
          style={{
            height: '78%',
            borderTopLeftRadius: appTheme.radii.xl,
            borderTopRightRadius: appTheme.radii.xl,
            borderCurve: 'continuous',
            borderWidth: 1,
            borderBottomWidth: 0,
            borderColor: appTheme.colors.borderStrong,
            backgroundColor: appTheme.colors.panel,
            paddingTop: appTheme.spacing.gap,
          }}
        >
          <View
            style={{
              width: 42,
              height: 4,
              borderRadius: 2,
              backgroundColor: appTheme.colors.borderStrong,
              alignSelf: 'center',
              marginBottom: appTheme.spacing.gap,
            }}
          />
          <View style={{ paddingHorizontal: appTheme.spacing.panel, paddingBottom: appTheme.spacing.compact, gap: 2 }}>
            {postTitle ? (
              <Text numberOfLines={2} style={{ color: appTheme.colors.muted, ...appTheme.type.caption, fontWeight: '800' }}>
                {postTitle}
              </Text>
            ) : null}
            <Text accessibilityRole="header" style={{ color: appTheme.colors.text, ...appTheme.type.cardTitle }}>
              {serverCommentCount > 0 ? `Comments · ${serverCommentCount}` : 'Comments'}
            </Text>
          </View>

          {commentsQuery.isError ? (
            <View style={{ padding: appTheme.spacing.panel }}>
              <StatusBlock
                tone="danger"
                title="Comments are unavailable"
                body="We could not load this conversation. Pull to try again."
              />
            </View>
          ) : (
            <FlatList
              data={rows}
              keyExtractor={(row) => row.key}
              renderItem={renderRow}
              keyboardShouldPersistTaps="handled"
              onEndReachedThreshold={0.4}
              onEndReached={() => {
                if (commentsQuery.hasNextPage && !commentsQuery.isFetchingNextPage) {
                  void commentsQuery.fetchNextPage();
                }
              }}
              ListEmptyComponent={commentsQuery.isLoading ? (
                <View style={{ paddingVertical: appTheme.spacing.section, alignItems: 'center' }}>
                  <ActivityIndicator color={appTheme.colors.faint} />
                </View>
              ) : (
                <View style={{ paddingVertical: appTheme.spacing.section, paddingHorizontal: appTheme.spacing.panel, gap: 4 }}>
                  <Text style={{ color: appTheme.colors.text, ...appTheme.type.body, fontWeight: '800' }}>
                    No comments yet
                  </Text>
                  <Text style={{ color: appTheme.colors.faint, ...appTheme.type.bodySm }}>
                    Be the first to share what you think about this post.
                  </Text>
                </View>
              )}
            />
          )}

          <View
            style={{
              borderTopWidth: 1,
              borderTopColor: appTheme.colors.borderStrong,
              paddingHorizontal: appTheme.spacing.panel,
              paddingTop: appTheme.spacing.gap,
              paddingBottom: 34,
              gap: appTheme.spacing.compact,
            }}
          >
            {replyTo ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: appTheme.spacing.compact }}>
                <Text numberOfLines={1} style={{ color: appTheme.colors.faint, ...appTheme.type.caption, flex: 1 }}>
                  {`Replying to ${getCommentDisplay(replyTo).authorLabel}`}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Cancel reply"
                  hitSlop={10}
                  onPress={() => setReplyTo(null)}
                  style={{ minHeight: 32, justifyContent: 'center' }}
                >
                  <Text style={{ color: appTheme.colors.primary, ...appTheme.type.caption, fontWeight: '800' }}>Cancel</Text>
                </Pressable>
              </View>
            ) : null}
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: appTheme.spacing.compact }}>
              <TextInput
                accessibilityLabel="Write a comment"
                value={draft}
                onChangeText={setDraft}
                editable={!submitting}
                maxLength={POST_COMMENT_MAX_LENGTH}
                multiline
                placeholder={replyTo ? 'Write a reply…' : 'Add a comment…'}
                placeholderTextColor={appTheme.colors.faint}
                onPressIn={() => { if (!user) requireSignIn(); }}
                style={{
                  flex: 1,
                  minHeight: 44,
                  maxHeight: 120,
                  borderRadius: appTheme.radii.md,
                  borderCurve: 'continuous',
                  borderWidth: 1,
                  borderColor: appTheme.colors.borderStrong,
                  backgroundColor: appTheme.colors.surface,
                  color: appTheme.colors.text,
                  paddingHorizontal: appTheme.spacing.gap,
                  paddingTop: 12,
                  paddingBottom: 12,
                  ...appTheme.type.bodySm,
                }}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Post comment"
                accessibilityState={{ disabled: !canSubmit }}
                disabled={!canSubmit}
                onPress={() => void submitComment()}
                style={({ pressed }) => ({
                  width: 44,
                  height: 44,
                  borderRadius: appTheme.radii.md,
                  borderCurve: 'continuous',
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: canSubmit ? appTheme.colors.primary : appTheme.colors.surface,
                  opacity: pressed ? appTheme.opacity.pressed : 1,
                })}
              >
                {submitting ? (
                  <ActivityIndicator color={appTheme.colors.onPrimary} />
                ) : (
                  <SendHorizontal
                    size={18}
                    color={canSubmit ? appTheme.colors.onPrimary : appTheme.colors.faint}
                  />
                )}
              </Pressable>
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>
    </ModalSurface>
  );
}
