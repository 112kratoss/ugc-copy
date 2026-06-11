import { BlurView } from 'expo-blur';
import { Image } from 'expo-image';
import { VideoView, type VideoPlayer } from 'expo-video';
import type { ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

type FeedMediaFrameBaseProps = {
  backgroundColor?: string;
  borderColor?: string;
  borderWidth?: number;
  children?: ReactNode;
  radius?: number;
  style?: StyleProp<ViewStyle>;
};

type FeedImageFrameProps = FeedMediaFrameBaseProps & {
  kind: 'image';
  onImageError?: () => void;
  transition?: number;
  url: string;
};

type FeedVideoFrameProps = FeedMediaFrameBaseProps & {
  kind: 'video';
  onFirstFrameRender?: () => void;
  player: VideoPlayer;
};

type FeedMediaFrameProps = FeedImageFrameProps | FeedVideoFrameProps;

const absoluteFill = {
  position: 'absolute' as const,
  inset: 0,
};

const videoViewProps = {
  allowsPictureInPicture: false,
  fullscreenOptions: { enable: false },
  nativeControls: false,
  startsPictureInPictureAutomatically: false,
  surfaceType: 'textureView' as const,
  useExoShutter: false,
};

export function FeedMediaFrame(props: FeedMediaFrameProps) {
  const {
    backgroundColor = '#050506',
    borderColor,
    borderWidth = borderColor ? 1 : 0,
    children,
    radius = 0,
    style,
  } = props;

  return (
    <View
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
          <Image
            source={{ uri: props.url }}
            contentFit="cover"
            transition={props.transition}
            pointerEvents="none"
            style={[absoluteFill, { backgroundColor }]}
          />
          <BlurBackdrop />
          <View pointerEvents="none" style={[absoluteFill, { backgroundColor: 'rgba(0,0,0,0.34)' }]} />
          <Image
            source={{ uri: props.url }}
            contentFit="contain"
            onError={props.onImageError}
            transition={props.transition}
            pointerEvents="none"
            style={[absoluteFill, { backgroundColor: 'transparent' }]}
          />
        </>
      ) : (
        <>
          <VideoView
            {...videoViewProps}
            player={props.player}
            contentFit="cover"
            pointerEvents="none"
            style={[absoluteFill, { backgroundColor }]}
          />
          <BlurBackdrop />
          <View pointerEvents="none" style={[absoluteFill, { backgroundColor: 'rgba(0,0,0,0.44)' }]} />
          <VideoView
            {...videoViewProps}
            player={props.player}
            contentFit="contain"
            onFirstFrameRender={props.onFirstFrameRender}
            pointerEvents="none"
            style={[absoluteFill, { backgroundColor: 'transparent' }]}
          />
        </>
      )}
      {children}
    </View>
  );
}

function BlurBackdrop() {
  return (
    <BlurView
      pointerEvents="none"
      intensity={64}
      tint="dark"
      experimentalBlurMethod="dimezisBlurView"
      blurReductionFactor={3}
      style={absoluteFill}
    />
  );
}
