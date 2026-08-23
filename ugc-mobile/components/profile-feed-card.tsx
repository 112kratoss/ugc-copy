import { FileText, Globe, LockKeyhole, MessageCircle, Repeat2, Share2, Wand2 } from 'lucide-react-native';
import { memo } from 'react';
import { Text, View } from 'react-native';

import { FeedCardAction, FeedCardShell } from '@/components/feed-card-shell';
import { PostTextBlock } from '@/components/post-text-block';
import { ShowcaseMediaPreview } from '@/components/showcase-media-preview';
import {
  canExpandProfileFeedBody,
  getProfileFeedMediaHeight,
  type ProfileFeedCard,
} from '@/lib/profile-feed-card-view-model';
import { accentColor, appTheme } from '@/lib/theme';
import { getViewerActionSlots, type ViewerStateTone } from '@/lib/viewer-actions';

export const ProfileFeedCardView = memo(function ProfileFeedCardView({
  card,
  contentWidth,
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
  showActiveVideo: boolean;
  bodyExpanded: boolean;
  pendingAction: string | null;
  onOpen: () => void;
  onToggleBody: () => void;
  onActionsOpen: () => void;
  onAction: (action: string) => void;
}) {
  const accent = accentColor(card.accent);
  const mediaHeight = getProfileFeedMediaHeight(card, contentWidth);
  const item = card.item;
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
      onOpen={onOpen}
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
        <ShowcaseMediaPreview
          accent={accent}
          mediaItems={item.mediaItems}
          width={contentWidth}
          height={mediaHeight}
          radius={0}
          recyclingKey={`profile-feed:${card.id}`}
          videoActivation={showActiveVideo ? 'visible' : 'never'}
          videoBackdrop="none"
          videoContentFit="cover"
        />
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
            borderColor: `${appTheme.colors.commerce}55`,
            backgroundColor: `${appTheme.colors.commerce}1f`,
          }}
        >
          <Text style={{ color: appTheme.colors.commerce, ...appTheme.type.caption, fontWeight: '800' }}>
            {card.unlockLabel}
          </Text>
          <Text numberOfLines={1} style={{ color: appTheme.colors.faint, ...appTheme.type.caption, flex: 1 }}>
            {card.unlockSummary}
          </Text>
        </View>
      ) : null}
      actions={slots.map((slot) => (
        <FeedCardAction
          key={slot.id}
          accessibilityLabel={`${slot.a11yLabel ?? slot.label} — ${card.title}`}
          disabled={Boolean(pendingAction) && pendingAction !== slot.action}
          icon={profileActionIcon(slot.id, item.visibility ?? item.linkedPostVisibility)}
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
  visibility: string | null | undefined
) {
  const muted = appTheme.colors.faint;

  if (id === 'publish') return <Globe size={19} color={appTheme.colors.primary} strokeWidth={2.4} />;
  if (id === 'unlock') return <Wand2 size={19} color={appTheme.colors.success} strokeWidth={2.4} />;
  if (id === 'visibility') {
    // The icon reports where the post (or the creation's linked post) sits now.
    const isPrivate = visibility === 'private' || visibility === 'unlisted';
    return isPrivate
      ? <LockKeyhole size={19} color={appTheme.colors.warning} strokeWidth={2.3} />
      : <Globe size={19} color={appTheme.colors.success} strokeWidth={2.3} />;
  }
  if (id === 'comment') return <MessageCircle size={19} color={muted} strokeWidth={2.2} />;
  if (id === 'share') return <Share2 size={18} color={muted} strokeWidth={2.2} />;
  if (id === 'details') return <FileText size={18} color={muted} strokeWidth={2.2} />;
  return <Repeat2 size={19} color={appTheme.colors.primary} strokeWidth={2.3} />;
}

function ProfileStateChip({ label, tone }: { label: string; tone: ViewerStateTone }) {
  const semantic = tone === 'neutral' ? appTheme.semantic.neutral : appTheme.semantic[tone];

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
