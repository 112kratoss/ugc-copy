import { router } from 'expo-router';
import { Coins, Gift, ImageIcon, Play, Rocket, Send, Video, type LucideIcon } from 'lucide-react-native';
import { Pressable, ScrollView, useWindowDimensions, View, type ViewStyle } from 'react-native';

import { StableMediaImage } from '@/components/media-preview';
import { SkeletonBone } from '@/components/skeleton';
import { AppText } from '@/components/ui';
import { hexWithAlpha, linearGradient } from '@/lib/eased-fade';
import { verticalHitSlop } from '@/lib/hit-target';
import {
  HOME_SHELF_START_BLANK_TOOLS,
  formatActiveRenders,
  formatHomeShelfPrice,
  getHomeShelfCardSize,
  homeShelfActionCopy,
  homeShelfBadge,
  homeShelfCreationHint,
  homeShelfCreationLabel,
  homeShelfCreatorLabel,
  homeShelfPosterCacheKey,
  type HomeShelfActionIcon,
} from '@/lib/home-shelf-view-model';
import { MotionView, usePressMotion } from '@/lib/motion';
import { accentColor, appTheme, mediaColors } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';
import type { HomeShelfAction, HomeShelfCreation, HomeShelfItem } from '@/lib/types';

/**
 * Home's "Make this" shelf: real creations a viewer can make their own in one
 * tap, with at most two offers for a signed-in member (the server picks them,
 * `GET /api/home/shelf`). A row that holds still: two cards and a sliver of
 * the third, moved only by the person. No page control: it is not page by
 * page, and the sliver is what says it scrolls.
 *
 * The row keeps one height in every state, because it sits in the feed's list
 * header and FlashList anchors on it: placeholders while the first answer
 * loads, the creations once it lands, and the three tools when there are none
 * (an empty lineup, or a failed read). The renders-in-progress line takes the
 * subtitle's place for the same reason.
 */

const SHELF_GAP = appTheme.spacing.gap;
const CARD_RADIUS = appTheme.radii.lg;
const ROW_HEIGHT = 36;

// The shade under a card's captions, drawn by the render server (a
// CAGradientLayer on iOS) like the feed's. It shades pictures, so it is the
// media ground in both schemes.
const CAPTION_SHADE: ViewStyle = {
  position: 'absolute',
  inset: 0,
  experimental_backgroundImage: linearGradient('to bottom', [
    { color: hexWithAlpha(mediaColors.mediaGround, 0.04), at: 0 },
    { color: hexWithAlpha(mediaColors.mediaGround, 0.08), at: 0.42 },
    { color: hexWithAlpha(mediaColors.mediaGround, 0.8), at: 1 },
  ]),
};

const ACTION_ICONS: Record<HomeShelfActionIcon, LucideIcon> = {
  send: Send,
  gift: Gift,
  coins: Coins,
};

const TOOL_ICONS: Record<(typeof HOME_SHELF_START_BLANK_TOOLS)[number]['id'], LucideIcon> = {
  image: ImageIcon,
  video: Video,
  motion: Rocket,
};

export function HomeShelf({
  items,
  isLoading,
  offerFreeToTry,
  signsInFirst = false,
  horizontalPadding,
  contentWidth,
  activeRenders,
  pendingId,
  onMake,
}: {
  items: HomeShelfItem[];
  /** The first answer has not come yet. */
  isLoading: boolean;
  /** Signed out or a guest: still owed the welcome credits "Free to try" promises. */
  offerFreeToTry: boolean;
  /** Signed out or a guest: "Make this" opens sign-in first, and the hint says so. */
  signsInFirst?: boolean;
  horizontalPadding: number;
  contentWidth: number;
  /** The viewer's renders in flight; the line that opens Creations shows while there are any. */
  activeRenders: number;
  /** The post whose remix is being opened: every card waits for it. */
  pendingId: string | null;
  onMake: (creation: HomeShelfCreation) => void;
}) {
  const { fontScale } = useWindowDimensions();
  const card = getHomeShelfCardSize(contentWidth, SHELF_GAP, fontScale, appTheme.typeScale.control);
  const empty = !isLoading && items.length === 0;

  return (
    <View style={{ gap: appTheme.spacing.compact }}>
      <View
        style={{
          paddingHorizontal: horizontalPadding,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: appTheme.spacing.gap,
        }}
      >
        <View style={{ flexShrink: 1 }}>
          {/* Drawn at launch, before the display face loads: AppText draws it
              again in the face once it is in. */}
          <AppText variant="cardTitle" heading numberOfLines={1}>
            {empty ? 'Start creating' : 'Make this'}
          </AppText>
          {activeRenders > 0 ? (
            <ActiveRendersLine count={activeRenders} />
          ) : (
            // As tall as the renders line it gives way to, so neither moves the feed.
            <View style={{ minHeight: 44, justifyContent: 'center' }}>
              <AppText variant="caption" color="muted" numberOfLines={1}>
                {empty ? 'Pick a tool and write your own prompt' : 'Real creations, one tap to make your own'}
              </AppText>
            </View>
          )}
        </View>
        {empty || isLoading ? null : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="See all creations"
            accessibilityHint="Opens Explore"
            onPress={() => router.push('/(tabs)/showcase' as never)}
            style={({ pressed }) => ({
              minHeight: 44,
              minWidth: 44,
              justifyContent: 'center',
              opacity: pressed ? appTheme.opacity.pressed : 1,
            })}
          >
            <AppText variant="label" color="muted" numberOfLines={1}>See all</AppText>
          </Pressable>
        )}
      </View>

      <ScrollView
        horizontal
        // A tap on a card with the keyboard up (the search over Home) opens it
        // rather than only putting the keyboard away.
        keyboardShouldPersistTaps="handled"
        showsHorizontalScrollIndicator={false}
        // The row scrolls freely and comes to rest on a card's edge, which is
        // what the gutter-wide padding below lines up with.
        snapToInterval={card.width + SHELF_GAP}
        snapToAlignment="start"
        decelerationRate="fast"
        scrollEnabled={!isLoading}
        // Each card is the shape's height at least, and the row stretches them
        // all to its tallest: an offer whose terms need more room (a 360dp
        // phone, larger text) makes the whole row taller instead of being cut.
        contentContainerStyle={{ paddingHorizontal: horizontalPadding, gap: SHELF_GAP, alignItems: 'stretch' }}
      >
        {isLoading ? (
          <View
            accessible
            accessibilityRole="progressbar"
            accessibilityLabel="Loading creations"
            style={{ flexDirection: 'row', gap: SHELF_GAP }}
          >
            {[0, 1, 2].map((slot) => (
              <SkeletonBone key={slot} width={card.width} height={card.height} radius={CARD_RADIUS} strong={slot === 0} />
            ))}
          </View>
        ) : empty ? (
          HOME_SHELF_START_BLANK_TOOLS.map((tool) => (
            <ToolCard key={tool.id} tool={tool} width={card.width} height={card.height} />
          ))
        ) : (
          <>
            {items.map((item) => (item.kind === 'creation' ? (
              <CreationCard
                key={`creation-${item.id}`}
                creation={item}
                offerFreeToTry={offerFreeToTry}
                signsInFirst={signsInFirst}
                width={card.width}
                height={card.height}
                pending={pendingId === item.post.id}
                disabled={pendingId !== null}
                onMake={onMake}
              />
            ) : (
              <ActionCard key={`action-${item.id}`} action={item} width={card.width} height={card.height} />
            )))}
            <StartBlankTile width={card.width} height={card.height} />
          </>
        )}
      </ScrollView>
    </View>
  );
}

/**
 * Renders still running, and the way to them, in the subtitle's place: the
 * workspace slide used to carry this. It is labelled with what it shows and its
 * hint says where it goes.
 */
function ActiveRendersLine({ count }: { count: number }) {
  const theme = useAppTheme();
  const status = formatActiveRenders(count);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={status}
      accessibilityHint="Opens your creations"
      onPress={() => router.push({ pathname: '/profile', params: { tab: 'Creations' } } as never)}
      style={({ pressed }) => ({
        minHeight: 44,
        alignSelf: 'flex-start',
        flexDirection: 'row',
        alignItems: 'center',
        gap: appTheme.spacing.compact,
        opacity: pressed ? appTheme.opacity.pressed : 1,
      })}
    >
      <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: theme.colors.success }} />
      <AppText variant="caption" color="muted" numberOfLines={1}>{status}</AppText>
    </Pressable>
  );
}

function CreationCard({
  creation,
  offerFreeToTry,
  signsInFirst,
  width,
  height,
  pending,
  disabled,
  onMake,
}: {
  creation: HomeShelfCreation;
  offerFreeToTry: boolean;
  signsInFirst: boolean;
  width: number;
  height: number;
  /** This card's remix is being opened. */
  pending: boolean;
  /** A remix is being opened: a second tap must not open another. */
  disabled: boolean;
  onMake: (creation: HomeShelfCreation) => void;
}) {
  const theme = useAppTheme();
  const motion = usePressMotion(disabled, { scale: appTheme.motion.scale.pressedCard });
  const badge = homeShelfBadge(creation, offerFreeToTry);
  const price = formatHomeShelfPrice(creation.price);
  const handle = homeShelfCreatorLabel(creation.creator);

  return (
    // `width` on the wrapper, the scale a transform: the row lays the card out
    // at the width it snaps by, whatever the press is doing to it.
    <MotionView style={[{ width }, motion.animatedStyle]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={homeShelfCreationLabel(creation, badge)}
        accessibilityHint={homeShelfCreationHint(signsInFirst)}
        accessibilityState={{ disabled, busy: pending }}
        disabled={disabled}
        onPress={() => onMake(creation)}
        onPressIn={motion.onPressIn}
        onPressOut={motion.onPressOut}
        style={{
          width,
          minHeight: height,
          flexGrow: 1,
          borderRadius: CARD_RADIUS,
          borderCurve: 'continuous',
          borderWidth: 1,
          borderColor: theme.colors.borderSubtle,
          backgroundColor: theme.colors.panelSoft,
          overflow: 'hidden',
        }}
      >
        <StableMediaImage
          url={creation.posterUrl}
          cacheKey={homeShelfPosterCacheKey(creation)}
          thumbhash={creation.posterThumbhash}
          contentFit="cover"
          diagnosticsSurface="home-shelf"
          style={{ position: 'absolute', inset: 0 }}
        />
        <View style={CAPTION_SHADE} />

        {badge ? (
          <View
            style={{
              position: 'absolute',
              left: appTheme.spacing.compact,
              top: appTheme.spacing.compact,
              borderRadius: appTheme.radii.pill,
              paddingHorizontal: appTheme.spacing.compact,
              paddingVertical: appTheme.spacing.unit,
              backgroundColor: mediaColors.mediaChip,
            }}
          >
            <AppText variant="caption" color={mediaColors.onMedia} numberOfLines={1}>{badge}</AppText>
          </View>
        ) : null}
        {creation.clipUrl ? (
          <View style={{ position: 'absolute', right: appTheme.spacing.compact, top: appTheme.spacing.compact }}>
            <Play size={appTheme.icon.sm} color={mediaColors.onMedia} />
          </View>
        ) : null}

        <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: appTheme.spacing.compact, gap: appTheme.spacing.unit }}>
          <AppText variant="label" color={mediaColors.onMedia} numberOfLines={2}>
            {creation.title}
          </AppText>
          {price ? (
            <AppText variant="caption" color={mediaColors.onMediaSecondary} numberOfLines={1}>
              {price}
            </AppText>
          ) : null}
          <View style={{ marginTop: appTheme.spacing.unit, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: appTheme.spacing.compact }}>
            <AppText variant="caption" color={mediaColors.onMediaSecondary} numberOfLines={1} style={{ flexShrink: 1 }}>
              {handle}
            </AppText>
            <View style={{ borderRadius: appTheme.radii.pill, backgroundColor: mediaColors.onMedia, paddingHorizontal: appTheme.spacing.compact, paddingVertical: appTheme.spacing.unit }}>
              <AppText variant="caption" color={mediaColors.mediaGround} numberOfLines={1}>{pending ? 'Opening' : 'Make this'}</AppText>
            </View>
          </View>
        </View>
      </Pressable>
    </MotionView>
  );
}

function ActionCard({ action, width, height }: { action: HomeShelfAction; width: number; height: number }) {
  const theme = useAppTheme();
  const motion = usePressMotion(false, { scale: appTheme.motion.scale.pressedCard });
  const copy = homeShelfActionCopy(action);
  const tint = accentColor(copy.accent, theme.colors);
  const Icon = ACTION_ICONS[copy.icon];

  return (
    <MotionView style={[{ width }, motion.animatedStyle]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${copy.title}. ${copy.body}`}
        onPress={() => router.push(copy.route as never)}
        onPressIn={motion.onPressIn}
        onPressOut={motion.onPressOut}
        style={{
          width,
          minHeight: height,
          flexGrow: 1,
          borderRadius: CARD_RADIUS,
          borderCurve: 'continuous',
          borderWidth: 1,
          borderColor: hexWithAlpha(tint, 0.32),
          backgroundColor: theme.colors.panel,
          padding: appTheme.spacing.gap,
          justifyContent: 'space-between',
          overflow: 'hidden',
        }}
      >
        <View style={{ position: 'absolute', inset: 0, backgroundColor: hexWithAlpha(tint, 0.1) }} />
        <View
          style={{
            width: 32,
            height: 32,
            borderRadius: appTheme.radii.sm,
            borderCurve: 'continuous',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: hexWithAlpha(tint, 0.18),
          }}
        >
          <Icon size={appTheme.icon.sm} color={tint} />
        </View>
        <View style={{ gap: appTheme.spacing.unit }}>
          <AppText variant="label" numberOfLines={2}>{copy.title}</AppText>
          <AppText variant="caption" color="muted" numberOfLines={5}>{copy.body}</AppText>
        </View>
        <View
          style={{
            alignSelf: 'flex-start',
            // Room under the terms where they fill the card (a narrow phone).
            marginTop: appTheme.spacing.compact,
            borderRadius: appTheme.radii.pill,
            borderWidth: 1,
            borderColor: hexWithAlpha(tint, 0.55),
            paddingHorizontal: appTheme.spacing.compact,
            paddingVertical: appTheme.spacing.unit,
          }}
        >
          <AppText variant="caption" numberOfLines={1}>{copy.cta}</AppText>
        </View>
      </Pressable>
    </MotionView>
  );
}

/** A tool, for a shelf with no creations in it. */
function ToolCard({
  tool,
  width,
  height,
}: {
  tool: (typeof HOME_SHELF_START_BLANK_TOOLS)[number];
  width: number;
  height: number;
}) {
  const theme = useAppTheme();
  const motion = usePressMotion(false, { scale: appTheme.motion.scale.pressedCard });
  const tint = accentColor(tool.accent, theme.colors);
  const Icon = TOOL_ICONS[tool.id];

  return (
    <MotionView style={[{ width }, motion.animatedStyle]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`New ${tool.label.toLowerCase()}`}
        onPress={() => router.push(tool.route as never)}
        onPressIn={motion.onPressIn}
        onPressOut={motion.onPressOut}
        style={{
          width,
          minHeight: height,
          flexGrow: 1,
          borderRadius: CARD_RADIUS,
          borderCurve: 'continuous',
          borderWidth: 1,
          borderColor: theme.colors.borderSubtle,
          backgroundColor: theme.colors.panel,
          padding: appTheme.spacing.gap,
          justifyContent: 'space-between',
          overflow: 'hidden',
        }}
      >
        <View style={{ position: 'absolute', inset: 0, backgroundColor: hexWithAlpha(tint, 0.08) }} />
        <Icon size={appTheme.icon.feature} color={tint} />
        <AppText variant="label" numberOfLines={1}>{tool.label}</AppText>
      </Pressable>
    </MotionView>
  );
}

/** The row's last stop: the tools, for someone who would rather start from nothing. */
function StartBlankTile({ width, height }: { width: number; height: number }) {
  const theme = useAppTheme();

  return (
    <View
      style={{
        width,
        minHeight: height,
        borderRadius: CARD_RADIUS,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderStyle: 'dashed',
        borderColor: theme.colors.border,
        padding: appTheme.spacing.gap,
        gap: appTheme.spacing.compact,
        justifyContent: 'space-between',
      }}
    >
      <AppText variant="label" heading numberOfLines={2}>Start from scratch</AppText>
      <View style={{ gap: appTheme.spacing.compact }}>
        {HOME_SHELF_START_BLANK_TOOLS.map((tool) => {
          const Icon = TOOL_ICONS[tool.id];
          return (
            <Pressable
              key={tool.id}
              accessibilityRole="button"
              accessibilityLabel={`New ${tool.label.toLowerCase()}`}
              onPress={() => router.push(tool.route as never)}
              hitSlop={verticalHitSlop(ROW_HEIGHT)}
              style={({ pressed }) => ({
                minHeight: ROW_HEIGHT,
                borderRadius: appTheme.radii.sm,
                borderCurve: 'continuous',
                borderWidth: 1,
                borderColor: theme.colors.borderSubtle,
                backgroundColor: theme.colors.panel,
                paddingHorizontal: appTheme.spacing.compact,
                flexDirection: 'row',
                alignItems: 'center',
                gap: appTheme.spacing.compact,
                opacity: pressed ? appTheme.opacity.pressed : 1,
              })}
            >
              <Icon size={appTheme.icon.sm} color={theme.colors.muted} />
              <AppText variant="caption" numberOfLines={1}>{tool.label}</AppText>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
