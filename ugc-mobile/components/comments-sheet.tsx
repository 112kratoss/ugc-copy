import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { router } from 'expo-router';
import { MoreHorizontal, SendHorizontal } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CreatorAvatar, StatusBlock } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import {
  POST_COMMENTS_PAGE_SIZE,
  POST_COMMENT_MAX_LENGTH,
  applyCommentCountToInfiniteFeed,
  applyCommentCountToPostResponse,
  appendReplyToPages,
  canDeleteComment,
  canRemoveComment,
  canReportComment,
  createPostCommentRepliesQueryKey,
  createPostCommentsQueryKey,
  flattenCommentPages,
  getCommentAuthReturnTo,
  getCommentDisplay,
  getCommentsPageParams,
  getNextCommentsPageOffset,
  incrementParentReplyCountInPages,
  keepFirstCommentPage,
  markCommentRemovedInPages,
  mergeRepliesWithPending,
  prependCommentToPages,
  suspendCommentPagination,
  type PostCommentSort,
} from '@/lib/comments-view-model';
import { useReducedMotion } from '@/lib/motion';
import { resolvedBottomInset } from '@/lib/safe-area';
import { appTheme } from '@/lib/theme';
import type { CommentReportReason } from '@/lib/api-client';
import type {
  PostComment,
  PostCommentsResponse,
  ShowcaseFeedResponse,
  ShowcasePostResponse,
} from '@/lib/types';

const IS_TEST_ENVIRONMENT = typeof process !== 'undefined' && process.env.NODE_ENV === 'test';
const FallbackModal = ({ children, visible }: ModalProps) => (visible ? <>{children}</> : null);
const ModalSurface: React.ComponentType<ModalProps> = IS_TEST_ENVIRONMENT ? FallbackModal : Modal;
const REPORT_REASONS: Array<{ label: string; value: CommentReportReason }> = [
  { label: 'Spam or misleading', value: 'spam' },
  { label: 'Harassment or bullying', value: 'harassment' },
  { label: 'Unsafe content', value: 'unsafe_content' },
  { label: 'Something else', value: 'other' },
];

type CommentActionHandler = (comment: PostComment) => void;

export function CommentsSheet({
  postId,
  postCreatorId,
  postTitle,
  commentCount,
  visible,
  onClose,
  onCommentCountChange,
  authReturnTo,
  initialReplyToId,
}: {
  postId: string;
  postCreatorId: string | null;
  /** Anchors the sheet when it is opened as a text post's discussion. */
  postTitle?: string | null;
  commentCount: number;
  visible: boolean;
  onClose: () => void;
  onCommentCountChange?: (commentCount: number) => void;
  /** Route restored after sign-in; the sheet adds its post/reply context. */
  authReturnTo?: string;
  initialReplyToId?: string | null;
}) {
  const reducedMotion = useReducedMotion();
  const queryClient = useQueryClient();
  const { api, user } = useAuth();
  const insets = useSafeAreaInsets();
  const bottomInset = resolvedBottomInset(insets.bottom);

  const [sort] = useState<PostCommentSort>('top');
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<PostComment | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [pendingRepliesByParent, setPendingRepliesByParent] = useState<Record<string, PostComment[]>>({});
  const [reportingComment, setReportingComment] = useState<PostComment | null>(null);
  const [reporting, setReporting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const restoredReplyIdRef = useRef<string | null>(null);

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

  useEffect(() => {
    setDraft('');
    setReplyTo(null);
    setExpandedIds(new Set());
    setPendingRepliesByParent({});
    setReportingComment(null);
    setReporting(false);
    restoredReplyIdRef.current = null;
  }, [postId]);

  useEffect(() => {
    if (
      !visible
      || !initialReplyToId
      || restoredReplyIdRef.current === initialReplyToId
    ) {
      return;
    }
    const comment = topLevel.find((item) => item.id === initialReplyToId && !item.parentId);
    if (!comment) {
      if (commentsQuery.hasNextPage && !commentsQuery.isFetchingNextPage) {
        void commentsQuery.fetchNextPage();
      }
      return;
    }
    restoredReplyIdRef.current = initialReplyToId;
    setReplyTo(comment);
  }, [
    commentsQuery.fetchNextPage,
    commentsQuery.hasNextPage,
    commentsQuery.isFetchingNextPage,
    initialReplyToId,
    topLevel,
    visible,
  ]);

  const serverCommentCount = commentsQuery.data?.pages?.[0]?.commentCount ?? commentCount;
  const resolvedPostCreatorId = commentsQuery.data?.pages?.[0]?.postCreatorId ?? postCreatorId;
  const commentsUnavailable = commentsQuery.isError && !commentsQuery.data?.pages?.length;

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

  const requireSignIn = useCallback((replyComment?: PostComment | null) => {
    if (user) return true;
    const rootReplyId = replyComment
      ? replyComment.parentId ?? replyComment.id
      : null;
    onClose();
    router.push({
      pathname: '/auth',
      params: {
        returnTo: getCommentAuthReturnTo(authReturnTo, postId, rootReplyId),
      },
    } as never);
    return false;
  }, [authReturnTo, onClose, postId, user]);

  const toggleReplies = useCallback((parentId: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(parentId)) next.delete(parentId);
      else next.add(parentId);
      return next;
    });
  }, []);

  const submitComment = useCallback(async () => {
    const body = draft.trim();
    if (!body || submitting) return;
    if (!requireSignIn(replyTo)) return;

    setSubmitting(true);
    try {
      // The product exposes one reply level. Normalizing here also protects
      // restored/stale reply targets while the server enforces the same rule.
      const parentId = replyTo
        ? replyTo.parentId ?? replyTo.id
        : null;
      const response = await api.createPostComment(postId, { body, parentId });
      setDraft('');
      setReplyTo(null);

      if (parentId) {
        queryClient.setQueryData<InfiniteData<PostCommentsResponse>>(
          commentsQueryKey,
          (current) => suspendCommentPagination(
            incrementParentReplyCountInPages(current, parentId, 1, response.commentCount)
          )
        );
        const repliesKey = createPostCommentRepliesQueryKey(postId, parentId, user?.id);
        queryClient.setQueryData<InfiniteData<PostCommentsResponse>>(
          repliesKey,
          (current) => appendReplyToPages(current, response.comment, response.commentCount)
        );
        setPendingRepliesByParent((current) => ({
          ...current,
          [parentId]: [
            ...(current[parentId] ?? []).filter((comment) => comment.id !== response.comment.id),
            response.comment,
          ],
        }));
        setExpandedIds((current) => new Set(current).add(parentId));
        void commentsQuery.refetch();
      } else {
        queryClient.setQueryData<InfiniteData<PostCommentsResponse>>(
          commentsQueryKey,
          (current) => keepFirstCommentPage(
            prependCommentToPages(current, response.comment, response.commentCount)
          )
        );
        void commentsQuery.refetch();
      }

      publishCommentCount(response.commentCount);
    } catch (error) {
      Alert.alert('Could not post comment', error instanceof Error ? error.message : 'Please try again.');
    } finally {
      setSubmitting(false);
    }
  }, [api, commentsQuery, commentsQueryKey, draft, postId, publishCommentCount, queryClient, replyTo, requireSignIn, submitting, user?.id]);

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
                const repliesKey = createPostCommentRepliesQueryKey(postId, comment.parentId, user?.id);
                queryClient.setQueryData<InfiniteData<PostCommentsResponse>>(
                  repliesKey,
                  (current) => suspendCommentPagination(
                    markCommentRemovedInPages(current, comment.id, response.status, response.commentCount)
                  )
                );
                setPendingRepliesByParent((current) => ({
                  ...current,
                  [comment.parentId!]: (current[comment.parentId!] ?? [])
                    .filter((reply) => reply.id !== comment.id),
                }));
                queryClient.setQueryData<InfiniteData<PostCommentsResponse>>(
                  commentsQueryKey,
                  (current) => suspendCommentPagination(
                    incrementParentReplyCountInPages(
                      current,
                      comment.parentId!,
                      -1,
                      response.commentCount
                    )
                  )
                );
                void queryClient.invalidateQueries({ queryKey: repliesKey, refetchType: 'active' });
              } else {
                queryClient.setQueryData<InfiniteData<PostCommentsResponse>>(
                  commentsQueryKey,
                  (current) => suspendCommentPagination(
                    markCommentRemovedInPages(current, comment.id, response.status, response.commentCount)
                  )
                );
              }
              void commentsQuery.refetch();
              publishCommentCount(response.commentCount);
            } catch (error) {
              Alert.alert('Could not remove comment', error instanceof Error ? error.message : 'Please try again.');
            }
          },
        },
      ]
    );
  }, [api, commentsQuery, commentsQueryKey, postId, publishCommentCount, queryClient, user?.id]);

  const reportComment = useCallback((comment: PostComment) => {
    if (!requireSignIn()) return;
    setReportingComment(comment);
  }, [requireSignIn]);

  const submitReport = useCallback(async (reason: CommentReportReason) => {
    if (!reportingComment || reporting) return;
    setReporting(true);
    try {
      await api.reportComment(reportingComment.id, { reason });
      setReportingComment(null);
      Alert.alert('Thanks for the report', 'Our moderation team will take a look.');
    } catch (error) {
      Alert.alert('Could not report comment', error instanceof Error ? error.message : 'Please try again.');
    } finally {
      setReporting(false);
    }
  }, [api, reporting, reportingComment]);

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

  const hasCommentActions = useCallback((comment: PostComment) => (
    canDeleteComment(comment, user?.id)
    || canRemoveComment(comment, resolvedPostCreatorId, user?.id)
    || canReportComment(comment, user?.id)
  ), [resolvedPostCreatorId, user?.id]);

  const renderTopLevelComment = useCallback(({ item: comment }: { item: PostComment }) => {
    const expanded = expandedIds.has(comment.id);
    return (
      <View>
        <CommentRowView
          comment={comment}
          onActions={hasCommentActions(comment) ? openCommentActions : undefined}
          onReply={(nextComment) => {
            if (requireSignIn(nextComment)) setReplyTo(nextComment);
          }}
        />
        {expanded ? (
          <RepliesList
            parentId={comment.id}
            pendingReplies={pendingRepliesByParent[comment.id] ?? []}
            postId={postId}
            hasActions={hasCommentActions}
            onActions={openCommentActions}
          />
        ) : null}
        {comment.replyCount > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={expanded ? 'Hide replies' : `View ${comment.replyCount} replies`}
            onPress={() => toggleReplies(comment.id)}
            style={({ pressed }) => ({
              minHeight: 48,
              justifyContent: 'center',
              paddingLeft: appTheme.spacing.panel + 33,
              paddingRight: appTheme.spacing.panel,
              opacity: pressed ? appTheme.opacity.pressed : 1,
            })}
          >
            <Text style={{ color: appTheme.colors.primary, ...appTheme.type.caption, fontWeight: '800' }}>
              {expanded
                ? 'Hide replies'
                : `View ${comment.replyCount} ${comment.replyCount === 1 ? 'reply' : 'replies'}`}
            </Text>
          </Pressable>
        ) : null}
      </View>
    );
  }, [expandedIds, hasCommentActions, openCommentActions, pendingRepliesByParent, postId, requireSignIn, toggleReplies]);

  const canSubmit = draft.trim().length > 0 && !submitting && !commentsUnavailable;

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

          {commentsUnavailable ? (
            <View style={{ flex: 1, padding: appTheme.spacing.panel, gap: appTheme.spacing.gap }}>
              <StatusBlock
                tone="danger"
                title="Comments are unavailable"
                body="We could not load this conversation. Check your connection, then try again."
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Try loading comments again"
                accessibilityState={{ busy: commentsQuery.isRefetching }}
                disabled={commentsQuery.isRefetching}
                onPress={() => void commentsQuery.refetch()}
                style={({ pressed }) => ({
                  minHeight: 48,
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: appTheme.radii.md,
                  backgroundColor: appTheme.colors.primary,
                  opacity: pressed ? appTheme.opacity.pressed : 1,
                })}
              >
                {commentsQuery.isRefetching ? (
                  <ActivityIndicator color={appTheme.colors.onPrimary} />
                ) : (
                  <Text style={{ color: appTheme.colors.onPrimary, ...appTheme.type.bodySm, fontWeight: '800' }}>
                    Try again
                  </Text>
                )}
              </Pressable>
            </View>
          ) : (
            <FlatList
              data={topLevel}
              keyExtractor={(comment) => comment.id}
              renderItem={renderTopLevelComment}
              keyboardShouldPersistTaps="handled"
              onRefresh={() => void commentsQuery.refetch()}
              refreshing={commentsQuery.isRefetching && !commentsQuery.isFetchingNextPage}
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
              ListFooterComponent={commentsQuery.isFetchingNextPage ? (
                <View style={{ minHeight: 48, alignItems: 'center', justifyContent: 'center' }}>
                  <ActivityIndicator color={appTheme.colors.faint} />
                </View>
              ) : null}
            />
          )}

          <View
            style={{
              borderTopWidth: 1,
              borderTopColor: appTheme.colors.borderStrong,
              paddingHorizontal: appTheme.spacing.panel,
              paddingTop: appTheme.spacing.gap,
              paddingBottom: Math.max(bottomInset, appTheme.spacing.panel),
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
                  onPress={() => setReplyTo(null)}
                  style={{ minWidth: 48, minHeight: 48, alignItems: 'flex-end', justifyContent: 'center' }}
                >
                  <Text style={{ color: appTheme.colors.primary, ...appTheme.type.caption, fontWeight: '800' }}>Cancel</Text>
                </Pressable>
              </View>
            ) : null}
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: appTheme.spacing.compact }}>
              <TextInput
                accessibilityLabel="Write a comment"
                accessibilityHint={commentsUnavailable ? 'Retry loading comments before posting.' : undefined}
                value={draft}
                onChangeText={setDraft}
                editable={!submitting && !commentsUnavailable}
                maxLength={POST_COMMENT_MAX_LENGTH}
                multiline
                placeholder={replyTo ? 'Write a reply…' : 'Add a comment…'}
                placeholderTextColor={appTheme.colors.faint}
                onPressIn={() => { if (!user) requireSignIn(replyTo); }}
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
          {reportingComment ? (
            <ReportReasonPicker
              bottomInset={bottomInset}
              loading={reporting}
              onCancel={() => {
                if (!reporting) setReportingComment(null);
              }}
              onSelect={(reason) => void submitReport(reason)}
            />
          ) : null}
        </View>
      </KeyboardAvoidingView>
    </ModalSurface>
  );
}

function RepliesList({
  parentId,
  pendingReplies,
  postId,
  hasActions,
  onActions,
}: {
  parentId: string;
  pendingReplies: PostComment[];
  postId: string;
  hasActions: (comment: PostComment) => boolean;
  onActions: CommentActionHandler;
}) {
  const { api, user } = useAuth();
  const repliesQuery = useInfiniteQuery({
    queryKey: createPostCommentRepliesQueryKey(postId, parentId, user?.id),
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api.listPostComments(
      postId,
      getCommentsPageParams({
        offset: pageParam as number,
        parentId,
        limit: POST_COMMENTS_PAGE_SIZE,
      })
    ),
    getNextPageParam: getNextCommentsPageOffset,
  });
  const replies = useMemo(
    () => mergeRepliesWithPending(repliesQuery.data?.pages, pendingReplies),
    [pendingReplies, repliesQuery.data?.pages]
  );

  if (repliesQuery.isLoading && !replies.length) {
    return (
      <View
        accessibilityLabel="Loading replies"
        style={{ minHeight: 48, paddingLeft: appTheme.spacing.panel + 33, justifyContent: 'center' }}
      >
        <ActivityIndicator color={appTheme.colors.faint} />
      </View>
    );
  }

  return (
    <View>
      {replies.map((reply) => (
        <CommentRowView
          key={reply.id}
          comment={reply}
          isReply
          onActions={hasActions(reply) ? onActions : undefined}
        />
      ))}
      {repliesQuery.isError ? (
        <View
          style={{
            paddingLeft: appTheme.spacing.panel + 33,
            paddingRight: appTheme.spacing.panel,
            paddingBottom: appTheme.spacing.compact,
            gap: appTheme.spacing.compact,
          }}
        >
          <Text accessibilityRole="alert" style={{ color: appTheme.semantic.danger.foreground, ...appTheme.type.caption }}>
            Some replies could not be loaded.
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Try loading replies again"
            onPress={() => void repliesQuery.refetch()}
            style={({ pressed }) => ({
              alignSelf: 'flex-start',
              minHeight: 48,
              justifyContent: 'center',
              opacity: pressed ? appTheme.opacity.pressed : 1,
            })}
          >
            <Text style={{ color: appTheme.colors.primary, ...appTheme.type.caption, fontWeight: '800' }}>
              Try again
            </Text>
          </Pressable>
        </View>
      ) : null}
      {repliesQuery.hasNextPage ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Load more replies"
          accessibilityState={{ busy: repliesQuery.isFetchingNextPage }}
          disabled={repliesQuery.isFetchingNextPage}
          onPress={() => void repliesQuery.fetchNextPage()}
          style={({ pressed }) => ({
            minHeight: 48,
            justifyContent: 'center',
            paddingLeft: appTheme.spacing.panel + 33,
            paddingRight: appTheme.spacing.panel,
            opacity: pressed ? appTheme.opacity.pressed : 1,
          })}
        >
          {repliesQuery.isFetchingNextPage ? (
            <ActivityIndicator color={appTheme.colors.faint} />
          ) : (
            <Text style={{ color: appTheme.colors.primary, ...appTheme.type.caption, fontWeight: '800' }}>
              Load more replies
            </Text>
          )}
        </Pressable>
      ) : null}
    </View>
  );
}

function CommentRowView({
  comment,
  isReply = false,
  onActions,
  onReply,
}: {
  comment: PostComment;
  isReply?: boolean;
  onActions?: CommentActionHandler;
  onReply?: CommentActionHandler;
}) {
  const display = getCommentDisplay(comment);

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
        {!display.isDeleted && onReply ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Reply to ${display.authorLabel}`}
            onPress={() => onReply(comment)}
            style={{ minHeight: 48, alignSelf: 'flex-start', justifyContent: 'center' }}
          >
            <Text style={{ color: appTheme.colors.faint, ...appTheme.type.caption, fontWeight: '800' }}>Reply</Text>
          </Pressable>
        ) : null}
      </View>
      {!display.isDeleted && onActions ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Options for ${display.authorLabel}'s comment`}
          onPress={() => onActions(comment)}
          style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center' }}
        >
          <MoreHorizontal size={16} color={appTheme.colors.faint} />
        </Pressable>
      ) : null}
    </View>
  );
}

function ReportReasonPicker({
  bottomInset,
  loading,
  onCancel,
  onSelect,
}: {
  bottomInset: number;
  loading: boolean;
  onCancel: () => void;
  onSelect: (reason: CommentReportReason) => void;
}) {
  return (
    <View
      accessibilityViewIsModal
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 10,
        justifyContent: 'flex-end',
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Cancel report"
        disabled={loading}
        onPress={onCancel}
        style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.64)' }}
      />
      <View
        style={{
          borderTopLeftRadius: appTheme.radii.xl,
          borderTopRightRadius: appTheme.radii.xl,
          borderWidth: 1,
          borderColor: appTheme.colors.borderStrong,
          backgroundColor: appTheme.colors.panel,
          paddingHorizontal: appTheme.spacing.panel,
          paddingTop: appTheme.spacing.panel,
          paddingBottom: Math.max(bottomInset, appTheme.spacing.panel),
          gap: appTheme.spacing.compact,
        }}
      >
        <Text accessibilityRole="header" style={{ color: appTheme.colors.text, ...appTheme.type.cardTitle }}>
          Why are you reporting this?
        </Text>
        <Text style={{ color: appTheme.colors.muted, ...appTheme.type.bodySm }}>
          Choose the closest reason so the moderation team can review it correctly.
        </Text>
        {REPORT_REASONS.map((reason) => (
          <Pressable
            key={reason.value}
            accessibilityRole="button"
            accessibilityLabel={`Report as ${reason.label}`}
            accessibilityState={{ disabled: loading }}
            disabled={loading}
            onPress={() => onSelect(reason.value)}
            style={({ pressed }) => ({
              minHeight: 48,
              justifyContent: 'center',
              borderRadius: appTheme.radii.md,
              borderWidth: 1,
              borderColor: appTheme.colors.borderStrong,
              backgroundColor: appTheme.colors.surface,
              paddingHorizontal: appTheme.spacing.gap,
              opacity: pressed ? appTheme.opacity.pressed : 1,
            })}
          >
            <Text style={{ color: appTheme.colors.text, ...appTheme.type.bodySm, fontWeight: '800' }}>
              {reason.label}
            </Text>
          </Pressable>
        ))}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel report"
          disabled={loading}
          onPress={onCancel}
          style={({ pressed }) => ({
            minHeight: 48,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: pressed ? appTheme.opacity.pressed : 1,
          })}
        >
          {loading ? (
            <ActivityIndicator color={appTheme.colors.faint} />
          ) : (
            <Text style={{ color: appTheme.colors.muted, ...appTheme.type.bodySm, fontWeight: '800' }}>
              Cancel
            </Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}
