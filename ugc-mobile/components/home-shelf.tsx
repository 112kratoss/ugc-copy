import { Image } from 'expo-image';
import { router } from 'expo-router';
import { Coins, Gift, ImageIcon, Play, Rocket, Send, Video, type LucideIcon } from 'lucide-react-native';
import { Platform, Pressable, ScrollView, Text, View, type ViewStyle } from 'react-native';

import { hexWithAlpha, linearGradient } from '@/lib/eased-fade';
import { verticalHitSlop } from '@/lib/hit-target';
import {
  HOME_SHELF_START_BLANK_TOOLS,
  formatHomeShelfPrice,
  getHomeShelfCardWidth,
  homeShelfActionCopy,
  homeShelfBadge,
  homeShelfCreationLabel,
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
 */

const SHELF_GAP = 10;
const CARD_RADIUS = 18;
const START_BLANK_ROW_HEIGHT = 36;

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

const START_BLANK_ICONS: Record<(typeof HOME_SHELF_START_BLANK_TOOLS)[number]['id'], LucideIcon> = {
  image: ImageIcon,
  video: Video,
  motion: Rocket,
};

export function HomeShelf({
  items,
  isLoading,
  offerFreeToTry,
  horizontalPadding,
  contentWidth,
  onMake,
}: {
  items: HomeShelfItem[];
  /** The first answer has not come yet: the row's place is held so the feed does not jump. */
  isLoading: boolean;
  /** Signed out or a guest: still owed the welcome credits "Free to try" promises. */
  offerFreeToTry: boolean;
  horizontalPadding: number;
  contentWidth: number;
  onMake: (creation: HomeShelfCreation) => void;
}) {
  const theme = useAppTheme();
  const cardWidth = getHomeShelfCardWidth(contentWidth, SHELF_GAP);
  // A little taller than 4:5 so an offer's two lines of terms fit at 11pt on
  // the narrowest phone without clipping.
  const cardHeight = Math.round(cardWidth * 1.3);

  if (!isLoading && items.length === 0) return null;

  return (
    <View style={{ gap: 10 }}>
      <View
        style={{
          paddingHorizontal: horizontalPadding,
          flexDirection: 'row',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <View style={{ flexShrink: 1, gap: 2 }}>
          <Text accessibilityRole="header" style={{ color: theme.colors.text, fontSize: 17, fontWeight: '800' }}>
            Make this
          </Text>
          <Text numberOfLines={1} style={{ color: theme.colors.muted, fontSize: 13, fontWeight: '600' }}>
            Real creations, one tap to make your own
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="See all creations"
          accessibilityHint="Opens Explore"
          onPress={() => router.push('/(tabs)/showcase' as never)}
          hitSlop={verticalHitSlop(20)}
          style={({ pressed }) => ({ opacity: pressed ? appTheme.opacity.pressed : 1 })}
        >
          <Text style={{ color: theme.colors.muted, fontSize: 13, fontWeight: '700' }}>See all</Text>
        </Pressable>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        // The row scrolls freely and comes to rest on a card's edge, which is
        // what the gutter-wide padding below lines up with.
        snapToInterval={cardWidth + SHELF_GAP}
        snapToAlignment="start"
        decelerationRate="fast"
        scrollEnabled={!isLoading}
        contentContainerStyle={{ paddingHorizontal: horizontalPadding, gap: SHELF_GAP }}
      >
        {isLoading
          ? [0, 1, 2].map((slot) => (
              <View
                key={slot}
                accessible={false}
                style={{
                  width: cardWidth,
                  height: cardHeight,
                  borderRadius: CARD_RADIUS,
                  borderCurve: 'continuous',
                  backgroundColor: theme.colors.panelSoft,
                }}
              />
            ))
          : items.map((item) => (item.kind === 'creation' ? (
              <CreationCard
                key={`creation-${item.id}`}
                creation={item}
                offerFreeToTry={offerFreeToTry}
                width={cardWidth}
                height={cardHeight}
                onMake={onMake}
              />
            ) : (
              <ActionCard key={`action-${item.id}`} action={item} width={cardWidth} height={cardHeight} />
            )))}
        {isLoading ? null : <StartBlankTile width={cardWidth} height={cardHeight} />}
      </ScrollView>
    </View>
  );
}

function CreationCard({
  creation,
  offerFreeToTry,
  width,
  height,
  onMake,
}: {
  creation: HomeShelfCreation;
  offerFreeToTry: boolean;
  width: number;
  height: number;
  onMake: (creation: HomeShelfCreation) => void;
}) {
  const theme = useAppTheme();
  const motion = usePressMotion(false, { scale: appTheme.motion.scale.pressedCard });
  const badge = homeShelfBadge(creation, offerFreeToTry);
  const price = formatHomeShelfPrice(creation.price);
  const handle = creation.creator.username ? `@${creation.creator.username}` : creation.creator.name;

  return (
    // `width` on the wrapper, the scale a transform: the row lays the card out
    // at the width it snaps by, whatever the press is doing to it.
    <MotionView style={[{ width }, motion.animatedStyle]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={homeShelfCreationLabel(creation)}
        accessibilityHint="Opens the creator with this prompt and settings"
        onPress={() => onMake(creation)}
        onPressIn={motion.onPressIn}
        onPressOut={motion.onPressOut}
        style={{
          width,
          height,
          borderRadius: CARD_RADIUS,
          borderCurve: 'continuous',
          borderWidth: 1,
          borderColor: theme.colors.borderSubtle,
          backgroundColor: theme.colors.panelSoft,
          overflow: 'hidden',
        }}
      >
        <Image
          source={{ uri: creation.posterUrl }}
          placeholder={creation.posterThumbhash ? { thumbhash: creation.posterThumbhash } : undefined}
          placeholderContentFit="cover"
          contentFit="cover"
          cachePolicy="memory-disk"
          recyclingKey={creation.id}
          // expo-image 55's Android fade can leave a recycled image's layers
          // hidden; the swap is immediate there, as in the feed.
          transition={Platform.OS === 'android' ? 0 : 200}
          style={{ position: 'absolute', inset: 0 }}
        />
        <View style={CAPTION_SHADE} />

        {badge ? (
          <View
            style={{
              position: 'absolute',
              left: 8,
              top: 8,
              borderRadius: 999,
              paddingHorizontal: 8,
              paddingVertical: 3,
              backgroundColor: mediaColors.mediaChip,
            }}
          >
            <Text style={{ color: mediaColors.onMedia, fontSize: 11, fontWeight: '800' }}>{badge}</Text>
          </View>
        ) : null}
        {creation.clipUrl ? (
          <View style={{ position: 'absolute', right: 9, top: 9 }}>
            <Play size={appTheme.icon.sm} color={mediaColors.onMedia} />
          </View>
        ) : null}

        <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: 10, gap: 2 }}>
          <Text numberOfLines={2} style={{ color: mediaColors.onMedia, fontSize: 13, lineHeight: 17, fontWeight: '800' }}>
            {creation.title}
          </Text>
          {price ? (
            <Text numberOfLines={1} style={{ color: mediaColors.onMediaSecondary, fontSize: 11, fontWeight: '700' }}>
              {price}
            </Text>
          ) : null}
          <View style={{ marginTop: 6, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
            <Text numberOfLines={1} style={{ flexShrink: 1, color: mediaColors.onMediaSecondary, fontSize: 11, fontWeight: '700' }}>
              {handle}
            </Text>
            <View style={{ borderRadius: 999, backgroundColor: mediaColors.onMedia, paddingHorizontal: 9, paddingVertical: 4 }}>
              <Text style={{ color: mediaColors.mediaGround, fontSize: 11, fontWeight: '800' }}>Make this</Text>
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
          height,
          borderRadius: CARD_RADIUS,
          borderCurve: 'continuous',
          borderWidth: 1,
          borderColor: hexWithAlpha(tint, 0.32),
          backgroundColor: theme.colors.panel,
          padding: 12,
          justifyContent: 'space-between',
          overflow: 'hidden',
        }}
      >
        <View style={{ position: 'absolute', inset: 0, backgroundColor: hexWithAlpha(tint, 0.1) }} />
        <View
          style={{
            width: 32,
            height: 32,
            borderRadius: 11,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: hexWithAlpha(tint, 0.18),
          }}
        >
          <Icon size={appTheme.icon.sm} color={tint} />
        </View>
        <View style={{ gap: 4 }}>
          <Text numberOfLines={2} style={{ color: theme.colors.text, fontSize: 13, lineHeight: 17, fontWeight: '800' }}>
            {copy.title}
          </Text>
          <Text numberOfLines={5} style={{ color: theme.colors.muted, fontSize: 11, lineHeight: 15, fontWeight: '600' }}>
            {copy.body}
          </Text>
        </View>
        <View
          style={{
            alignSelf: 'flex-start',
            borderRadius: 999,
            borderWidth: 1,
            borderColor: hexWithAlpha(tint, 0.55),
            paddingHorizontal: 10,
            paddingVertical: 4,
          }}
        >
          <Text style={{ color: theme.colors.text, fontSize: 11, fontWeight: '800' }}>{copy.cta}</Text>
        </View>
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
        height,
        borderRadius: CARD_RADIUS,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderStyle: 'dashed',
        borderColor: theme.colors.border,
        padding: 12,
        justifyContent: 'space-between',
      }}
    >
      <Text accessibilityRole="header" numberOfLines={2} style={{ color: theme.colors.text, fontSize: 13, lineHeight: 17, fontWeight: '800' }}>
        Start from scratch
      </Text>
      <View style={{ gap: 8 }}>
        {HOME_SHELF_START_BLANK_TOOLS.map((tool) => {
          const Icon = START_BLANK_ICONS[tool.id];
          return (
            <Pressable
              key={tool.id}
              accessibilityRole="button"
              accessibilityLabel={`New ${tool.label.toLowerCase()}`}
              onPress={() => router.push(tool.route as never)}
              hitSlop={verticalHitSlop(START_BLANK_ROW_HEIGHT)}
              style={({ pressed }) => ({
                minHeight: START_BLANK_ROW_HEIGHT,
                borderRadius: 12,
                borderCurve: 'continuous',
                borderWidth: 1,
                borderColor: theme.colors.borderSubtle,
                backgroundColor: theme.colors.panel,
                paddingHorizontal: 10,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                opacity: pressed ? appTheme.opacity.pressed : 1,
              })}
            >
              <Icon size={appTheme.icon.sm} color={theme.colors.muted} />
              <Text style={{ color: theme.colors.text, fontSize: 12, fontWeight: '700' }}>{tool.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
