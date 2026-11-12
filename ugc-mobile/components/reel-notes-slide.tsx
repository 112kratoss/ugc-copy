import { router } from 'expo-router';
import { FileText, Heart, MessageCircle, MoreHorizontal } from 'lucide-react-native';
import { memo, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, useWindowDimensions, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';

import { CreatorAvatar } from '@/components/ui';
import { ViewerActionsMenu } from '@/components/viewer-actions-menu';
import { creatorProfilePress } from '@/lib/creator-profile-opening';
import { formatCompactCount } from '@/lib/home-view-model';
import type { ImmersivePreviewItem } from '@/lib/immersive-preview-view-model';
import { ShareGlyph } from '@/lib/platform-glyphs';
import { isRestingOnNote, noteIndexAtOffset } from '@/lib/reel-note-sets';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

/** How much of the neighbouring cards shows at each edge, with the gap between cards. */
const NOTE_CARD_SIDE = 40;
const NOTE_CARD_GAP = 12;
const NOTE_CARD_MAX_HEIGHT = 460;
/** A short note keeps a card's shape; a long one grows to the page's limit. */
const NOTE_CARD_MIN_HEIGHT = 260;
/** The Back button's band above the row, and the dots and label under it. */
const ROW_TOP = 64;
const ROW_FOOTER = 96;
/**
 * A card has a fixed limit, so its type grows with the reader's setting only
 * this far; past it the writing gives lines up and the actions stay in reach.
 */
const NOTE_TEXT_MAX_SCALE = 1.35;
/** A card's padding, header, gaps and action row, which do not grow with the type. */
const NOTE_CARD_FIXED_HEIGHT = 140;
const NOTE_TITLE_LINE_HEIGHT = 28;
const NOTE_TITLE_LINES = 3;
const NOTE_BODY_LINE_HEIGHT = 22;
const NOTE_CARD_EXCLUDED_ACTIONS = ['view-details'];

/**
 * A reel page of notes (owner, 2026-11-12): the lane's posts of writing that
 * sit near each other, as a sideways row of cards (`lib/reel-note-sets.ts`).
 * A note used to take a page each, a small card on a black screen. Here each
 * card names its writer and carries its own Save, Comment, Share and More, so
 * the page has no rail; the card in front is the reel's current post, which is
 * how its views, saves and comments stay that note's own.
 *
 * Sideways moves through the set, up and down through the reel. A card opens
 * the note's own page, where it is read in full.
 */
export const ReelNotesSlide = memo(function ReelNotesSlide({
  active,
  setKey,
  notes,
  frontNoteId,
  label,
  width,
  height,
  topInset,
  bottomInset,
  savingPostId,
  onFrontNoteChange,
  onSave,
  onComments,
  onShare,
  onCreatorOpen,
  onActionsOpen,
  onHorizontalScrollToggle,
  onLayoutAsNeighbour,
  onChromeLayout,
}: {
  active: boolean;
  /** The set's name, handed back with the card that landed. */
  setKey: string;
  notes: ImmersivePreviewItem[];
  /** The reel's current post on this page: the card whose actions are live. */
  frontNoteId: string;
  /** What the set is: "Notes for you", or whose notes on a creator's reel. */
  label: string;
  width: number;
  height: number;
  topInset: number;
  bottomInset: number;
  /** The post a save is on its way for, so its heart waits. */
  savingPostId: string | null;
  onFrontNoteChange: (setKey: string, note: ImmersivePreviewItem) => void;
  onSave: (item: ImmersivePreviewItem) => void;
  onComments: (item: ImmersivePreviewItem) => void;
  onShare: (item: ImmersivePreviewItem) => void;
  onCreatorOpen: (item: ImmersivePreviewItem) => void;
  /** Opens the reel's actions sheet for the post, where there is no native menu. */
  onActionsOpen: (itemId: string) => void;
  onHorizontalScrollToggle?: (scrolling: boolean) => void;
  onLayoutAsNeighbour?: () => void;
  onChromeLayout?: () => void;
}) {
  const theme = useAppTheme();
  const { fontScale } = useWindowDimensions();
  const textScale = Math.min(fontScale, NOTE_TEXT_MAX_SCALE);
  const cardWidth = width - NOTE_CARD_SIDE * 2;
  const interval = cardWidth + NOTE_CARD_GAP;
  const cardHeight = Math.min(NOTE_CARD_MAX_HEIGHT, height - topInset - bottomInset - ROW_TOP - ROW_FOOTER);
  const frontIndex = Math.max(0, notes.findIndex((note) => note.id === frontNoteId));
  const rowRef = useRef<ScrollView>(null);
  // Applied as the scroll view is created, so a set the reader comes back to
  // is already on the card they left.
  const [initialOffset] = useState(() => ({ x: frontIndex * interval, y: 0 }));
  // The dots and the dimming follow the finger; the reel's current post moves
  // once the row is at rest on a card.
  const [dotIndex, setDotIndex] = useState(frontIndex);
  const shownIndex = Math.min(dotIndex, notes.length - 1);
  /** The card the row itself last came to rest on. */
  const restingIndexRef = useRef(frontIndex);

  // The reel can move the front card without a swipe: a card ahead of it is
  // removed (a block from another page), or a refresh drops one. The row
  // follows, so the card in the middle is always the reel's current post.
  useEffect(() => {
    if (restingIndexRef.current === frontIndex) return;
    restingIndexRef.current = frontIndex;
    setDotIndex(frontIndex);
    rowRef.current?.scrollTo({ x: frontIndex * interval, y: 0, animated: false });
  }, [frontIndex, interval]);

  // At rest on a card, by whichever event says so first: a drag let go without
  // a fling ends with no momentum event at all.
  const settleAt = (offsetX: number) => {
    if (!isRestingOnNote(offsetX, interval)) return;
    const index = noteIndexAtOffset(offsetX, interval, notes.length);
    restingIndexRef.current = index;
    const landed = notes[index];
    if (landed && landed.id !== frontNoteId) onFrontNoteChange(setKey, landed);
  };
  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const offsetX = event.nativeEvent.contentOffset.x;
    setDotIndex(noteIndexAtOffset(offsetX, interval, notes.length));
    settleAt(offsetX);
  };
  const onDragOrMomentumEnd = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    onHorizontalScrollToggle?.(false);
    settleAt(event.nativeEvent.contentOffset.x);
  };

  return (
    <View
      collapsable={false}
      onLayout={() => {
        onLayoutAsNeighbour?.();
        onChromeLayout?.();
      }}
      accessibilityElementsHidden={!active}
      importantForAccessibility={active ? 'auto' : 'no-hide-descendants'}
      style={{ width, height, paddingTop: topInset + ROW_TOP, paddingBottom: bottomInset + 20, justifyContent: 'center', backgroundColor: theme.colors.app }}
    >
      <ScrollView
        ref={rowRef}
        horizontal
        // No field on this page; a tap with a keyboard up from elsewhere still reaches the cards.
        keyboardShouldPersistTaps="handled"
        contentOffset={initialOffset}
        decelerationRate="fast"
        snapToInterval={interval}
        disableIntervalMomentum
        scrollEnabled={active && notes.length > 1}
        scrollEventThrottle={32}
        showsHorizontalScrollIndicator={false}
        onScroll={onScroll}
        onScrollBeginDrag={() => onHorizontalScrollToggle?.(true)}
        onScrollEndDrag={onDragOrMomentumEnd}
        onMomentumScrollEnd={onDragOrMomentumEnd}
        style={{ flexGrow: 0 }}
        // Each card is as tall as its note, so the row is centred on its middle.
        contentContainerStyle={{ paddingHorizontal: NOTE_CARD_SIDE, gap: NOTE_CARD_GAP, alignItems: 'center' }}
      >
        {notes.map((note, index) => (
          <NoteCard
            key={note.id}
            note={note}
            current={note.id === frontNoteId}
            dimmed={index !== shownIndex}
            menuEnabled={active && note.id === frontNoteId}
            width={cardWidth}
            height={cardHeight}
            textScale={textScale}
            saving={savingPostId !== null && savingPostId === note.showcasePostId}
            onSave={onSave}
            onComments={onComments}
            onShare={onShare}
            onCreatorOpen={onCreatorOpen}
            onActionsOpen={onActionsOpen}
          />
        ))}
      </ScrollView>

      <View style={{ paddingHorizontal: NOTE_CARD_SIDE, paddingTop: 16, gap: 14 }}>
        {notes.length > 1 ? (
          <View accessible accessibilityLabel={`Note ${shownIndex + 1} of ${notes.length}`} style={{ flexDirection: 'row', justifyContent: 'center', gap: 5 }}>
            {notes.map((note, index) => (
              <View
                key={note.id}
                style={{ width: index === shownIndex ? 16 : 5, height: 5, borderRadius: appTheme.radii.pill, backgroundColor: index === shownIndex ? theme.colors.primary : theme.colors.borderStrong }}
              />
            ))}
          </View>
        ) : null}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <FileText size={appTheme.icon.sm} color={theme.colors.primary} />
          <Text numberOfLines={1} maxFontSizeMultiplier={NOTE_TEXT_MAX_SCALE} style={{ flexShrink: 1, color: theme.colors.text, ...appTheme.type.label, fontWeight: '800' }}>{label}</Text>
          <Text maxFontSizeMultiplier={NOTE_TEXT_MAX_SCALE} style={{ color: theme.colors.muted, ...appTheme.type.caption }}>
            {notes.length === 1 ? '1 note' : `${notes.length} notes`}
          </Text>
        </View>
      </View>
    </View>
  );
});

function NoteCard({
  note,
  current,
  dimmed,
  menuEnabled,
  width,
  height,
  textScale,
  saving,
  onSave,
  onComments,
  onShare,
  onCreatorOpen,
  onActionsOpen,
}: {
  note: ImmersivePreviewItem;
  /** The reel's current post: the comments sheet, the save and the menu are this card's. */
  current: boolean;
  /** A neighbour of the card in the middle steps back. */
  dimmed: boolean;
  /** Builds the native menu, for the one card that can be pressed. */
  menuEnabled: boolean;
  width: number;
  /** The tallest a card may be on this page. */
  height: number;
  textScale: number;
  saving: boolean;
  onSave: (item: ImmersivePreviewItem) => void;
  onComments: (item: ImmersivePreviewItem) => void;
  onShare: (item: ImmersivePreviewItem) => void;
  onCreatorOpen: (item: ImmersivePreviewItem) => void;
  onActionsOpen: (itemId: string) => void;
}) {
  const theme = useAppTheme();
  const canOpenCreator = Boolean(note.creatorUsername);
  // A title that only repeats the writing is shown once, as the title.
  const body = note.displayText.trim() === note.title.trim() ? '' : note.displayText;
  // Whole lines of writing in what the title, at its longest, and the fixed
  // parts leave, at the size the reader's setting draws them.
  const bodyRoom = height - NOTE_CARD_FIXED_HEIGHT - NOTE_TITLE_LINES * NOTE_TITLE_LINE_HEIGHT * textScale;
  const bodyLines = Math.max(2, Math.floor(bodyRoom / (NOTE_BODY_LINE_HEIGHT * textScale)));

  return (
    // Not one button around everything: a screen reader could then reach
    // nothing inside it. The writing is the button that opens the note, and
    // the writer, the actions and the menu are each their own.
    <View
      style={{
        width,
        minHeight: Math.min(NOTE_CARD_MIN_HEIGHT, height),
        maxHeight: height,
        overflow: 'hidden',
        borderRadius: appTheme.radii.xl,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.panel,
        paddingLeft: 22,
        paddingRight: 18,
        paddingTop: 18,
        paddingBottom: 8,
        opacity: dimmed ? 0.5 : 1,
      }}
    >
      <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, backgroundColor: theme.colors.primary }} />

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${note.creatorLabel} profile`}
          disabled={!canOpenCreator}
          {...creatorProfilePress(note.creatorUsername, () => onCreatorOpen(note))}
          hitSlop={8}
          style={({ pressed }) => ({ flexShrink: 1, flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 32, opacity: pressed ? appTheme.opacity.pressed : 1 })}
        >
          <CreatorAvatar uri={note.creatorAvatar} name={note.creatorLabel.replace(/^@/, '')} size={28} />
          <Text numberOfLines={1} maxFontSizeMultiplier={NOTE_TEXT_MAX_SCALE} style={{ flexShrink: 1, color: theme.colors.text, ...appTheme.type.label, fontWeight: '700' }}>{note.creatorLabel}</Text>
        </Pressable>
        <View style={{ marginLeft: 'auto', borderRadius: appTheme.radii.pill, backgroundColor: theme.colors.surfaceStrong, paddingHorizontal: 10, paddingVertical: 5 }}>
          <Text numberOfLines={1} maxFontSizeMultiplier={NOTE_TEXT_MAX_SCALE} style={{ color: theme.colors.textSecondary, fontSize: 11, lineHeight: 13, fontWeight: '800' }}>{note.badge}</Text>
        </View>
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Read the note ${note.title}, by ${note.creatorLabel}`}
        onPress={() => {
          if (note.showcasePostId) router.push(`/post/${encodeURIComponent(note.showcasePostId)}` as never);
        }}
        // The part that gives way when the type is large: the actions under it keep their place.
        style={({ pressed }) => ({ flexGrow: 1, flexShrink: 1, overflow: 'hidden', marginTop: 16, marginBottom: 12, opacity: pressed ? appTheme.opacity.pressed : 1 })}
      >
        <Text numberOfLines={NOTE_TITLE_LINES} maxFontSizeMultiplier={NOTE_TEXT_MAX_SCALE} style={{ color: theme.colors.text, fontSize: 22, lineHeight: NOTE_TITLE_LINE_HEIGHT, fontWeight: '800' }}>
          {note.title}
        </Text>
        {body ? (
          <Text numberOfLines={bodyLines} maxFontSizeMultiplier={NOTE_TEXT_MAX_SCALE} style={{ marginTop: 10, color: theme.colors.textSecondary, fontSize: 15, lineHeight: NOTE_BODY_LINE_HEIGHT }}>
            {body}
          </Text>
        ) : null}
      </Pressable>

      {/* Only the reel's current post has a comments sheet, a save and a menu
          to answer: a neighbour's row waits, for a finger and for a screen
          reader alike, until its card has been swiped to. */}
      <View
        pointerEvents={current ? 'auto' : 'none'}
        accessibilityElementsHidden={!current}
        importantForAccessibility={current ? 'auto' : 'no-hide-descendants'}
        style={{ flexShrink: 0, flexDirection: 'row', alignItems: 'center', marginLeft: -10 }}
      >
        {note.canSave ? (
          <CardAction
            label={note.isSaved ? `Remove ${note.title} from saved` : `Save ${note.title}`}
            count={note.saveCount}
            disabled={saving}
            onPress={() => onSave(note)}
            icon={<Heart size={appTheme.icon.default} color={note.isSaved ? theme.colors.primary : theme.colors.textSecondary} fill={note.isSaved ? theme.colors.primary : 'none'} />}
          />
        ) : null}
        {note.canComment ? (
          <CardAction
            label={`Comments on ${note.title}`}
            count={note.commentCount}
            onPress={() => onComments(note)}
            icon={<MessageCircle size={appTheme.icon.default} color={theme.colors.textSecondary} />}
          />
        ) : null}
        {note.canShare ? (
          <CardAction
            label={`Share ${note.title}`}
            onPress={() => onShare(note)}
            icon={<ShareGlyph size={appTheme.icon.default} color={theme.colors.textSecondary} />}
          />
        ) : null}
        {/* Not interested, Hide and Report live in the reel's menu: a page of
            notes has no rail, so each card keeps the menu for its own note. */}
        <ViewerActionsMenu
          item={note}
          // A page of notes has no Details page to slide to; the note's own page has it.
          excludeActions={NOTE_CARD_EXCLUDED_ACTIONS}
          enabled={menuEnabled}
          accessibilityLabel={`More options for ${note.title}`}
          trigger={{ width: appTheme.touch.default, height: appTheme.touch.default, iconSize: appTheme.icon.default, iconColor: theme.colors.textSecondary }}
          onFallbackPress={() => onActionsOpen(note.id)}
          renderButton={(onPress) => (
            <CardAction
              label={`More options for ${note.title}`}
              onPress={onPress}
              icon={<MoreHorizontal size={appTheme.icon.default} color={theme.colors.textSecondary} />}
            />
          )}
        />
        <Text
          accessible={false}
          importantForAccessibility="no"
          maxFontSizeMultiplier={NOTE_TEXT_MAX_SCALE}
          style={{ marginLeft: 'auto', color: theme.colors.primary, ...appTheme.type.caption, fontWeight: '800' }}
        >
          Read note
        </Text>
      </View>
    </View>
  );
}

function CardAction({ label, count, disabled, icon, onPress }: { label: string; count?: number; disabled?: boolean; icon: React.ReactNode; onPress: () => void }) {
  const theme = useAppTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minWidth: appTheme.touch.default,
        minHeight: appTheme.touch.default,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 5,
        paddingHorizontal: 10,
        opacity: pressed || disabled ? appTheme.opacity.pressed : 1,
      })}
    >
      {icon}
      {count ? (
        <Text maxFontSizeMultiplier={NOTE_TEXT_MAX_SCALE} style={{ color: theme.colors.textSecondary, ...appTheme.type.caption, fontVariant: ['tabular-nums'] }}>{formatCompactCount(count)}</Text>
      ) : null}
    </Pressable>
  );
}
