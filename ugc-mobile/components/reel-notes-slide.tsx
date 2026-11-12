import { router } from 'expo-router';
import { FileText, Heart, MessageCircle } from 'lucide-react-native';
import { memo, useState } from 'react';
import { Pressable, ScrollView, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';

import { CreatorAvatar } from '@/components/ui';
import { creatorProfilePress } from '@/lib/creator-profile-opening';
import { formatCompactCount } from '@/lib/home-view-model';
import type { ImmersivePreviewItem } from '@/lib/immersive-preview-view-model';
import { ShareGlyph } from '@/lib/platform-glyphs';
import { noteIndexAtOffset } from '@/lib/reel-note-sets';
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
 * A reel page of notes (owner, 2026-11-12): the lane's posts of writing that
 * sit near each other, as a sideways row of cards (`lib/reel-note-sets.ts`).
 * A note used to take a page each, a small card on a black screen. Here each
 * card names its writer and carries its own Save, Comment and Share, so the
 * page has no rail; the card in front is the reel's current post, which is how
 * its views, saves and comments stay that note's own.
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
  onHorizontalScrollToggle,
  onLayoutAsNeighbour,
  onChromeLayout,
}: {
  active: boolean;
  /** The set's name, handed back with the card that landed. */
  setKey: string;
  notes: ImmersivePreviewItem[];
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
  onHorizontalScrollToggle?: (scrolling: boolean) => void;
  onLayoutAsNeighbour?: () => void;
  onChromeLayout?: () => void;
}) {
  const theme = useAppTheme();
  const cardWidth = width - NOTE_CARD_SIDE * 2;
  const interval = cardWidth + NOTE_CARD_GAP;
  const cardHeight = Math.min(NOTE_CARD_MAX_HEIGHT, height - topInset - bottomInset - ROW_TOP - ROW_FOOTER);
  const frontIndex = Math.max(0, notes.findIndex((note) => note.id === frontNoteId));
  // Applied as the scroll view is created, so a set the reader comes back to
  // is already on the card they left.
  const [initialOffset] = useState(() => ({ x: frontIndex * interval, y: 0 }));
  // The dots follow the finger; the reel's current post moves once a card has landed.
  const [dotIndex, setDotIndex] = useState(frontIndex);

  const settle = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const index = noteIndexAtOffset(event.nativeEvent.contentOffset.x, interval, notes.length);
    setDotIndex(index);
    onHorizontalScrollToggle?.(false);
    const landed = notes[index];
    if (landed && landed.id !== frontNoteId) onFrontNoteChange(setKey, landed);
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
        onScroll={(event) => setDotIndex(noteIndexAtOffset(event.nativeEvent.contentOffset.x, interval, notes.length))}
        onScrollBeginDrag={() => onHorizontalScrollToggle?.(true)}
        onScrollEndDrag={() => onHorizontalScrollToggle?.(false)}
        onMomentumScrollEnd={settle}
        style={{ flexGrow: 0 }}
        // Each card is as tall as its note, so the row is centred on its middle.
        contentContainerStyle={{ paddingHorizontal: NOTE_CARD_SIDE, gap: NOTE_CARD_GAP, alignItems: 'center' }}
      >
        {notes.map((note, index) => (
          <NoteCard
            key={note.id}
            note={note}
            front={index === dotIndex}
            width={cardWidth}
            height={cardHeight}
            saving={savingPostId !== null && savingPostId === note.showcasePostId}
            onSave={onSave}
            onComments={onComments}
            onShare={onShare}
            onCreatorOpen={onCreatorOpen}
          />
        ))}
      </ScrollView>

      <View style={{ paddingHorizontal: NOTE_CARD_SIDE, paddingTop: 16, gap: 14 }}>
        {notes.length > 1 ? (
          <View accessible accessibilityLabel={`Note ${dotIndex + 1} of ${notes.length}`} style={{ flexDirection: 'row', justifyContent: 'center', gap: 5 }}>
            {notes.map((note, index) => (
              <View
                key={note.id}
                style={{ width: index === dotIndex ? 16 : 5, height: 5, borderRadius: appTheme.radii.pill, backgroundColor: index === dotIndex ? theme.colors.primary : theme.colors.borderStrong }}
              />
            ))}
          </View>
        ) : null}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <FileText size={appTheme.icon.sm} color={theme.colors.primary} />
          <Text numberOfLines={1} style={{ flexShrink: 1, color: theme.colors.text, ...appTheme.type.label, fontWeight: '800' }}>{label}</Text>
          <Text style={{ color: theme.colors.muted, ...appTheme.type.caption }}>
            {notes.length === 1 ? '1 note' : `${notes.length} notes`}
          </Text>
        </View>
      </View>
    </View>
  );
});

function NoteCard({
  note,
  front,
  width,
  height,
  saving,
  onSave,
  onComments,
  onShare,
  onCreatorOpen,
}: {
  note: ImmersivePreviewItem;
  /** The card in the middle; its neighbours step back. */
  front: boolean;
  width: number;
  /** The tallest a card may be on this page. */
  height: number;
  saving: boolean;
  onSave: (item: ImmersivePreviewItem) => void;
  onComments: (item: ImmersivePreviewItem) => void;
  onShare: (item: ImmersivePreviewItem) => void;
  onCreatorOpen: (item: ImmersivePreviewItem) => void;
}) {
  const theme = useAppTheme();
  const canOpenCreator = Boolean(note.creatorUsername);
  // A title that only repeats the writing is shown once, as the title.
  const body = note.displayText.trim() === note.title.trim() ? '' : note.displayText;
  // Header, title, actions and the padding leave this much for the writing.
  const bodyLines = Math.max(3, Math.floor((height - 250) / 22));

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Read the note ${note.title}, by ${note.creatorLabel}`}
      onPress={() => {
        if (note.showcasePostId) router.push(`/post/${encodeURIComponent(note.showcasePostId)}` as never);
      }}
      style={({ pressed }) => ({
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
        opacity: pressed ? appTheme.opacity.pressed : front ? 1 : 0.5,
      })}
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
          <Text numberOfLines={1} style={{ flexShrink: 1, color: theme.colors.text, ...appTheme.type.label, fontWeight: '700' }}>{note.creatorLabel}</Text>
        </Pressable>
        <View style={{ marginLeft: 'auto', borderRadius: appTheme.radii.pill, backgroundColor: theme.colors.surfaceStrong, paddingHorizontal: 10, paddingVertical: 5 }}>
          <Text numberOfLines={1} style={{ color: theme.colors.textSecondary, fontSize: 11, lineHeight: 13, fontWeight: '800' }}>{note.badge}</Text>
        </View>
      </View>

      <Text numberOfLines={3} style={{ marginTop: 16, color: theme.colors.text, fontSize: 22, lineHeight: 28, fontWeight: '800' }}>
        {note.title}
      </Text>
      <View style={{ flexGrow: 1, marginTop: 10, marginBottom: 12 }}>
        {body ? (
          <Text numberOfLines={bodyLines} style={{ color: theme.colors.textSecondary, fontSize: 15, lineHeight: 22 }}>
            {body}
          </Text>
        ) : null}
      </View>

      {/* Only the card in front is the reel's current post, which is the one
          the comments sheet and the save belong to: a neighbour's row waits
          until its card has been swiped to. */}
      <View pointerEvents={front ? 'auto' : 'none'} style={{ flexDirection: 'row', alignItems: 'center', marginLeft: -10 }}>
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
        <Text style={{ marginLeft: 'auto', color: theme.colors.primary, ...appTheme.type.caption, fontWeight: '800' }}>Read note</Text>
      </View>
    </Pressable>
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
        <Text style={{ color: theme.colors.textSecondary, ...appTheme.type.caption, fontVariant: ['tabular-nums'] }}>{formatCompactCount(count)}</Text>
      ) : null}
    </Pressable>
  );
}
