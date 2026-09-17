import { Image, type ImageProps } from 'expo-image';
import { VideoView, type VideoPlayer } from 'expo-video';
import type { ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { FEED_VIDEO_VIEW_PROPS } from '@/lib/feed-video-view-props';
import { useMediaSource } from '@/lib/use-media-source';
import { appTheme } from '@/lib/theme';
import { StableMediaImage } from '@/components/media-preview';

type FeedMediaFrameBaseProps = {
  backdropUrl?: string | null;
  backdropCacheKey?: string;
  backgroundColor?: string;
  borderColor?: string;
  borderWidth?: number;
  children?: ReactNode;
  priority?: 'low' | 'normal' | 'high';
  radius?: number;
  recyclingKey?: string;
  cacheKey?: string;
  thumbhash?: string | null;
  style?: StyleProp<ViewStyle>;
  /** Arms the image's display deadline; see `StableMediaImage`. Only for media on screen. */
  watchdog?: boolean;
  /** Where the frame is drawn, for the media diagnostics log. */
  diagnosticsSurface?: string;
};

type FeedImageFrameProps = FeedMediaFrameBaseProps & {
  kind: 'image';
  imageBackdrop?: 'blurred' | 'none';
  /**
   * Drawn beneath the picture in place of the blurred backdrop, when given. The
   * reel's letterbox bands go here (`LetterboxBands`): the evenly dimmed backdrop
   * leaves a hard edge where it meets the picture, and the bands reach a little
   * way under the picture so a rounding gap along the seam cannot show — which
   * only a picture drawn over them hides.
   */
  imageBackdropContent?: ReactNode;
  imageContentFit?: 'cover' | 'contain';
  /** Fires when this picture is actually on screen, not merely decoded. */
  onImageDisplay?: ImageProps['onDisplay'];
  onImageError?: () => void;
  onImageLoad?: ImageProps['onLoad'];
  transition?: number;
  url: string;
};

type FeedVideoFrameProps = FeedMediaFrameBaseProps & {
  kind: 'video';
  onFirstFrameRender?: () => void;
  /** Null draws no video yet — a surface that will take a player later. */
  player: VideoPlayer | null;
  posterUrl?: string | null;
  posterVisible?: boolean;
  videoBackdrop?: 'blurred' | 'none';
  videoContentFit?: 'cover' | 'contain';
};

type FeedMediaFrameProps = FeedImageFrameProps | FeedVideoFrameProps;

const absoluteFill = {
  position: 'absolute' as const,
  inset: 0,
};

// Shared by every feed-side VideoView; see lib/feed-video-view-props.ts.
export { FEED_VIDEO_VIEW_PROPS };

export function FeedMediaFrame(props: FeedMediaFrameProps) {
  const foregroundUrl = props.kind === 'image' ? props.url : props.posterUrl;
  const foregroundCacheKey = props.cacheKey ?? (props.recyclingKey
    ? `${props.recyclingKey}:${props.kind === 'image' ? 'foreground' : 'video-poster'}`
    : foregroundUrl);
  const backdropUrl = props.backdropUrl || (props.kind === 'image' ? props.url : '');
  const { source } = useMediaSource(backdropUrl);
  // Share bytes only when both layers represent the same asset. A separate
  // preview must never overwrite the full-size foreground's cache entry.
  const backdropCacheKey = props.backdropCacheKey
    ?? (backdropUrl === foregroundUrl ? foregroundCacheKey : undefined);
  const backdropSource = backdropCacheKey ? { ...source, cacheKey: backdropCacheKey } : source;
  const {
    backgroundColor = appTheme.colors.app,
    borderColor,
    borderWidth = borderColor ? 1 : 0,
    children,
    radius = 0,
    style,
  } = props;

  return (
    <View
      pointerEvents={props.kind === 'video' ? 'none' : undefined}
      style={[
        {
          overflow: 'hidden',
          borderRadius: radius,
          borderCurve: 'continuous',
          borderWidth,
          borderColor,
          backgroundColor,
        },
        style,
      ]}
    >
      {props.kind === 'image' ? (
        <>
          {props.imageBackdropContent}
          {!props.imageBackdropContent && (props.imageBackdrop ?? 'blurred') === 'blurred' ? (
            <>
              <Image
                source={backdropSource}
                contentFit="cover"
                blurRadius={24}
                cachePolicy="memory-disk"
                priority="low"
                recyclingKey={props.recyclingKey ? `${props.recyclingKey}:backdrop` : undefined}
                pointerEvents="none"
                style={[absoluteFill, { backgroundColor }]}
              />
              <View pointerEvents="none" style={[absoluteFill, { backgroundColor: 'rgba(0,0,0,0.34)' }]} />
            </>
          ) : null}
          <StableMediaImage
            url={props.url}
            cacheKey={foregroundCacheKey ?? props.url}
            thumbhash={props.thumbhash}
            contentFit={props.imageContentFit ?? 'contain'}
            onDisplay={props.onImageDisplay}
            onError={props.onImageError}
            onLoad={props.onImageLoad}
            transition={props.transition}
            watchdog={props.watchdog}
            diagnosticsSurface={props.diagnosticsSurface}
            style={[absoluteFill, { backgroundColor: 'transparent' }]}
          />
        </>
      ) : (
        <>
          {props.backdropUrl && (props.videoBackdrop ?? 'blurred') === 'blurred' ? (
            <Image
              source={backdropSource}
              contentFit="cover"
              blurRadius={24}
              cachePolicy="memory-disk"
              priority="low"
              recyclingKey={props.recyclingKey ? `${props.recyclingKey}:video-backdrop` : undefined}
              pointerEvents="none"
              style={[absoluteFill, { backgroundColor }]}
            />
          ) : null}
          {(props.videoBackdrop ?? 'blurred') === 'blurred' ? (
            <View pointerEvents="none" style={[absoluteFill, { backgroundColor: 'rgba(0,0,0,0.44)' }]} />
          ) : null}
          <VideoView
            {...FEED_VIDEO_VIEW_PROPS}
            player={props.player}
            contentFit={props.videoContentFit ?? 'contain'}
            onFirstFrameRender={props.onFirstFrameRender}
            pointerEvents="none"
            style={[absoluteFill, { backgroundColor: 'transparent' }]}
          />
          {props.posterVisible && props.posterUrl ? (
            <StableMediaImage
              url={props.posterUrl}
              cacheKey={foregroundCacheKey ?? props.posterUrl}
              thumbhash={props.thumbhash}
              contentFit={props.videoContentFit ?? 'contain'}
              watchdog={props.watchdog}
              diagnosticsSurface={props.diagnosticsSurface}
              style={[absoluteFill, { backgroundColor: 'transparent' }]}
            />
          ) : null}
        </>
      )}
      {children}
    </View>
  );
}
