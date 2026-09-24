import { FileText, Globe, ImageOff, LockKeyhole, MessageCircle, Repeat2, Wand2 } from 'lucide-react-native';
import { memo } from 'react';
import { Text, View } from 'react-native';

import { FeedCardAction, FeedCardShell } from '@/components/feed-card-shell';
import { MediaZoomSourceView, useMediaZoomSource } from '@/components/media-zoom';
import type { AppleZoomOpen } from '@/lib/apple-zoom';
import { PostTextBlock } from '@/components/post-text-block';
import { ShowcaseMediaPreview } from '@/components/showcase-media-preview';
import {
  canExpandProfileFeedBody,
  getProfileFeedMediaHeight,
  type ProfileFeedCard,
} from '@/lib/profile-feed-card-view-model';
import { mediaItemAspectRatio, showcaseMediaZoomPreview } from '@/lib/media-zoom-transition';
import { ShareGlyph } from '@/lib/platform-glyphs';
import { accentColor, appTheme, type ThemeColors } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';
import { getViewerActionSlots, type ViewerStateTone } from '@/lib/viewer-actions';

export const ProfileFeedCardView = memo(function ProfileFeedCardView({
  card,
  contentWidth,
  mediaWatchdog = false,
  showActiveVideo,
  bodyExpanded,
  pendingAction,
  onOpen,
  onToggleBody,
  onActionsOpen,
  onAction,
}: {
  card: ProfileFeedCard;
  contentWidth: number;
  /** Arms display deadlines for the card's media; only while the feed is focused. */
  mediaWatchdog?: boolean;
  showActiveVideo: boolean;
  bodyExpanded: boolean;
  pendingAction: string | null;
  /** Opens the post, carrying the zoom the tile hands the push on iOS 18 (lib/apple-zoom.ts). */
  onOpen: (zoom: AppleZoomOpen | null) => void;
  onToggleBody: () => void;
  onActionsOpen: () => void;
  onAction: (action: string) => void;
}) {
  const theme = useAppTheme();
  const accent = accentColor(card.accent, theme.colors);
  const mediaHeight = getProfileFeedMediaHeight(card, contentWidth);
  const item = card.item;
  // The media is what opens: the reel grows out of this rectangle and shrinks
  // back into it.
  const zoomSource = useMediaZoomSource({
    itemId: item.id,
    // The media's shape as the reel reads it — not the card's, which caps tall
    // media at 4:5 and crops the rest.
    aspectRatio: mediaItemAspectRatio(item.mediaItems?.[0]),
    preview: showcaseMediaZoomPreview(item.mediaItems?.[0]),
    // The card already holds the post as the reel lists it, so the window it
    // grows in carries the rail and caption with it.
    post: item,
    enabled: card.hasMedia,
  });
  // The card drops the Details slot: tapping the card already opens its canonical
  // viewer, and five labelled actions wrap onto a second row.
  const slots = getViewerActionSlots(item).filter((slot) => slot.id !== 'details');

  return (
    <FeedCardShell
      accent={accent}
      categoryLabel={card.categoryLabel}
      creatorAvatar={card.creatorAvatar}
      creatorLabel={card.creatorLabel}
      creatorName={card.creatorName}
      onMorePress={onActionsOpen}
      moreAccessibilityLabel={`More options for ${card.title}`}
      onOpen={() => zoomSource.capture(onOpen)}
      onOpenTouchStart={zoomSource.prepare}
      openAccessibilityLabel={`Open ${card.title}`}
      statusChip={card.state ? <ProfileStateChip label={card.state.label} tone={card.state.tone} /> : null}
      timeLabel={card.timeLabel}
      title={card.title}
      body={card.bodyText ? (
        <PostTextBlock
          text={card.bodyText}
          clampLines={card.bodyLines}
          canExpand={canExpandProfileFeedBody(card, contentWidth - appTheme.spacing.card * 2)}
          expanded={bodyExpanded}
          onToggle={onToggleBody}
        />
      ) : null}
      media={card.hasMedia ? (
        <MediaZoomSourceView source={zoomSource}>
          <ShowcaseMediaPreview
            accent={accent}
            mediaItems={item.mediaItems}
            width={contentWidth}
            height={mediaHeight}
            radius={0}
            recyclingKey={`profile-feed:${card.id}`}
            videoActivation={showActiveVideo ? 'visible' : 'never'}
            watchdog={mediaWatchdog}
            diagnosticsSurface="profile-feed"
            videoBackdrop="none"
            videoContentFit="cover"
          />
        </MediaZoomSourceView>
      ) : card.sourceUnavailable ? (
        <UnavailableMediaPlate height={mediaHeight} />
      ) : null}
      banner={card.unlockLabel ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: appTheme.spacing.compact,
            marginHorizontal: appTheme.spacing.card,
            marginTop: appTheme.spacing.gap,
            paddingHorizontal: appTheme.spacing.gap,
            paddingVertical: appTheme.spacing.compact,
            borderRadius: appTheme.radii.sm,
            borderCurve: 'continuous',
            borderWidth: 1,
            borderColor: `${theme.colors.commerce}55`,
            backgroundColor: `${theme.colors.commerce}1f`,
          }}
        >
          <Text style={{ color: theme.colors.commerce, ...appTheme.type.caption, fontWeight: '800' }}>
            {card.unlockLabel}
          </Text>
          <Text numberOfLines={1} style={{ color: theme.colors.faint, ...appTheme.type.caption, flex: 1 }}>
            {card.unlockSummary}
          </Text>
        </View>
      ) : null}
      actions={slots.map((slot) => (
        <FeedCardAction
          key={slot.id}
          accessibilityLabel={`${slot.a11yLabel ?? slot.label} — ${card.title}`}
          disabled={Boolean(pendingAction) && pendingAction !== slot.action}
          icon={profileActionIcon(slot.id, item.visibility ?? item.linkedPostVisibility, theme.colors)}
          // Share reads from its icon alone, the same as on the Home card, which
          // keeps the ownership actions the only labelled things in the row.
          label={slot.id === 'share' ? undefined : slot.label}
          onPress={() => slot.action && onAction(slot.action)}
          tone={slot.tone}
        />
      ))}
    />
  );
});

function profileActionIcon(
  id: string,
  visibility: string | null | undefined,
  colors: ThemeColors,
) {
  const muted = colors.faint;

  if (id === 'publish') return <Globe size={appTheme.icon.default} color={colors.primary} />;
  if (id === 'unlock') return <Wand2 size={appTheme.icon.default} color={colors.success} />;
  if (id === 'visibility') {
    // The icon reports where the post (or the creation's linked post) sits now.
    const isPrivate = visibility === 'private' || visibility === 'unlisted';
    return isPrivate
      ? <LockKeyhole size={appTheme.icon.default} color={colors.warning} />
      : <Globe size={appTheme.icon.default} color={colors.success} />;
  }
  if (id === 'comment') return <MessageCircle size={appTheme.icon.default} color={muted} />;
  if (id === 'share') return <ShareGlyph size={18} color={muted} />;
  if (id === 'details') return <FileText size={18} color={muted} />;
  return <Repeat2 size={appTheme.icon.default} color={colors.primary} />;
}

/**
 * Where a creation whose only file is gone would draw its media. The card is the
 * one the reader tapped, so it shows that creation's own state — the same words
 * as its grid tile — rather than no media at all, and never asks for the file.
 */
function UnavailableMediaPlate({ height }: { height: number }) {
  const theme = useAppTheme();
  return (
    <View
      testID="profile-feed-media-unavailable"
      accessible
      accessibilityLabel="This file is no longer available. Its only copy expired at the provider before it could be saved."
      style={{
        height,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        paddingHorizontal: appTheme.spacing.card,
        backgroundColor: theme.colors.surfaceInset,
      }}
    >
      <ImageOff size={appTheme.icon.feature} color={theme.colors.faint} />
      <Text style={{ color: theme.colors.text, ...appTheme.type.label, textAlign: 'center' }}>
        This file is no longer available
      </Text>
      <Text style={{ color: theme.colors.muted, ...appTheme.type.caption, textAlign: 'center' }}>
        Its only copy expired at the provider before it could be saved.
      </Text>
    </View>
  );
}

function ProfileStateChip({ label, tone }: { label: string; tone: ViewerStateTone }) {
  const theme = useAppTheme();
  const semantic = tone === 'neutral' ? theme.semantic.neutral : theme.semantic[tone];

  return (
    <View
      style={{
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: appTheme.radii.pill,
        borderWidth: 1,
        borderColor: semantic.border,
        backgroundColor: semantic.background,
      }}
    >
      <Text style={{ color: semantic.foreground, ...appTheme.type.caption, fontSize: 11, fontWeight: '800' }}>
        {label}
      </Text>
    </View>
  );
}
