import { useMemo } from 'react';
import { Pressable, Text, useWindowDimensions, View } from 'react-native';

import { PinBadge, VideoCornerPlay, VideoPinPreview, VisualFallbackPreview } from '@/components/showcase-pin-marks';
import { ShowcaseMediaPreview } from '@/components/showcase-media-preview';
import { TextPostPlate } from '@/components/text-post-plate';
import { CreatorAvatar } from '@/components/ui';
import {
  buildSearchPostPin,
  searchPostPinMediaHeight,
  searchPostPinFooterHeight,
  splitSearchPostColumns,
  type SearchPostPin,
} from '@/lib/search-post-masonry';
import { getShowcasePreviewMediaItems, hasShowcasePreviewMedia } from '@/lib/showcase-media';
import { buildTextPostPlate } from '@/lib/text-post-plate-view-model';
import { accentColor, appTheme, themes } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';
import type { ShowcaseFeedItem } from '@/lib/types';

// As Explore's grid spaces its pins (`getShowcaseGridLayout`), less a little:
// the search's results sit inside the screen's margins.
const COLUMN_GAP = 10;
const PIN_GAP = 18;

function SearchPostPinCard({
  pin,
  width,
  height,
  onOpen,
}: {
  pin: SearchPostPin;
  width: number;
  height: number;
  onOpen: (item: ShowcaseFeedItem) => void;
}) {
  const theme = useAppTheme();
  const { card, item } = pin;
  const accent = card ? accentColor(card.accent, theme.colors) : theme.colors.primary;
  const open = () => onOpen(item);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={pin.label}
      testID="search-post-pin"
      onPress={open}
      style={({ pressed }) => ({ gap: 6, opacity: pressed ? appTheme.opacity.pressed : 1 })}
    >
      <View
        style={{
          width,
          height,
          overflow: 'hidden',
          borderRadius: appTheme.radii.md,
          borderCurve: 'continuous',
          backgroundColor: theme.colors.mediaPlaceholder,
        }}
      >
        {!card ? (
          // A post with no picture has its writing to show, as on the reel,
          // its title with it: no caption under the pin names it.
          <TextPostPlate
            testID="search-text-post-plate"
            content={buildTextPostPlate(item)}
            size="feature"
            bodyLines={5}
          />
        ) : hasShowcasePreviewMedia(item) ? (
          <ShowcaseMediaPreview
            mediaItems={getShowcasePreviewMediaItems(item)}
            height={height}
            width={width}
            accent={accent}
            radius={appTheme.radii.md}
            recyclingKey={`search:${item.id}`}
            // Still in search: a list of results plays nothing of its own accord.
            videoActivation="never"
            videoBackdrop="none"
            videoContentFit="cover"
            onPress={open}
          />
        ) : pin.video ? (
          // No poster yet: Explore's video plate, not a picture's (review of #793).
          <VideoPinPreview accent={accent} height={height} radius={appTheme.radii.md} />
        ) : (
          <VisualFallbackPreview accent={accent} height={height} radius={appTheme.radii.md} />
        )}
        {/* Explore's marks, on dark glass over the picture in both schemes. */}
        {pin.badge && card?.unlock ? <PinBadge label={pin.badge} accent={accentColor(card.unlock.accent, themes.dark.colors)} /> : null}
        {pin.video ? <VideoCornerPlay /> : null}
      </View>
      <View style={{ gap: 2, paddingHorizontal: 2 }}>
        {/* Who and when on one line, as the feed's cards say it ("@luna · 3d ago"):
            the handle gives way, the date stays whole. */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
          <CreatorAvatar uri={item.creator.avatar} name={pin.handle} size={22} />
          <Text numberOfLines={1} style={{ flexShrink: 1, color: theme.colors.muted, ...appTheme.type.caption, fontWeight: '700' }}>
            {pin.handle}
          </Text>
          <Text numberOfLines={1} style={{ flexShrink: 0, color: theme.colors.faint, ...appTheme.type.caption }}>
            {`· ${pin.date}`}
          </Text>
        </View>
        {pin.madeWith ? (
          <Text numberOfLines={2} style={{ color: theme.colors.faint, ...appTheme.type.caption }}>
            {pin.madeWith}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/**
 * Search posts drawn as Explore draws its posts (search UX audit 2026-11-13,
 * finding 3): a masonry of pictures at their own shape, Explore's badge and
 * video mark, the creator by @handle, and a quiet line that says what each
 * was made with and when (`lib/search-post-masonry.ts`). `columns` is two, or
 * one at the accessibility text sizes (`lib/search-post-grid.ts`). The search
 * is narrowed to `narrowedTo` when a model or tool filter is on: a post made
 * with it says so first.
 */
export function SearchPostMasonry({
  items,
  columns,
  narrowedTo = null,
  onOpen,
  testID,
}: {
  items: readonly ShowcaseFeedItem[];
  columns: number;
  narrowedTo?: { id: string; label: string } | null;
  onOpen: (item: ShowcaseFeedItem) => void;
  testID?: string;
}) {
  const { width: windowWidth, fontScale } = useWindowDimensions();
  const count = Math.max(1, columns);
  const columnWidth = (windowWidth - appTheme.spacing.screen * 2 - COLUMN_GAP * (count - 1)) / count;
  const narrowedId = narrowedTo?.id ?? null;
  const narrowedLabel = narrowedTo?.label ?? null;
  const pins = useMemo(
    () => items.map((item) => buildSearchPostPin(item, {
      narrowedTo: narrowedId && narrowedLabel ? { id: narrowedId, label: narrowedLabel } : null,
    })),
    [items, narrowedId, narrowedLabel],
  );
  // Each pin's whole height, its lines as drawn included, so the shorter column is the one that is.
  const split = splitSearchPostColumns(pins, count, (pin) => searchPostPinMediaHeight(pin, columnWidth) + searchPostPinFooterHeight(pin, columnWidth, fontScale));
  return (
    <View testID={testID} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: COLUMN_GAP }}>
      {split.map((column, index) => (
        <View key={index} style={{ flex: 1, minWidth: 0, gap: PIN_GAP }}>
          {column.map((pin) => (
            <SearchPostPinCard
              key={pin.id}
              pin={pin}
              width={columnWidth}
              height={searchPostPinMediaHeight(pin, columnWidth)}
              onOpen={onOpen}
            />
          ))}
        </View>
      ))}
    </View>
  );
}
