import { useIsFocused } from '@react-navigation/native';
import { VideoView, type VideoPlayer } from 'expo-video';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { StyleSheet } from 'react-native';

import { FEED_VIDEO_VIEW_PROPS } from '@/lib/feed-video-view-props';
import { useMediaZoomTileKey, useMediaZoomVideoOffer } from '@/lib/media-zoom-video-offer';
import {
  acceptVideoReturn, claimReturnedVideoPlayer, getReturningVideoPlayer,
  isVideoLoanHeld, isVideoPlayerOnLoan, lenderUnmounting, peekReturnedVideoPlayer,
  reportReturnedVideoDrawn, subscribeToVideoLoanHolds, subscribeToVideoReturns,
} from '@/lib/video-player-loans';

/** Poster grids acquire no decoder until a viewer actually returns one. */
export function ReturnedVideoPreview({ url }: { url: string }) {
  const tileKey = useMediaZoomTileKey();
  const focused = useIsFocused();
  const returningPlayer = useSyncExternalStore(subscribeToVideoReturns, getReturningVideoPlayer);
  const pending = useSyncExternalStore(
    subscribeToVideoReturns,
    () => tileKey ? peekReturnedVideoPlayer(tileKey, url) : null,
  );
  const lending = useSyncExternalStore(subscribeToVideoLoanHolds, () => Boolean(tileKey && isVideoLoanHeld(tileKey, url)));
  const [held, setHeld] = useState<VideoPlayer | null>(null);
  if (pending && pending !== held) setHeld(pending);
  else if (held && !pending && !lending && (
    !focused || isVideoPlayerOnLoan(held) || (returningPlayer && returningPlayer !== held)
  )) setHeld(null);

  useEffect(() => {
    if (!tileKey) return;
    return acceptVideoReturn(tileKey, url);
  }, [tileKey, url]);

  if (!held || !tileKey) return null;
  return <ReturnedVideoLayer player={held} tileKey={tileKey} url={url} returning={pending === held} />;
}

function ReturnedVideoLayer({ player, tileKey, url, returning }: {
  player: VideoPlayer; tileKey: string; url: string; returning: boolean;
}) {
  const offer = useMediaZoomVideoOffer();
  const drawn = useRef(false);
  const release = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    claimReturnedVideoPlayer(tileKey, url);
    if (release.current) clearTimeout(release.current);
    return () => {
      if (lenderUnmounting(player)) return;
      player.pause();
      release.current = setTimeout(() => player.release(), 100);
    };
  }, [player, tileKey, url]);
  useEffect(() => {
    if (!returning && !isVideoPlayerOnLoan(player)) player.pause();
  }, [player, returning]);
  useEffect(() => offer?.({ player, url, hasFrame: () => drawn.current, reattach: () => {} }), [offer, player, url]);
  return (
    <VideoView
      {...FEED_VIDEO_VIEW_PROPS}
      player={player}
      contentFit="cover"
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
      onFirstFrameRender={() => {
        drawn.current = true;
        reportReturnedVideoDrawn(player);
      }}
    />
  );
}
