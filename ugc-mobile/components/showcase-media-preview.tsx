import { Images } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { FeedMediaFrame } from '@/components/feed-media-frame';
import { FeedVideoPreview } from '@/components/feed-video-preview';
import { getShowcaseMediaPreviewUrl, getShowcasePreviewMediaItems } from '@/lib/showcase-media';
import type { ShowcaseFeedItem, ShowcaseMediaItem } from '@/lib/types';

type ShowcaseMediaPreviewProps = {
  accent: string;
  height: number;
  item: ShowcaseFeedItem;
  onPress?: () => void;
  onScrollToggle?: (scrolling: boolean) => void;
  radius: number;
  recyclingKey: string;
  videoActivation?: VideoActivation;
  width: number;
};

type VideoActivation = 'never' | 'visible' | 'when-poster-missing';

export function ShowcaseMediaPreview({
  accent,
  height,
  item,
  onPress,
  onScrollToggle,
  radius,
  recyclingKey,
  videoActivation = 'never',
  width,
}: ShowcaseMediaPreviewProps) {
  const mediaItems = getShowcasePreviewMediaItems(item);

  if (!mediaItems.length) return null;

  if (mediaItems.length === 1) {
    return (
      <ShowcaseMediaSlide
        accent={accent}
        height={height}
        item={mediaItems[0]}
        radius={radius}
        recyclingKey={recyclingKey}
        videoActivation={videoActivation}
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
      videoActivation={videoActivation}
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
  width,
}: Omit<ShowcaseMediaPreviewProps, 'item'> & { mediaItems: ShowcaseMediaItem[] }) {
  const [currentIndex, setCurrentIndex] = useState(0);

  return (
    <View style={{ height, width, overflow: 'hidden' }}>
      <ScrollView
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onScrollBeginDrag={() => onScrollToggle?.(true)}
        onScrollEndDrag={() => onScrollToggle?.(false)}
        onMomentumScrollEnd={(event) => {
          const index = Math.round(event.nativeEvent.contentOffset.x / width);
          setCurrentIndex(Math.max(0, Math.min(mediaItems.length - 1, index)));
          onScrollToggle?.(false);
        }}
        style={{ flex: 1 }}
      >
        {mediaItems.map((mediaItem, index) => {
          const slide = (
            <ShowcaseMediaSlide
              accent={accent}
              height={height}
              item={mediaItem}
              radius={radius}
              recyclingKey={`${recyclingKey}:${mediaItem.id}`}
              videoActivation={currentIndex === index ? videoActivation : 'never'}
              width={width}
            />
          );

          return onPress ? (
            <Pressable key={mediaItem.id} onPress={onPress} style={{ width, height }}>
              {slide}
            </Pressable>
          ) : (
            <View key={mediaItem.id} style={{ width, height }}>
              {slide}
            </View>
          );
        })}
      </ScrollView>

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
  width,
}: {
  accent: string;
  height: number;
  item: ShowcaseMediaItem;
  radius: number;
  recyclingKey: string;
  videoActivation: VideoActivation;
  width: number;
}) {
  const previewUrl = getShowcaseMediaPreviewUrl(item);
  const previewCacheKey = item.preview?.cacheKey ?? item.previewCacheKey;
  const previewThumbhash = item.preview?.thumbhash ?? item.previewThumbhash;

  if (item.mediaKind === 'video') {
    return (
      <View style={{ width, height }}>
        <FeedVideoPreview
          url={item.url}
          previewUrl={previewUrl}
          previewCacheKey={previewCacheKey}
          previewThumbhash={previewThumbhash}
          active={videoActivation === 'visible' || (videoActivation === 'when-poster-missing' && !previewUrl)}
          height={height}
          radius={radius}
          accent={accent}
        />
      </View>
    );
  }

  return (
    <FeedMediaFrame
      kind="image"
      url={previewUrl ?? item.url}
      backdropUrl={previewUrl}
      cacheKey={previewCacheKey}
      thumbhash={previewThumbhash}
      transition={120}
      recyclingKey={recyclingKey}
      radius={radius}
      style={{ width, height }}
    />
  );
}
