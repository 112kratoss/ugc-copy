import { useEffect, useRef, useState } from 'react';
import type { VideoPlayer, VideoSource } from 'expo-video';

/**
 * Frames let pass after the view is laid out. Android makes the view's surface
 * in the first of them, and hands it to the player the view already holds.
 */
const FRAMES_BEFORE_SOURCE = 2;

/**
 * Gives a player its clip only once the view it draws in has a surface. It is
 * for Android; given `null` it does nothing.
 *
 * A player made with its clip starts loading at once, before its view exists.
 * With the clip already in the video cache the decoder is running a median of
 * 27 ms later, on a placeholder surface, and the view's surface reaches the
 * player at a median of 35 ms: Android then moves the decoder to it (101 of 102
 * mounts on the emulator, 2026-10-05). A decoded frame on its way from the
 * codec service to the app at that instant belongs to the old surface when it
 * arrives and cannot be queued to the new one. MediaCodec logs `rendring output
 * error -32` and tells nobody, and the player reports the frame as rendered.
 * When that frame was the first, a paused clip showed its controls and its
 * duration over an empty surface for as long as it stayed paused (5 mounts in
 * 102). When it was the one after, the clip went blank the next time its
 * surface was taken away and given back, as by another screen opened over it
 * and closed.
 *
 * JS is told the same on a mount that lost its frame and on one that drew it,
 * so there is nothing to react to, and the move is taken away instead. The
 * player is made empty, its view attaches it and makes its surface, and only
 * then is it given the clip: the decoder starts on the surface it keeps (102 of
 * 102 mounts, and no frame lost). Drawing the frame again after the fact, with
 * a seek away and back, also brought the picture up. It flushes the decoder
 * twice as it starts, on every mount, to repair what need not happen.
 *
 * A renewed link goes to the same player, which keeps its place. Making a new
 * player for it, as the hook would on a change of source, starts that player
 * loading before the view has handed it the surface: the same race again.
 */
export function useVideoSourceAfterSurface(source: VideoSource, player: VideoPlayer) {
  const [surfaceReady, setSurfaceReady] = useState(false);
  const laidOut = useRef(false);
  const pendingFrame = useRef<number | null>(null);
  const given = useRef<{ player: VideoPlayer; key: string } | null>(null);
  const key = source === null ? null : JSON.stringify(source);

  useEffect(() => () => {
    if (pendingFrame.current !== null) cancelAnimationFrame(pendingFrame.current);
  }, []);

  useEffect(() => {
    if (!surfaceReady || source === null || key === null) return;
    const before = given.current;
    if (before?.player === player && before.key === key) return;
    given.current = { player, key };
    const at = before?.player === player ? player.currentTime : 0;
    void player.replaceAsync(source)
      .then(() => { if (at > 0) player.currentTime = at; })
      // The player was released while its clip was on the way to it.
      .catch(() => undefined);
  }, [player, surfaceReady, key]);

  const onLayout = () => {
    if (source === null || laidOut.current) return;
    laidOut.current = true;
    let frames = FRAMES_BEFORE_SOURCE;
    const frame = () => {
      frames -= 1;
      if (frames > 0) {
        pendingFrame.current = requestAnimationFrame(frame);
        return;
      }
      pendingFrame.current = null;
      setSurfaceReady(true);
    };
    pendingFrame.current = requestAnimationFrame(frame);
  };

  return { onLayout };
}
