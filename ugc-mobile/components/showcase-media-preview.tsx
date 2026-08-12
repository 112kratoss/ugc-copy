import { Images } from 'lucide-react-native';
import { Image } from 'expo-image';
import { useEffect, useState } from 'react';
import { AccessibilityInfo, FlatList, Platform, Pressable, Text, View } from 'react-native';

import { FeedMediaFrame } from '@/components/feed-media-frame';
import { FeedVideoPreview } from '@/components/feed-video-preview';
import { IMMERSIVE_HORIZONTAL_LIST_TUNING } from '@/lib/media-performance';
import {
  getShowcaseMediaPreviewUrl,
  getShowcaseMediaRenditionUrl,
  getShowcasePreviewMediaItems,
  resolveShowcaseImageTileSource,
} from '@/lib/showcase-media';
import type { ShowcaseFeedItem, ShowcaseMediaItem } from '@/lib/types';

type ShowcaseMediaPreviewProps = {
  accent: string;
  height: number;
  /**
   * Normalized media, not the feed item — creations and owner posts render through
   * this component too, and they are not `ShowcaseFeedItem`s. Showcase callers pass
   * `getShowcasePreviewMediaItems(item)`.
   */
  mediaItems: ShowcaseMediaItem[];
  onPress?: () => void;
  onScrollToggle?: (scrolling: boolean) => void;
  radius: number;
  recyclingKey: string;
  videoActivation?: VideoActivation;
  videoBackdrop?: 'blurred' | 'none';
  videoContentFit?: 'cover' | 'contain';
  width: number;
};

type VideoActivation = 'never' | 'visible' | 'when-poster-missing';

export function ShowcaseMediaPreview({
  accent,
  height,
  mediaItems,
  onPress,
  onScrollToggle,
  radius,
  recyclingKey,
  videoActivation = 'never',
  videoBackdrop = 'blurred',
  videoContentFit = 'contain',
  width,
}: ShowcaseMediaPreviewProps) {
  const reduceMotionEnabled = useReduceMotionEnabled();
  const resolvedVideoActivation = reduceMotionEnabled ? 'never' : videoActivation;

  if (!mediaItems.length) return null;

  if (mediaItems.length === 1) {
    return (
      <ShowcaseMediaSlide
        accent={accent}
        height={height}
        item={mediaItems[0]}
        radius={radius}
        recyclingKey={recyclingKey}
        videoActivation={resolvedVideoActivation}
        videoBackdrop={videoBackdrop}
        videoContentFit={videoContentFit}
        width={width}
      />
    );
  }

  return (
    <ShowcaseMediaCarousel
      accent={accent}
      height={height}
      mediaItems={mediaItems}
      onPress={onPress}
      onScrollToggle={onScrollToggle}
      radius={radius}
      recyclingKey={recyclingKey}
      videoActivation={resolvedVideoActivation}
      videoBackdrop={videoBackdrop}
      videoContentFit={videoContentFit}
      width={width}
    />
  );
}

function ShowcaseMediaCarousel({
  accent,
  height,
  mediaItems,
  onPress,
  onScrollToggle,
  radius,
  recyclingKey,
  videoActivation = 'never',
  videoBackdrop = 'blurred',
  videoContentFit = 'contain',
  width,
}: ShowcaseMediaPreviewProps) {
  const [currentIndex, setCurrentIndex] = useState(0);

  return (
    <View style={{ height, width, overflow: 'hidden' }}>
      <FlatList
        data={mediaItems}
        decelerationRate="fast"
        getItemLayout={(_, index) => ({ length: width, offset: width * index, index })}
        horizontal
        initialNumToRender={IMMERSIVE_HORIZONTAL_LIST_TUNING.initialNumToRender}
        keyExtractor={(mediaItem) => mediaItem.id}
        maxToRenderPerBatch={IMMERSIVE_HORIZONTAL_LIST_TUNING.maxToRenderPerBatch}
        pagingEnabled
        removeClippedSubviews={Platform.OS === 'android'}
        renderItem={({ item: mediaItem, index }) => {
          const slide = (
            <ShowcaseMediaSlide
              accent={accent}
              height={height}
              item={mediaItem}
              radius={radius}
              recyclingKey={`${recyclingKey}:${mediaItem.id}`}
              videoActivation={currentIndex === index ? videoActivation : 'never'}
              videoBackdrop={videoBackdrop}
              videoContentFit={videoContentFit}
              width={width}
            />
          );

          return onPress ? (
            <Pressable onPress={onPress} style={{ width, height }}>
              {slide}
            </Pressable>
          ) : (
            <View style={{ width, height }}>
              {slide}
            </View>
          );
        }}
        showsHorizontalScrollIndicator={false}
        onScrollBeginDrag={() => onScrollToggle?.(true)}
        onScrollEndDrag={() => onScrollToggle?.(false)}
        onMomentumScrollEnd={(event) => {
          const index = Math.round(event.nativeEvent.contentOffset.x / width);
          setCurrentIndex(Math.max(0, Math.min(mediaItems.length - 1, index)));
          onScrollToggle?.(false);
        }}
        style={{ flex: 1 }}
        windowSize={IMMERSIVE_HORIZONTAL_LIST_TUNING.windowSize}
      />

      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          right: 10,
          top: 10,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 4,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: 'rgba(255,255,255,0.1)',
          backgroundColor: 'rgba(3,3,6,0.68)',
          paddingHorizontal: 8,
          paddingVertical: 4,
        }}
      >
        <Images size={12} color="#ffffff" />
        <Text style={{ color: '#ffffff', fontSize: 10, fontWeight: '800' }}>
          {currentIndex + 1}/{mediaItems.length}
        </Text>
      </View>

      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          bottom: 10,
          left: 0,
          right: 0,
          flexDirection: 'row',
          justifyContent: 'center',
          gap: 5,
        }}
      >
        {mediaItems.map((mediaItem, index) => (
          <View
            key={mediaItem.id}
            style={{
              height: 5,
              width: index === currentIndex ? 12 : 5,
              borderRadius: 2.5,
              backgroundColor: index === currentIndex ? '#ffffff' : 'rgba(255,255,255,0.45)',
            }}
          />
        ))}
      </View>
    </View>
  );
}

function ShowcaseMediaSlide({
  accent,
  height,
  item,
  radius,
  recyclingKey,
  videoActivation,
  videoBackdrop,
  videoContentFit,
  width,
}: {
  accent: string;
  height: number;
  item: ShowcaseMediaItem;
  radius: number;
  recyclingKey: string;
  videoActivation: VideoActivation;
  videoBackdrop: 'blurred' | 'none';
  videoContentFit: 'cover' | 'contain';
  width: number;
}) {
  const previewUrl = getShowcaseMediaPreviewUrl(item);
  const [failedPreviewUrl, setFailedPreviewUrl] = useState<string | null>(null);
  const usablePreviewUrl = previewUrl && previewUrl !== failedPreviewUrl ? previewUrl : null;
  const previewCacheKey = item.preview?.cacheKey ?? item.previewCacheKey;
  const previewThumbhash = item.preview?.thumbhash ?? item.previewThumbhash;

  useEffect(() => {
    setFailedPreviewUrl(null);
  }, [item.id, previewUrl]);

  if (item.mediaKind === 'video') {
    return (
      <View style={{ width, height }}>
        <FeedVideoPreview
          url={item.url}
          renditionUrl={getShowcaseMediaRenditionUrl(item)}
          previewUrl={usablePreviewUrl}
          previewCacheKey={previewCacheKey}
          previewThumbhash={previewThumbhash}
          active={videoActivation === 'visible' || (videoActivation === 'when-poster-missing' && !usablePreviewUrl)}
          height={height}
          radius={radius}
          accent={accent}
          videoBackdrop={videoBackdrop}
          videoContentFit={videoContentFit}
        />
      </View>
    );
  }

  const imageTileSource = resolveShowcaseImageTileSource(item, failedPreviewUrl);

  if (imageTileSource === 'pending') {
    return (
      <View
        style={{
          width,
          height,
          overflow: 'hidden',
          borderRadius: radius,
          borderCurve: 'continuous',
          borderWidth: 1,
          borderColor: `${accent}4d`,
          backgroundColor: '#050506',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {previewThumbhash ? (
          <Image
            placeholder={{ thumbhash: previewThumbhash }}
            placeholderContentFit="cover"
            contentFit="cover"
            pointerEvents="none"
            style={{ position: 'absolute', inset: 0 }}
          />
        ) : (
          <View
            style={{
              width: 46,
              height: 46,
              borderRadius: 23,
              alignItems: 'center',
              justifyContent: 'center',
              borderWidth: 1,
              borderColor: `${accent}66`,
              backgroundColor: `${accent}22`,
            }}
          >
            <Images size={19} color="#ffffff" />
          </View>
        )}
      </View>
    );
  }

  const imageUrl = imageTileSource === 'preview' ? previewUrl! : item.url;

  // The fallback source gets its own cache key: reusing the preview's key
  // would file the original's bytes under the preview's disk-cache entry, and
  // for legacy items (previewUrl === url) the key change is what releases
  // StableMediaImage's failure latch so the fallback attempt happens at all.
  const frameCacheKey = imageTileSource === 'preview'
    ? previewCacheKey
    : previewCacheKey
      ? `${previewCacheKey}:source`
      : undefined;

  return (
    <FeedMediaFrame
      kind="image"
      url={imageUrl}
      cacheKey={frameCacheKey}
      thumbhash={previewThumbhash}
      imageBackdrop="none"
      imageContentFit="cover"
      onImageError={() => {
        if (imageTileSource === 'preview') setFailedPreviewUrl(previewUrl);
      }}
      transition={120}
      recyclingKey={recyclingKey}
      radius={radius}
      style={{ width, height }}
    />
  );
}

function useReduceMotionEnabled() {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (mounted) setEnabled(value);
    });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setEnabled);
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  return enabled;
}
