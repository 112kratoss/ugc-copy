import { useFocusEffect, useIsFocused } from '@react-navigation/native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import {
  AlertCircle,
  ArrowDown,
  Ban,
  Check,
  CheckCheck,
  Clock3,
  ImageOff,
  ImagePlus,
  LifeBuoy,
  Lock,
  Pencil,
  Reply,
  Send,
  X,
} from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Animated,
  FlatList,
  Keyboard,
  Linking,
  PanResponder,
  Pressable,
  Text,
  TextInput,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { KeyboardAvoidingArea } from '@/components/keyboard-aware';
import { MediaLightbox, type LightboxMediaItem } from '@/components/media-lightbox';
import { SupportRoadmapTab } from '@/components/support-hub-roadmap';
import { SupportUpdatesTab } from '@/components/support-hub-updates';
import {
  AppText,
  IconButton,
  PrimaryButton,
  Screen,
  SecondaryButton,
  SectionTitle,
  SegmentedControl,
  StatusBlock,
} from '@/components/ui';
import { showActionSheet, type ActionSheetAction } from '@/lib/action-sheet';
import { ApiError } from '@/lib/api-client';
import { useAppForeground } from '@/lib/app-foreground';
import { formatAppVersionLabel, readAppVersionParts, readUpdateRuntime } from '@/lib/app-version-label';
import { useAuth } from '@/lib/auth';
import { copyToClipboard } from '@/lib/copy-to-clipboard';
import { formatSupportDetails, readCreatorSession } from '@/lib/creator-session-diagnostics';
import { showConfirmDialog } from '@/lib/dialog';
import { haptic } from '@/lib/haptics';
import { MIN_HIT_TARGET_PT, verticalHitSlop } from '@/lib/hit-target';
import { uploadPickedMedia } from '@/lib/media';
import {
  SUPPORT_CONVERSATION_PATH,
  SUPPORT_EMAIL,
  SUPPORT_MESSAGE_COUNTER_FROM,
  SUPPORT_MESSAGE_MAX_LENGTH,
  SUPPORT_REACTION_EMOJIS,
  SUPPORT_WORDS,
  canDeleteSupportMessage,
  canEditSupportMessage,
  checkSupportMessage,
  createSupportClientMessageId,
  failPendingSupportMessage,
  isSupportPhotoRefusal,
  settlePendingSupportMessage,
  startPendingSupportMessage,
  supportClockLabel,
  supportDeletedMessage,
  supportDeletedWords,
  supportEditedMessage,
  supportMessageLength,
  supportOtherSideTyping,
  supportPhotoFrame,
  supportPhotoPickRefusal,
  supportQuoteAuthorName,
  supportQuoteOf,
  supportQuoteText,
  supportReactionToggle,
  supportShouldPingTyping,
  supportTextSegments,
  supportThreadRows,
  supportUnreadMessages,
  withoutKeptPendingMessages,
  withStableSupportPhotoLinks,
  type SupportConversationResponse,
  type SupportMessage,
  type SupportPendingMessage,
  type SupportPendingPhoto,
  type SupportPhoto,
  type SupportQuotedMessage,
  type SupportReactionEmoji,
  type SupportThreadRow,
} from '@/lib/support-conversation-policy/support-conversation-policy';
import {
  createSupportPollTracker,
  supportActionFailureWords,
  supportConversationAfterSend,
  supportConversationQueryKey,
  supportConversationWithMessage,
  supportConversationWithReadTimes,
  supportMessageSheetTitle,
  supportSendFailureWords,
} from '@/lib/support-conversation-view-model';
import {
  SUPPORT_HUB_WORDS,
  readSupportHubTab,
  type SupportHubTab,
} from '@/lib/support-hub-policy/support-hub-policy';
import { supportFeatureIdeaDraft, supportHubMountedTabs, supportHubTabOptions } from '@/lib/support-hub-view-model';
import { supportMailUrl } from '@/lib/support-mail';
import { useSupportUpdatesUnseen } from '@/lib/support-updates-seen';
import {
  keepSupportPhoto,
  letGoSupportPhoto,
  supportPhotoCopyName,
  supportPhotoIsThere,
  SupportPhotoGoneError,
  sweepSupportPhotos,
} from '@/lib/support-photo-file';
import { appTheme, mediaColors } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

/** The mail "Email us instead" opens, read at the press so its build and session lines are current. */
function supportMailWithDetails() {
  return supportMailUrl([
    formatAppVersionLabel(readAppVersionParts()),
    formatSupportDetails({ ...readUpdateRuntime(), session: readCreatorSession() }),
  ]);
}

/**
 * The mail under the privacy note, as the web's footnote under its thread: Help & Support opens
 * this screen itself (owner, 2026-11-26), and it is the only place the app gives the address.
 */
function SupportMailLine() {
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Prefer email? Write to ${SUPPORT_EMAIL}`}
      accessibilityHint="Opens your email app."
      onPress={() => void Linking.openURL(supportMailWithDetails())}
      style={({ pressed }) => ({
        minHeight: MIN_HIT_TARGET_PT,
        justifyContent: 'center',
        paddingHorizontal: 12,
        opacity: pressed ? appTheme.opacity.pressed : 1,
      })}
    >
      <AppText variant="caption" color="muted" style={{ textAlign: 'center' }}>
        Prefer email? Write to <AppText variant="caption" color="primary">{SUPPORT_EMAIL}</AppText>
      </AppText>
    </Pressable>
  );
}

/** How far a message is pulled right to reply to it, and how far it can go. */
const SWIPE_REPLY_TRIGGER = 56;
const SWIPE_REPLY_MAX = 80;
/** How far up the thread the button back to the latest message appears. */
const JUMP_BUTTON_FROM = 240;
/** The round button back to the latest message, and the count on it. */
const JUMP_BUTTON_SIZE = 44;
const JUMP_BADGE_SIZE = 22;
/** The header's round support mark. */
const HEADER_MARK_SIZE = 34;
/** The round reply mark a pulled message uncovers. */
const REPLY_MARK_SIZE = 32;
/** A reaction under a bubble: a capsule this tall. */
const REACTION_PILL_HEIGHT = 26;
/** A photo in the thread is drawn at most this tall; a taller one is cut, as a chat app cuts a long screenshot. */
const PHOTO_MAX_HEIGHT = 320;
/** The picked photo's square above the composer. */
const PHOTO_DRAFT_SIZE = 44;
/** How long a photo that failed to load waits before it is tried once more by itself. */
const PHOTO_RETRY_MS = 2500;

/** A photo picked from the library, kept until its message is sent. */
type PickedSupportPhoto = {
  uri: string;
  fileName: string | null;
  mimeType: string;
  size: number | null;
  width: number | null;
  height: number | null;
};

function pendingPhotoOf(photo: PickedSupportPhoto): SupportPendingPhoto {
  return { localUri: photo.uri, width: photo.width, height: photo.height };
}

/** "Suggest a feature" asked the chat to start its composer: a new key for each press. */
type SupportChatPrefill = { key: number };

/** The header of the hub's own tabs; the chat draws its own while it is in front for an account. */
const HUB_HEADER_OPTIONS = { headerTitle: SUPPORT_HUB_WORDS.title };

/**
 * Help & Support: Chat, Updates and Roadmap (owner, 2026-11-26; plan:
 * docs/plans/help-support-updates-roadmap-plan-2026-11-26.md), a segmented
 * control under the header. It opens on the chat, as the side menu's Help &
 * Support and Settings' Help & support open it, or on the tab a link names
 * (`/support?tab=updates`). Each tab is built the first time it is opened and
 * kept, hidden, while another is in front: the chat keeps its draft, its photo
 * and its place in the thread, and reads and marks its messages only while it
 * is the one shown. The composer is the chat's, so it shows on Chat only.
 */
export default function SupportScreen() {
  const { api, user } = useAuth();
  const theme = useAppTheme();
  const params = useLocalSearchParams<{ tab?: string | string[] }>();
  const linkedTab = readSupportHubTab(params.tab);
  const [tab, setTab] = useState<SupportHubTab>(linkedTab);
  const [mounted, setMounted] = useState<readonly SupportHubTab[]>(() => [linkedTab]);
  const [prefill, setPrefill] = useState<SupportChatPrefill | null>(null);
  // The dot on Updates: asked while another tab is in front (Updates itself marks them seen).
  const unseenUpdates = useSupportUpdatesUnseen({ api, enabled: tab !== 'updates' });

  // A link that names another tab while the screen is up moves to it.
  const [followedTab, setFollowedTab] = useState(linkedTab);
  if (followedTab !== linkedTab) {
    setFollowedTab(linkedTab);
    setTab(linkedTab);
    setMounted((current) => supportHubMountedTabs(current, linkedTab));
  }

  const selectTab = (next: SupportHubTab) => {
    // The chat's keyboard does not stay up over a tab with no field.
    Keyboard.dismiss();
    setTab(next);
    setMounted((current) => supportHubMountedTabs(current, next));
  };

  const suggestFeature = () => {
    setPrefill((current) => ({ key: (current?.key ?? 0) + 1 }));
    selectTab('chat');
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      {tab === 'chat' && user ? null : <Stack.Screen options={HUB_HEADER_OPTIONS} />}
      <View
        style={{
          paddingHorizontal: appTheme.spacing.screen,
          paddingTop: appTheme.spacing.compact,
          paddingBottom: appTheme.spacing.compact,
        }}
      >
        <SegmentedControl
          role="tab"
          accessibilityLabel={SUPPORT_HUB_WORDS.tabsLabel}
          options={supportHubTabOptions({ unseenUpdates })}
          value={tab}
          onChange={selectTab}
        />
      </View>
      <View style={{ flex: 1 }}>
        {mounted.includes('chat') ? (
          <SupportTabPane shown={tab === 'chat'}>
            <SupportChat active={tab === 'chat'} prefill={prefill} />
          </SupportTabPane>
        ) : null}
        {mounted.includes('updates') ? (
          <SupportTabPane shown={tab === 'updates'}>
            <SupportUpdatesTab active={tab === 'updates'} />
          </SupportTabPane>
        ) : null}
        {mounted.includes('roadmap') ? (
          <SupportTabPane shown={tab === 'roadmap'}>
            <SupportRoadmapTab onSuggestFeature={suggestFeature} />
          </SupportTabPane>
        ) : null}
      </View>
    </View>
  );
}

/** A tab's page: laid out and heard only while it is the one in front. */
function SupportTabPane({ shown, children }: { shown: boolean; children: ReactNode }) {
  return <View style={{ flex: 1, display: shown ? 'flex' : 'none' }}>{children}</View>;
}

/**
 * Message support: the account's one conversation with support, which the
 * operator answers from the web console, worked as a chat app (owner,
 * 2026-11-22: "make the functionalities close to whatsapp as much as
 * possible"). New messages arrive while the screen is open; the header says
 * "typing…" while support writes; a sent message shows one tick, and two once
 * support has read it; a message is answered by pulling it right (or from its
 * long press), and its long press offers reactions, Copy, Edit (15 minutes)
 * and Delete for everyone (48 hours). A photo from the library goes with the
 * text as its caption (staged like any upload, then named in the send), and a
 * photo in the thread opens full screen in the app's media lightbox, with the
 * thread's other photos a swipe away. A pushed screen with its own composer
 * rather than a sheet: a field may not sit in an RN Modal (`hig-modality.test.ts`).
 *
 * Help & Support's Chat tab: `active` while it is the tab in front. Hidden, it
 * neither reads the thread again nor marks it read, and draws no header.
 */
function SupportChat({ active, prefill }: { active: boolean; prefill: SupportChatPrefill | null }) {
  const { api, user } = useAuth();
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const isFocused = useIsFocused();
  const foreground = useAppForeground();
  const visible = isFocused && foreground && active;
  const userId = user?.id ?? null;
  const queryKey = supportConversationQueryKey(userId);
  const [tracker] = useState(() => createSupportPollTracker());
  const conversation = useQuery({
    queryKey,
    enabled: Boolean(user),
    queryFn: async () => {
      const next = await api.getSupportConversation();
      // Each read signs the photos anew; the links already drawn are kept while they last.
      const previous = queryClient.getQueryData<SupportConversationResponse>(queryKey);
      return previous ? { ...next, messages: withStableSupportPhotoLinks(previous.messages, next.messages) } : next;
    },
    // Read again every few seconds while the screen is in front: often while
    // things move, less once quiet; never in the background.
    refetchInterval: visible ? (query) => tracker.next(query.state.data as SupportConversationResponse | undefined) : false,
    refetchIntervalInBackground: false,
  });
  const [pending, setPending] = useState<SupportPendingMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<SupportQuotedMessage | null>(null);
  const [editing, setEditing] = useState<SupportMessage | null>(null);
  // An edit on its way to the server: the composer keeps its text until the answer.
  const [savingEdit, setSavingEdit] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [unreadMark, setUnreadMark] = useState<{ fromId: string; count: number } | null | undefined>(undefined);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [showJump, setShowJump] = useState(false);
  const [newCount, setNewCount] = useState(0);
  const [photoDraft, setPhotoDraft] = useState<PickedSupportPhoto | null>(null);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const { width: windowWidth } = useWindowDimensions();
  const listRef = useRef<FlatList<SupportThreadRow>>(null);
  // Photos of messages on their way or not sent, and where each was staged, by client id, for a retry.
  const photosRef = useRef(new Map<string, PickedSupportPhoto>());
  const stagedRef = useRef(new Map<string, string>());
  // The sends, one after another, so a photo and the words after it are kept in that order.
  const sendQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  // What the composer held when an edit began, given back when the edit ends.
  const draftBeforeEditRef = useRef('');
  // The client ids of messages a read showed kept: a send of one of them, on
  // its way or answered late, has nothing left to do or to say.
  const keptIdsRef = useRef(new Set<string>());
  const fieldRef = useRef<TextInput>(null);
  const lastTypingRef = useRef<number | null>(null);
  const markingRef = useRef(false);
  const othersSeenRef = useRef<number | null>(null);
  // The draft's photo, whose copy goes when the screen closes with it still there.
  const photoDraftUriRef = useRef<string | null>(null);
  // The client ids of sends on their way or waiting their turn: their copies outlive the screen until they settle.
  const inFlightRef = useRef(new Set<string>());
  // The client ids of messages whose photo is no longer on the phone: no try can send them.
  const goneIdsRef = useRef(new Set<string>());
  // Whether the screen is still open, for a send or a pick that answers after it closed.
  const mountedRef = useRef(false);

  const data = conversation.data;

  useEffect(() => {
    photoDraftUriRef.current = photoDraft?.uri ?? null;
  }, [photoDraft]);

  // The photo copies go with the screen: the draft's, and those of messages not
  // sent, which nothing can try again once it is closed. A send still on its
  // way keeps its copy and lets it go as it settles. The sweep takes what an
  // earlier run of the app left behind.
  useEffect(() => {
    mountedRef.current = true;
    void sweepSupportPhotos();
    const photos = photosRef.current;
    const inFlight = inFlightRef.current;
    return () => {
      mountedRef.current = false;
      void letGoSupportPhoto(photoDraftUriRef.current);
      for (const [clientMessageId, photo] of photos) {
        if (!inFlight.has(clientMessageId)) void letGoSupportPhoto(photo.uri);
      }
    };
  }, []);

  // A reply may have come while the screen was away: read again on each
  // arrival, past the first, whose read is the query's own. Coming back to
  // the Chat tab from another counts as an arrival too.
  useFocusEffect(useCallback(() => {
    if (!userId || !active) return;
    const state = queryClient.getQueryState(supportConversationQueryKey(userId));
    if (!state || state.data === undefined || state.fetchStatus !== 'idle') return;
    void queryClient.invalidateQueries({ queryKey: supportConversationQueryKey(userId) });
  }, [active, queryClient, userId]));

  // "Suggest a feature" on the Roadmap tab: the composer starts with the
  // idea's words, once per press, never over words being written or an edit.
  // It waits for the thread: until it is read there is no composer to focus.
  const appliedPrefillRef = useRef<number | null>(null);
  const threadDrawn = data !== undefined;
  useEffect(() => {
    if (!prefill || !active || !threadDrawn || appliedPrefillRef.current === prefill.key) return;
    appliedPrefillRef.current = prefill.key;
    setDraft((current) => supportFeatureIdeaDraft({ draft: current, editing: Boolean(editing) }) ?? current);
    fieldRef.current?.focus();
  }, [active, editing, prefill, threadDrawn]);

  // The divider above the first unread message is placed once, as the thread opens.
  useEffect(() => {
    if (unreadMark !== undefined || !data) return;
    const unread = supportUnreadMessages(data.messages, 'user', data.conversation?.userLastReadAt ?? null);
    setUnreadMark(unread.length > 0 ? { fromId: unread[0].id, count: unread.length } : null);
  }, [data, unreadMark]);

  // A message a read shows was kept under its client id is the thread's now,
  // whatever its send answered (its answer lost, or slower than the read).
  useEffect(() => {
    if (!data) return;
    for (const message of data.messages) {
      if (!message.clientMessageId) continue;
      keptIdsRef.current.add(message.clientMessageId);
      void letGoSupportPhoto(photosRef.current.get(message.clientMessageId)?.uri);
      photosRef.current.delete(message.clientMessageId);
      stagedRef.current.delete(message.clientMessageId);
    }
    setPending((current) => withoutKeptPendingMessages(current, data.messages));
  }, [data]);

  // Read receipts: while the screen is in front, support's new messages are
  // read, up to the newest one drawn.
  useEffect(() => {
    if (!visible || !data?.conversation || markingRef.current) return;
    if (supportUnreadMessages(data.messages, 'user', data.conversation.userLastReadAt).length === 0) return;
    markingRef.current = true;
    api.markSupportConversationRead(data.messages[data.messages.length - 1]?.id ?? null)
      .then((read) => {
        queryClient.setQueryData<SupportConversationResponse>(queryKey, (current) => supportConversationWithReadTimes(current, read));
      })
      .catch(() => undefined)
      .finally(() => {
        markingRef.current = false;
      });
  }, [api, data, queryClient, queryKey, visible]);

  const othersCount = data ? data.messages.filter((message) => message.author !== 'user').length : 0;
  // Support's new messages count on the button back to them while the reader is up the thread.
  useEffect(() => {
    const seen = othersSeenRef.current;
    othersSeenRef.current = othersCount;
    if (seen === null || othersCount <= seen || !showJump) return;
    setNewCount((count) => count + (othersCount - seen));
  }, [othersCount, showJump]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(null), 1600);
    return () => clearTimeout(timer);
  }, [notice]);

  /**
   * Sends a message, or tries one that was not sent again (the same client id,
   * whose photo is kept from the first try, and named by where it was staged
   * once it got there). It is drawn at once, and goes to the server after the
   * sends written before it have settled.
   */
  const send = async (
    body: string,
    clientMessageId: string,
    quoted: SupportQuotedMessage | null,
    picked: PickedSupportPhoto | null = null,
  ) => {
    setSendError(null);
    tracker.touch();
    // The server stops the writer's "typing…" with the message.
    lastTypingRef.current = null;
    if (picked) photosRef.current.set(clientMessageId, picked);
    const photo = picked ?? photosRef.current.get(clientMessageId) ?? null;
    inFlightRef.current.add(clientMessageId);
    setPending((current) => startPendingSupportMessage(current, {
      clientMessageId,
      body,
      now: new Date().toISOString(),
      replyTo: quoted,
      photo: photo ? pendingPhotoOf(photo) : null,
    }));
    const turn = sendQueueRef.current.then(() => post(body, clientMessageId, quoted, photo));
    sendQueueRef.current = turn;
    await turn;
  };

  const post = async (
    body: string,
    clientMessageId: string,
    quoted: SupportQuotedMessage | null,
    photo: PickedSupportPhoto | null,
  ) => {
    // A read showed it kept while it waited its turn (a retry of a message
    // whose answer was lost): nothing is left to upload or send.
    if (keptIdsRef.current.has(clientMessageId)) {
      inFlightRef.current.delete(clientMessageId);
      return;
    }
    try {
      let storagePath = photo ? stagedRef.current.get(clientMessageId) ?? null : null;
      if (photo && !storagePath) {
        // A file the phone no longer has cannot be sent by any try: say so, not "check your connection".
        if (!(await supportPhotoIsThere(photo.uri))) throw new SupportPhotoGoneError();
        const uploaded = await uploadPickedMedia(photo.uri, {
          api,
          fileName: photo.fileName ?? 'photo.jpg',
          mimeType: photo.mimeType,
          kind: 'image',
          sizeBytes: photo.size,
        });
        storagePath = uploaded.storagePath;
        stagedRef.current.set(clientMessageId, storagePath);
      }
      const sent = await api.sendSupportMessage({
        body,
        clientMessageId,
        replyToMessageId: quoted?.id ?? null,
        ...(storagePath ? { photo: { storagePath } } : {}),
      });
      inFlightRef.current.delete(clientMessageId);
      void letGoSupportPhoto(photo?.uri);
      photosRef.current.delete(clientMessageId);
      stagedRef.current.delete(clientMessageId);
      queryClient.setQueryData<SupportConversationResponse>(queryKey, (current) => supportConversationAfterSend(current, sent));
      setPending((current) => settlePendingSupportMessage(current, clientMessageId));
      // Read again now, and at the quick pace from here, rather than after an idle wait.
      void queryClient.invalidateQueries({ queryKey });
    } catch (error) {
      inFlightRef.current.delete(clientMessageId);
      // A read showed it kept before this answer came: it is not "not sent".
      if (keptIdsRef.current.has(clientMessageId)) return;
      // The screen closed while it was on its way: nothing can try it again, so its copy goes.
      if (!mountedRef.current) {
        void letGoSupportPhoto(photo?.uri);
        photosRef.current.delete(clientMessageId);
        return;
      }
      if (error instanceof SupportPhotoGoneError) goneIdsRef.current.add(clientMessageId);
      const code = error instanceof ApiError ? error.code ?? null : null;
      // A refusal of the photo itself means the next try stages it anew; any
      // other (a quote gone, too many at once) keeps the copy already staged.
      if (isSupportPhotoRefusal(code)) stagedRef.current.delete(clientMessageId);
      setPending((current) => failPendingSupportMessage(current, clientMessageId, code));
      setSendError(supportSendFailureWords(error));
    }
  };

  /** Lets a message that was not sent go, with its photo and where it was staged. */
  const discard = (clientMessageId: string) => {
    void letGoSupportPhoto(photosRef.current.get(clientMessageId)?.uri);
    photosRef.current.delete(clientMessageId);
    stagedRef.current.delete(clientMessageId);
    goneIdsRef.current.delete(clientMessageId);
    setPending((current) => settlePendingSupportMessage(current, clientMessageId));
    setSendError(null);
  };

  /** A message not sent: try it again, or let it go. One whose photo is gone can only go. */
  const openNotSentActions = (item: SupportPendingMessage) => {
    haptic.light();
    const deleteAction = { label: SUPPORT_WORDS.delete, destructive: true, onPress: () => discard(item.clientMessageId) };
    showActionSheet({
      title: SUPPORT_WORDS.notSentActions,
      actions: goneIdsRef.current.has(item.clientMessageId)
        ? [deleteAction]
        : [
          { label: SUPPORT_WORDS.tryAgain, onPress: () => void send(item.body, item.clientMessageId, item.replyTo) },
          deleteAction,
        ],
    });
  };

  /** A photo from the library, held to the rule, drawn above the composer until it goes. */
  const pickPhoto = async () => {
    if (editing) return;
    let result: ImagePicker.ImagePickerResult;
    try {
      // The system's own picker, which needs no permission. An iPhone keeps
      // most photos as HEIC, which the server cannot read and the picker
      // hands over as it is stored, at any quality: the compatible
      // representation is a JPEG (as the profile editor asks for).
      result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: false,
        preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
        quality: 0.9,
      });
    } catch {
      setSendError(SUPPORT_WORDS.actionFailed);
      return;
    }
    const asset = result.canceled ? null : result.assets?.[0] ?? null;
    if (!asset) return;
    const picked: PickedSupportPhoto = {
      uri: asset.uri,
      fileName: asset.fileName ?? null,
      mimeType: asset.mimeType ?? 'image/jpeg',
      size: typeof asset.fileSize === 'number' && Number.isFinite(asset.fileSize) ? asset.fileSize : null,
      width: asset.width > 0 ? asset.width : null,
      height: asset.height > 0 ? asset.height : null,
    };
    const refusal = supportPhotoPickRefusal({ type: picked.mimeType, size: picked.size });
    if (refusal) {
      setSendError(refusal);
      return;
    }
    // The picker's file sits in the cache folder, which Android empties by
    // itself on a phone short of space: the draft waits in a copy of its own.
    const kept = await keepSupportPhoto(picked.uri, supportPhotoCopyName(picked));
    // The screen closed while the picker or the copy was open: the copy has no draft to wait in.
    if (!mountedRef.current) {
      void letGoSupportPhoto(kept);
      return;
    }
    const replaced = photoDraftUriRef.current;
    setSendError(null);
    setPhotoDraft({ ...picked, uri: kept });
    if (replaced && replaced !== kept) void letGoSupportPhoto(replaced);
  };

  /** Takes the picked photo off the composer, and its copy with it. */
  const removePhotoDraft = () => {
    void letGoSupportPhoto(photoDraftUriRef.current);
    setPhotoDraft(null);
  };

  /** A change drawn at once, and put back if the server refuses it; says whether the server took it. */
  const change = async (
    before: SupportMessage,
    drawn: SupportMessage,
    run: () => Promise<{ message: SupportMessage }>,
  ): Promise<boolean> => {
    setSendError(null);
    tracker.touch();
    await queryClient.cancelQueries({ queryKey });
    queryClient.setQueryData<SupportConversationResponse>(queryKey, (current) => supportConversationWithMessage(current, drawn));
    try {
      const result = await run();
      queryClient.setQueryData<SupportConversationResponse>(queryKey, (current) => supportConversationWithMessage(current, result.message));
      void queryClient.invalidateQueries({ queryKey });
      return true;
    } catch (error) {
      queryClient.setQueryData<SupportConversationResponse>(queryKey, (current) => supportConversationWithMessage(current, before));
      setSendError(supportActionFailureWords(error));
      return false;
    }
  };

  const react = (message: SupportMessage, emoji: SupportReactionEmoji) => {
    const toggled = supportReactionToggle(message, 'user', emoji);
    void change(message, toggled.message, () => api.reactToSupportMessage(message.id, toggled.emoji));
  };

  /** Leaves an edit: the composer gets back what it held before the edit began. */
  const endEdit = () => {
    setEditing(null);
    setDraft(draftBeforeEditRef.current);
    draftBeforeEditRef.current = '';
  };

  const startReply = (message: SupportMessage) => {
    if (savingEdit) return;
    if (editing) endEdit();
    setReplyTo(supportQuoteOf(message));
    fieldRef.current?.focus();
  };

  const startEdit = (message: SupportMessage) => {
    if (savingEdit) return;
    setReplyTo(null);
    // The unsent draft waits aside while the edit is written.
    if (!editing) draftBeforeEditRef.current = draft;
    setEditing(message);
    setDraft(message.body ?? '');
    fieldRef.current?.focus();
  };

  const cancelCompose = () => {
    if (savingEdit) return;
    if (editing) endEdit();
    setReplyTo(null);
  };

  const confirmDelete = async (message: SupportMessage) => {
    const confirmed = await showConfirmDialog({
      title: SUPPORT_WORDS.deleteTitle,
      message: SUPPORT_WORDS.deleteBody,
      confirmLabel: SUPPORT_WORDS.deleteConfirm,
      destructive: true,
    });
    if (!confirmed) return;
    if (editing?.id === message.id) cancelCompose();
    void change(
      message,
      supportDeletedMessage(message, new Date().toISOString()),
      () => api.deleteSupportMessage(message.id),
    );
  };

  // The thread's photos, for the lightbox to step through.
  const photoItems = useMemo<LightboxMediaItem[]>(() => (data?.messages ?? []).flatMap((message) => {
    const url = message.attachment?.url ?? message.attachment?.previewUrl ?? null;
    if (!url || message.deletedAt) return [];
    return [{
      id: message.id,
      url,
      mediaKind: 'image' as const,
      label: message.author === 'user' ? SUPPORT_WORDS.you : SUPPORT_WORDS.supportName,
      caption: message.body,
    }];
  }), [data]);

  const openPhoto = (messageId: string) => {
    const index = photoItems.findIndex((item) => item.id === messageId);
    if (index >= 0) setViewerIndex(index);
  };

  const openMessageActions = (message: SupportMessage) => {
    if (message.deletedAt) return;
    haptic.medium();
    const now = Date.now();
    const actions: ActionSheetAction[] = [
      { label: SUPPORT_WORDS.reply, onPress: () => startReply(message) },
      ...(message.body
        ? [{
          label: SUPPORT_WORDS.copy,
          onPress: () => {
            void copyToClipboard(message.body ?? '', SUPPORT_WORDS.copied);
            setNotice(SUPPORT_WORDS.copied);
          },
        }]
        : []),
      ...(canEditSupportMessage(message, 'user', now) ? [{ label: SUPPORT_WORDS.edit, onPress: () => startEdit(message) }] : []),
      ...(canDeleteSupportMessage(message, 'user', now)
        ? [{ label: SUPPORT_WORDS.delete, destructive: true, onPress: () => void confirmDelete(message) }]
        : []),
    ];
    showActionSheet({
      title: supportMessageSheetTitle(message),
      actions,
      reactions: {
        label: SUPPORT_WORDS.react,
        options: SUPPORT_REACTION_EMOJIS,
        selected: message.reactions.find((reaction) => reaction.author === 'user')?.emoji ?? null,
        onSelect: (option) => react(message, option as SupportReactionEmoji),
      },
    });
  };

  const onChangeDraft = (text: string) => {
    setDraft(text);
    // Before the first message there is no conversation and no-one to tell.
    if (!data?.conversation) return;
    const now = Date.now();
    if (!supportShouldPingTyping(lastTypingRef.current, now)) return;
    lastTypingRef.current = now;
    tracker.touch();
    api.setSupportTyping(true).catch(() => undefined);
  };

  const rows = useMemo(() => supportThreadRows({
    messages: data?.messages ?? [],
    pending,
    conversation: data?.conversation ?? null,
    viewer: 'user',
    unreadFromId: unreadMark?.fromId ?? null,
    unreadCount: unreadMark?.count ?? 0,
  }), [data, pending, unreadMark]);
  // The list is drawn upside down so it opens at its end and stays there as messages arrive.
  const listRows = useMemo(() => [...rows].reverse(), [rows]);

  const openQuote = (id: string) => {
    const index = listRows.findIndex((row) => row.kind === 'message' && row.message.id === id);
    if (index < 0) return;
    listRef.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true });
    setFlashId(id);
    setTimeout(() => setFlashId((current) => (current === id ? null : current)), 1400);
  };

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const away = event.nativeEvent.contentOffset.y > JUMP_BUTTON_FROM;
    if (away !== showJump) setShowJump(away);
    if (!away && newCount > 0) setNewCount(0);
  };

  const jumpToLatest = () => {
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
    setNewCount(0);
  };

  if (!user) {
    return (
      <Screen>
        <SectionTitle title={SUPPORT_WORDS.signInTitle} body={SUPPORT_WORDS.signInBody} />
        <PrimaryButton
          label="Sign in"
          accent="primary"
          onPress={() => router.push({ pathname: '/auth', params: { returnTo: SUPPORT_CONVERSATION_PATH } } as never)}
        />
        <SecondaryButton label={SUPPORT_WORDS.emailInstead} onPress={() => void Linking.openURL(supportMailWithDetails())} />
      </Screen>
    );
  }

  const typing = supportOtherSideTyping(data?.conversation ?? null, 'user');
  // Only the tab in front sets the header: the hub draws Help & Support's for the others.
  const header = active ? <Stack.Screen options={{ headerTitle: () => <SupportHeaderTitle typing={typing} /> }} /> : null;

  if (!data) {
    const failed = conversation.isError;
    return (
      <Screen>
        {header}
        {failed ? (
          <StatusBlock tone="danger" title="Your messages could not be loaded" body={SUPPORT_WORDS.loadFailed} />
        ) : (
          <AppText variant="bodySm" color="muted">Loading your messages…</AppText>
        )}
        {failed ? (
          <SecondaryButton
            label={conversation.isFetching ? 'Loading…' : 'Try again'}
            disabled={conversation.isFetching}
            onPress={() => void conversation.refetch()}
          />
        ) : null}
        {/* A thread that will not load still leaves the mail: this screen is the only place the app gives the address. */}
        {failed ? (
          <SecondaryButton label={SUPPORT_WORDS.emailInstead} onPress={() => void Linking.openURL(supportMailWithDetails())} />
        ) : null}
      </Screen>
    );
  }

  const checked = checkSupportMessage(draft, { hasPhoto: photoDraft !== null && !editing });
  const length = supportMessageLength(draft);
  const resolved = data.conversation?.status === 'resolved';
  // A bubble is at most 84% of the thread's width; a photo fills it, less its frame.
  const photoMaxWidth = Math.round((windowWidth - 2 * (appTheme.spacing.compact + 4)) * 0.84) - 8;

  /** Saves an edit, keeping its text in the composer until the server has it: a refusal leaves it there. */
  const saveEdit = async (target: SupportMessage, body: string) => {
    if (target.body === body) {
      endEdit();
      return;
    }
    setSavingEdit(true);
    const saved = await change(
      target,
      supportEditedMessage(target, body, new Date().toISOString()),
      () => api.editSupportMessage(target.id, body),
    );
    setSavingEdit(false);
    if (saved) endEdit();
  };

  const submit = () => {
    if (!checked.ok || savingEdit) return;
    if (editing) {
      void saveEdit(editing, checked.body);
      return;
    }
    const quoted = replyTo;
    const photo = photoDraft;
    setReplyTo(null);
    setDraft('');
    setPhotoDraft(null);
    void send(checked.body, createSupportClientMessageId(), quoted, photo);
  };

  const composeTarget = editing
    ? { title: SUPPORT_WORDS.editing, text: supportQuoteText(supportQuoteOf(editing)), cancel: SUPPORT_WORDS.cancelEdit }
    : replyTo
      ? { title: supportQuoteAuthorName(replyTo.author, 'user'), text: supportQuoteText(replyTo), cancel: SUPPORT_WORDS.cancelReply }
      : null;

  const privacyNote = (
    <View style={{ alignItems: 'center', paddingBottom: appTheme.spacing.compact, gap: 6 }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          maxWidth: 320,
          paddingHorizontal: 12,
          paddingVertical: 6,
          borderRadius: appTheme.radii.sm,
          borderCurve: 'continuous',
          backgroundColor: theme.colors.panel,
        }}
      >
        <Lock size={appTheme.icon.xs} color={theme.colors.muted} />
        <AppText variant="caption" color="muted" style={{ flexShrink: 1, textAlign: 'center' }}>{SUPPORT_WORDS.privacyNote}</AppText>
      </View>
      <SupportMailLine />
    </View>
  );

  return (
    <KeyboardAvoidingArea reservedBottomInset={insets.bottom} style={{ backgroundColor: theme.colors.background }}>
      {header}
      <View style={{ flex: 1 }}>
        {rows.length === 0 ? (
          <View style={{ flex: 1, padding: appTheme.spacing.screen, gap: appTheme.spacing.section }}>
            {privacyNote}
            <View style={{ flex: 1, justifyContent: 'center', gap: 8 }}>
              <AppText variant="cardTitle" style={{ textAlign: 'center' }}>{SUPPORT_WORDS.emptyTitle}</AppText>
              <AppText variant="bodySm" color="muted" style={{ textAlign: 'center' }}>{SUPPORT_WORDS.emptyBody}</AppText>
            </View>
          </View>
        ) : (
          <FlatList
            ref={listRef}
            inverted
            data={listRows}
            keyExtractor={(row) => row.key}
            extraData={flashId}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
            onScroll={onScroll}
            scrollEventThrottle={64}
            maintainVisibleContentPosition={{ minIndexForVisible: 1, autoscrollToTopThreshold: 120 }}
            onScrollToIndexFailed={({ index, averageItemLength }) => {
              listRef.current?.scrollToOffset({ offset: averageItemLength * index, animated: true });
            }}
            contentContainerStyle={{ paddingHorizontal: appTheme.spacing.compact + 4, paddingVertical: appTheme.spacing.compact }}
            // Upside down: the footer is the top of the thread, the header its end.
            ListFooterComponent={privacyNote}
            ListHeaderComponent={resolved ? (
              <AppText variant="caption" color="muted" style={{ textAlign: 'center', paddingVertical: appTheme.spacing.compact }}>
                {SUPPORT_WORDS.resolved}
              </AppText>
            ) : null}
            renderItem={({ item }) => (
              <SupportThreadRowView
                row={item}
                flashing={item.kind === 'message' && item.message.id === flashId}
                onLongPress={openMessageActions}
                onReply={startReply}
                onReact={react}
                onRetry={openNotSentActions}
                onOpenQuote={openQuote}
                onOpenPhoto={openPhoto}
                photoMaxWidth={photoMaxWidth}
              />
            )}
          />
        )}

        {showJump ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={SUPPORT_WORDS.jumpToLatest}
            onPress={jumpToLatest}
            style={{
              position: 'absolute',
              right: appTheme.spacing.screen,
              bottom: appTheme.spacing.compact,
              width: JUMP_BUTTON_SIZE,
              height: JUMP_BUTTON_SIZE,
              borderRadius: JUMP_BUTTON_SIZE / 2,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: theme.colors.panel,
              borderWidth: 1,
              borderColor: theme.colors.border,
              boxShadow: theme.shadow.floating.boxShadow,
            }}
          >
            <ArrowDown size={appTheme.icon.default} color={theme.colors.text} />
            {newCount > 0 ? (
              <View
                style={{
                  position: 'absolute',
                  top: -6,
                  right: -6,
                  minWidth: JUMP_BADGE_SIZE,
                  height: JUMP_BADGE_SIZE,
                  paddingHorizontal: 5,
                  borderRadius: JUMP_BADGE_SIZE / 2,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: theme.colors.primaryFill,
                }}
              >
                <AppText variant="caption" color={theme.colors.onPrimary} style={{ fontWeight: '700' }}>{String(newCount)}</AppText>
              </View>
            ) : null}
          </Pressable>
        ) : null}
      </View>

      <MediaLightbox
        items={photoItems}
        activeIndex={viewerIndex}
        onClose={() => setViewerIndex(null)}
        onNavigate={setViewerIndex}
      />

      <View
        style={{
          borderTopWidth: 1,
          borderTopColor: theme.colors.borderSubtle,
          paddingHorizontal: appTheme.spacing.compact + 4,
          paddingTop: appTheme.spacing.compact,
          paddingBottom: appTheme.spacing.compact + insets.bottom,
          gap: 6,
        }}
      >
        {composeTarget ? (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              borderLeftWidth: 3,
              borderLeftColor: theme.colors.primary,
              backgroundColor: theme.colors.panel,
              borderRadius: appTheme.radii.sm,
              borderCurve: 'continuous',
              paddingVertical: 6,
              paddingLeft: 10,
            }}
          >
            {editing ? <Pencil size={appTheme.icon.xs} color={theme.colors.primary} /> : null}
            <View style={{ flex: 1, gap: 2 }}>
              <AppText variant="caption" color="primary" numberOfLines={1} style={{ fontWeight: '700' }}>{composeTarget.title}</AppText>
              <AppText variant="caption" color="muted" numberOfLines={2}>{composeTarget.text}</AppText>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={composeTarget.cancel}
              onPress={cancelCompose}
              style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
            >
              <X size={appTheme.icon.sm} color={theme.colors.muted} />
            </Pressable>
          </View>
        ) : null}
        {photoDraft && !editing ? (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
              borderLeftWidth: 3,
              borderLeftColor: theme.colors.primary,
              backgroundColor: theme.colors.panel,
              borderRadius: appTheme.radii.sm,
              borderCurve: 'continuous',
              paddingVertical: 6,
              paddingLeft: 10,
            }}
          >
            <View
              style={{
                width: PHOTO_DRAFT_SIZE,
                height: PHOTO_DRAFT_SIZE,
                borderRadius: appTheme.radii.xs,
                borderCurve: 'continuous',
                overflow: 'hidden',
              }}
            >
              <Image
                source={{ uri: photoDraft.uri }}
                contentFit="cover"
                accessibilityIgnoresInvertColors
                style={{ width: '100%', height: '100%' }}
              />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <AppText variant="caption" color="primary" numberOfLines={1} style={{ fontWeight: '700' }}>{SUPPORT_WORDS.photo}</AppText>
              <AppText variant="caption" color="muted" numberOfLines={1}>{photoDraft.fileName ?? SUPPORT_WORDS.photo}</AppText>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={SUPPORT_WORDS.removePhoto}
              onPress={removePhotoDraft}
              style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
            >
              <X size={appTheme.icon.sm} color={theme.colors.muted} />
            </Pressable>
          </View>
        ) : null}
        {sendError ? (
          <AppText variant="caption" color="danger" accessibilityLiveRegion="polite">{sendError}</AppText>
        ) : notice ? (
          <AppText variant="caption" color="muted" accessibilityLiveRegion="polite">{notice}</AppText>
        ) : null}
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: appTheme.spacing.compact }}>
          <IconButton
            icon={ImagePlus}
            label={SUPPORT_WORDS.attachPhoto}
            variant="plain"
            disabled={Boolean(editing)}
            onPress={() => void pickPhoto()}
          />
          <TextInput
            ref={fieldRef}
            value={draft}
            onChangeText={onChangeDraft}
            placeholder={photoDraft && !editing ? SUPPORT_WORDS.addCaption : SUPPORT_WORDS.placeholder}
            placeholderTextColor={theme.colors.muted}
            accessibilityLabel={SUPPORT_WORDS.placeholder}
            multiline
            style={{
              flex: 1,
              minHeight: appTheme.touch.default,
              maxHeight: 140,
              paddingHorizontal: 16,
              paddingTop: 12,
              paddingBottom: 12,
              borderRadius: appTheme.radii.xl,
              borderCurve: 'continuous',
              borderWidth: 1,
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.surfaceInset,
              color: theme.colors.text,
              fontSize: appTheme.type.body.fontSize,
              lineHeight: appTheme.type.body.lineHeight,
            }}
          />
          <IconButton
            icon={editing ? Check : Send}
            label={editing ? SUPPORT_WORDS.save : SUPPORT_WORDS.send}
            accent="primary"
            disabled={!checked.ok || savingEdit}
            onPress={submit}
          />
        </View>
        {length >= SUPPORT_MESSAGE_COUNTER_FROM ? (
          <AppText variant="caption" color={length > SUPPORT_MESSAGE_MAX_LENGTH ? 'danger' : 'muted'}>
            {`${length.toLocaleString()} / ${SUPPORT_MESSAGE_MAX_LENGTH.toLocaleString()}`}
          </AppText>
        ) : null}
      </View>
    </KeyboardAvoidingArea>
  );
}

/** The header as a chat app draws it: who, and "typing…" while they write. */
function SupportHeaderTitle({ typing }: { typing: boolean }) {
  const theme = useAppTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <View
        style={{
          width: HEADER_MARK_SIZE,
          height: HEADER_MARK_SIZE,
          borderRadius: HEADER_MARK_SIZE / 2,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: theme.colors.selected,
        }}
      >
        <LifeBuoy size={appTheme.icon.compact} color={theme.colors.primary} />
      </View>
      <View style={{ flexShrink: 1 }}>
        <AppText variant="label" numberOfLines={1}>{SUPPORT_WORDS.supportName}</AppText>
        <AppText
          variant="caption"
          color={typing ? 'primary' : 'muted'}
          numberOfLines={1}
          accessibilityLiveRegion="polite"
        >
          {typing ? SUPPORT_WORDS.typing : SUPPORT_WORDS.replyTime}
        </AppText>
      </View>
    </View>
  );
}

/** A message pulled right to answer it, with the reply mark showing as it goes. */
function SwipeToReply({ enabled, onReply, children }: { enabled: boolean; onReply: () => void; children: ReactNode }) {
  const theme = useAppTheme();
  // Made for the native driver, which springs it back (mobile-runtime rules).
  const [translateX] = useState(() => new Animated.Value(0, { useNativeDriver: true }));
  const responder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, gesture) => enabled && gesture.dx > 12 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.6,
    onPanResponderTerminationRequest: () => false,
    onPanResponderMove: (_, gesture) => {
      translateX.setValue(Math.max(0, Math.min(gesture.dx, SWIPE_REPLY_MAX)));
    },
    onPanResponderRelease: (_, gesture) => {
      if (gesture.dx >= SWIPE_REPLY_TRIGGER) {
        haptic.light();
        onReply();
      }
      Animated.spring(translateX, { toValue: 0, useNativeDriver: true, speed: 22, bounciness: 6 }).start();
    },
    onPanResponderTerminate: () => {
      Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start();
    },
  }), [enabled, onReply, translateX]);
  const markOpacity = translateX.interpolate({ inputRange: [0, SWIPE_REPLY_TRIGGER], outputRange: [0, 1], extrapolate: 'clamp' });

  return (
    <View {...responder.panHandlers}>
      <Animated.View
        pointerEvents="none"
        style={{ position: 'absolute', left: 2, top: 0, bottom: 0, justifyContent: 'center', opacity: markOpacity }}
      >
        <View
          style={{
            width: REPLY_MARK_SIZE,
            height: REPLY_MARK_SIZE,
            borderRadius: REPLY_MARK_SIZE / 2,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: theme.colors.surfaceStrong,
          }}
        >
          <Reply size={appTheme.icon.sm} color={theme.colors.text} />
        </View>
      </Animated.View>
      <Animated.View style={{ transform: [{ translateX }] }}>{children}</Animated.View>
    </View>
  );
}

/**
 * A photo in a bubble: the server's preview, kept in the image cache under the
 * message's id so a link signed anew does not fetch it again, with its
 * thumbhash under it while it loads; or the picture on the device while it is
 * on its way. A photo that fails to load (a dropped connection) is tried once
 * more by itself a moment later; after that it says so in its place, and a
 * press tries again.
 */
function SupportPhotoView({
  messageId,
  photo,
  local,
  maxWidth,
  onPress,
  onLongPress,
  children,
}: {
  messageId: string | null;
  photo: SupportPhoto | null;
  local: SupportPendingPhoto | null;
  maxWidth: number;
  onPress?: () => void;
  onLongPress?: () => void;
  children?: ReactNode;
}) {
  const theme = useAppTheme();
  const uri = photo ? photo.previewUrl : local?.localUri ?? null;
  const [failedUri, setFailedUri] = useState<string | null>(null);
  // Each try draws the image anew; the first failure of a link tries once more by itself.
  const [attempt, setAttempt] = useState(0);
  const failed = Boolean(uri) && failedUri === uri;
  useEffect(() => {
    if (!failed || attempt > 0) return undefined;
    const timer = setTimeout(() => {
      setFailedUri(null);
      setAttempt(1);
    }, PHOTO_RETRY_MS);
    return () => clearTimeout(timer);
  }, [attempt, failed]);
  const broken = !uri || failed;
  const canRetry = failed && attempt > 0;
  const frame = supportPhotoFrame(
    { width: photo?.width ?? local?.width ?? 4, height: photo?.height ?? local?.height ?? 3 },
    { maxWidth, maxHeight: PHOTO_MAX_HEIGHT },
  );
  return (
    <Pressable
      accessibilityRole={canRetry ? 'button' : 'imagebutton'}
      accessibilityLabel={canRetry ? `${SUPPORT_WORDS.photoLoadFailed} ${SUPPORT_WORDS.photoTryAgain}` : SUPPORT_WORDS.openPhoto}
      disabled={canRetry ? false : broken || !onPress}
      onPress={canRetry
        ? () => {
          setFailedUri(null);
          setAttempt((current) => current + 1);
        }
        : onPress}
      onLongPress={onLongPress}
      delayLongPress={280}
      style={{
        width: frame.width,
        height: frame.height,
        borderRadius: appTheme.radii.md,
        borderCurve: 'continuous',
        overflow: 'hidden',
        backgroundColor: theme.colors.surfaceStrong,
      }}
    >
      {broken ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 6, padding: 12 }}>
          <ImageOff size={appTheme.icon.default} color={theme.colors.faint} />
          <AppText variant="caption" color="muted" style={{ textAlign: 'center' }}>{SUPPORT_WORDS.photoLoadFailed}</AppText>
          {canRetry ? (
            <AppText variant="caption" color="text" style={{ textAlign: 'center', fontWeight: '600' }}>
              {SUPPORT_WORDS.photoTryAgain}
            </AppText>
          ) : null}
        </View>
      ) : (
        <Image
          key={attempt}
          source={photo && messageId ? { uri, cacheKey: `support-photo-${messageId}` } : { uri }}
          placeholder={photo?.thumbhash ? { thumbhash: photo.thumbhash } : undefined}
          contentFit="cover"
          transition={120}
          accessibilityIgnoresInvertColors
          onError={() => setFailedUri(uri)}
          style={{ width: '100%', height: '100%' }}
        />
      )}
      {children}
    </Pressable>
  );
}

function SupportThreadRowView({
  row,
  flashing,
  onLongPress,
  onReply,
  onReact,
  onRetry,
  onOpenQuote,
  onOpenPhoto,
  photoMaxWidth,
}: {
  row: SupportThreadRow;
  flashing: boolean;
  onLongPress: (message: SupportMessage) => void;
  onReply: (message: SupportMessage) => void;
  onReact: (message: SupportMessage, emoji: SupportReactionEmoji) => void;
  onRetry: (pending: SupportPendingMessage) => void;
  onOpenQuote: (id: string) => void;
  onOpenPhoto: (messageId: string) => void;
  photoMaxWidth: number;
}) {
  const theme = useAppTheme();

  if (row.kind === 'day') {
    return (
      <View style={{ alignItems: 'center', marginVertical: 10 }}>
        <View
          style={{
            paddingHorizontal: 12,
            paddingVertical: 4,
            borderRadius: appTheme.radii.xs,
            borderCurve: 'continuous',
            backgroundColor: theme.colors.panel,
          }}
        >
          <AppText variant="caption" color="textSecondary" style={{ fontWeight: '600' }}>{row.label}</AppText>
        </View>
      </View>
    );
  }

  if (row.kind === 'unread') {
    return (
      <View style={{ alignItems: 'center', marginVertical: 10, paddingVertical: 4, backgroundColor: theme.colors.panel }}>
        <AppText variant="caption" color="textSecondary" style={{ fontWeight: '700' }}>{row.label.toUpperCase()}</AppText>
      </View>
    );
  }

  const mine = row.kind === 'pending' || row.mine;
  const message = row.kind === 'message' ? row.message : null;
  const pending = row.kind === 'pending' ? row.pending : null;
  const deleted = Boolean(message?.deletedAt);
  const failed = pending?.state === 'failed';
  const quoted = message?.replyTo ?? pending?.replyTo ?? null;
  const body = message ? message.body ?? '' : pending?.body ?? '';
  const time = supportClockLabel(message?.createdAt ?? pending?.createdAt ?? '');
  const reactions = message?.reactions ?? [];
  const actionable = Boolean(message) && !deleted;
  const tailCorner = mine ? 'borderTopRightRadius' : 'borderTopLeftRadius';
  const photo = deleted ? null : message?.attachment ?? null;
  const localPhoto = pending?.photo ?? null;
  const hasPhoto = Boolean(photo || localPhoto);

  const meta = (onMedia: boolean) => (
    <>
      {message?.editedAt && !deleted ? (
        <AppText variant="caption" color={onMedia ? mediaColors.onMedia : 'faint'}>{SUPPORT_WORDS.edited}</AppText>
      ) : null}
      <AppText variant="caption" color={onMedia ? mediaColors.onMedia : 'faint'}>{time}</AppText>
      {pending ? (
        failed
          ? <AlertCircle size={appTheme.icon.xs} color={theme.colors.danger} accessibilityLabel="Not sent" />
          : <Clock3 size={appTheme.icon.xs} color={onMedia ? mediaColors.onMedia : theme.colors.faint} accessibilityLabel={SUPPORT_WORDS.sending} />
      ) : row.kind === 'message' && row.receipt === 'read' ? (
        <CheckCheck size={appTheme.icon.xs} color={theme.colors.info} accessibilityLabel="Read" />
      ) : row.kind === 'message' && row.receipt === 'sent' ? (
        <Check size={appTheme.icon.xs} color={onMedia ? mediaColors.onMedia : theme.colors.faint} accessibilityLabel="Sent" />
      ) : null}
    </>
  );

  const bubble = (
    <View style={{ alignItems: mine ? 'flex-end' : 'flex-start', marginTop: row.startsGroup ? 10 : 3, marginBottom: reactions.length > 0 ? 16 : 0 }}>
      {!mine && row.startsGroup ? (
        <AppText variant="caption" color="muted" style={{ marginLeft: 4, marginBottom: 2 }}>{SUPPORT_WORDS.supportName}</AppText>
      ) : null}
      <Pressable
        // A role and an action list in every state: Android drops neither when a message is deleted.
        accessibilityRole={actionable ? 'button' : 'text'}
        accessibilityHint={actionable ? 'Hold for reactions and actions. Pull right to reply.' : undefined}
        accessibilityActions={actionable ? [{ name: 'longpress', label: SUPPORT_WORDS.moreActions }] : []}
        onAccessibilityAction={() => {
          if (message && actionable) onLongPress(message);
        }}
        onLongPress={message && actionable ? () => onLongPress(message) : undefined}
        delayLongPress={280}
        style={({ pressed }) => ({
          maxWidth: '84%',
          ...(hasPhoto
            ? { padding: 4 }
            : { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 6 }),
          borderRadius: appTheme.radii.lg,
          borderCurve: 'continuous',
          ...(row.startsGroup ? { [tailCorner]: appTheme.radii.xs } : {}),
          backgroundColor: pressed && actionable
            ? theme.state.pressed.background
            : mine ? theme.colors.selected : theme.colors.panel,
          borderWidth: flashing ? 2 : mine ? 0 : 1,
          borderColor: flashing ? theme.colors.primary : theme.colors.borderSubtle,
          opacity: pending && !failed ? appTheme.opacity.disabled : 1,
        })}
      >
        {quoted && !deleted ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Reply to ${supportQuoteAuthorName(quoted.author, 'user')}: ${supportQuoteText(quoted)}`}
            disabled={quoted.deleted}
            onPress={() => onOpenQuote(quoted.id)}
            style={{
              marginBottom: 6,
              paddingVertical: 4,
              paddingLeft: 8,
              paddingRight: 6,
              borderLeftWidth: 3,
              borderLeftColor: theme.colors.primary,
              borderRadius: appTheme.radii.xs,
              borderCurve: 'continuous',
              backgroundColor: theme.colors.surface,
            }}
          >
            <AppText variant="caption" color="primary" numberOfLines={1} style={{ fontWeight: '700' }}>
              {supportQuoteAuthorName(quoted.author, 'user')}
            </AppText>
            <AppText variant="caption" color="textSecondary" numberOfLines={2}>{supportQuoteText(quoted)}</AppText>
          </Pressable>
        ) : null}

        {hasPhoto ? (
          <SupportPhotoView
            messageId={message?.id ?? null}
            photo={photo}
            local={localPhoto}
            maxWidth={photoMaxWidth}
            onPress={message ? () => onOpenPhoto(message.id) : undefined}
            onLongPress={message && actionable ? () => onLongPress(message) : undefined}
          >
            {body ? null : (
              // Over a photo without a caption, the time stands on a dark pill in its corner.
              <View
                style={{
                  position: 'absolute',
                  right: 6,
                  bottom: 6,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 4,
                  paddingHorizontal: 6,
                  paddingVertical: 2,
                  borderRadius: appTheme.radii.pill,
                  backgroundColor: mediaColors.mediaScrimStrong,
                }}
              >
                {meta(true)}
              </View>
            )}
          </SupportPhotoView>
        ) : null}

        {deleted && message ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Ban size={appTheme.icon.xs} color={theme.colors.faint} />
            <AppText variant="body" color="faint" selectable={false} style={{ fontStyle: 'italic' }}>{supportDeletedWords(message, 'user')}</AppText>
          </View>
        ) : hasPhoto && !body ? null : (
          // Not selectable: a long press opens the message's actions, Copy among them, as in a chat app.
          <AppText variant="body" selectable={false} style={hasPhoto ? { paddingHorizontal: 8, paddingTop: 4 } : undefined}>
            {supportTextSegments(body).map((segment) => (segment.kind === 'link' ? (
              <Text
                key={segment.start}
                accessibilityRole="link"
                onPress={() => void Linking.openURL(segment.href)}
                style={{ color: theme.colors.info, textDecorationLine: 'underline' }}
              >
                {segment.text}
              </Text>
            ) : (
              <Text key={segment.start}>{segment.text}</Text>
            )))}
          </AppText>
        )}

        {hasPhoto && !body && !deleted ? null : (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              alignSelf: 'flex-end',
              gap: 4,
              marginTop: 2,
              ...(hasPhoto ? { paddingHorizontal: 8, paddingBottom: 2 } : {}),
            }}
          >
            {meta(false)}
          </View>
        )}

        {reactions.length > 0 && message ? (
          <View style={{ position: 'absolute', bottom: -16, [mine ? 'right' : 'left']: 10, flexDirection: 'row', gap: 2 }}>
            {reactions.map((reaction) => (
              <Pressable
                key={reaction.author}
                accessibilityRole="button"
                accessibilityLabel={reaction.author === 'user'
                  ? `Your reaction ${reaction.emoji}. Remove it`
                  : `${SUPPORT_WORDS.supportName} reacted ${reaction.emoji}`}
                disabled={reaction.author !== 'user'}
                onPress={() => onReact(message, reaction.emoji)}
                hitSlop={{ ...verticalHitSlop(REACTION_PILL_HEIGHT), left: 9, right: 9 }}
                style={{
                  height: REACTION_PILL_HEIGHT,
                  minWidth: REACTION_PILL_HEIGHT,
                  paddingHorizontal: 4,
                  borderRadius: REACTION_PILL_HEIGHT / 2,
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderWidth: 1,
                  borderColor: theme.colors.border,
                  backgroundColor: theme.colors.panelSoft,
                }}
              >
                <Text style={{ fontSize: 15, lineHeight: 20 }}>{reaction.emoji}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
      </Pressable>

      {failed && pending ? (
        <Pressable
          accessibilityRole="button"
          accessibilityHint="Try it again, or delete it."
          onPress={() => onRetry(pending)}
          style={{ minHeight: appTheme.touch.default, justifyContent: 'center' }}
        >
          <AppText variant="caption" color="danger">{SUPPORT_WORDS.notSent}</AppText>
        </Pressable>
      ) : null}
    </View>
  );

  return message && actionable ? (
    <SwipeToReply enabled onReply={() => onReply(message)}>{bubble}</SwipeToReply>
  ) : bubble;
}
