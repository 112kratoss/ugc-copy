import type { VideoPlayer } from 'expo-video';

import { isVideoPlayerHandedBack } from './video-player-loans';
import { beginPlaybackStart } from '@/lib/playback-metrics';
import { isViewerAudioMuted } from './viewer-audio';

function stopPlayer(player: VideoPlayer) {
  // A player the reel handed back to a feed tile is the tile's to play or pause.
  if (isVideoPlayerHandedBack(player)) return;
  try {
    player.muted = true;
    player.pause();
  } catch {
    // Native players can already be released during a route unmount.
  }
}

/** One registry per viewer route: stacked viewers may contain the same posts. */
export function createViewerPlaybackHandoff() {
  const players = new Map<string, VideoPlayer>();
  // By post and stream too: a post can hold several videos, and a close hands
  // back only the player of the one on screen.
  const sourcePlayers = new Map<string, VideoPlayer>();
  let autoplayAllowed = false;

  const sourceKey = (postId: string, url: string) => `${postId}\u0000${url}`;

  return {
    /** The player the slide for this post and stream is drawing with, if any. */
    playerFor(postId: string, url: string) {
      return sourcePlayers.get(sourceKey(postId, url)) ?? null;
    },

    register(postId: string, player: VideoPlayer, url?: string) {
      players.set(postId, player);
      if (url) sourcePlayers.set(sourceKey(postId, url), player);
      return () => {
        if (players.get(postId) === player) players.delete(postId);
        if (url && sourcePlayers.get(sourceKey(postId, url)) === player) {
          sourcePlayers.delete(sourceKey(postId, url));
        }
      };
    },

    setAutoplayAllowed(allowed: boolean) {
      autoplayAllowed = allowed;
      // A handoff may have started a neighbour whose React active prop is
      // still false. Stop every prepared player, not just the settled slide.
      if (!allowed) players.forEach(stopPlayer);
      // Re-enabling never starts neighbours; the active slide resumes itself.
    },

    handoff({ from, to }: { from?: string | null; to?: string | null }) {
      const outgoing = from ? players.get(from) : undefined;
      const incoming = to ? players.get(to) : undefined;
      if (outgoing && outgoing !== incoming) stopPlayer(outgoing);
      if (!incoming) return;
      // Consult current route eligibility even if a queued scroll callback
      // belongs to the render from before focus loss or an overlay opening.
      if (!autoplayAllowed) {
        stopPlayer(incoming);
        return;
      }
      if (incoming === outgoing) return;
      // Fleet metrics: a prepared neighbour's start runs from this ask to its
      // first sign of motion (lib/playback-metrics).
      beginPlaybackStart(`viewer:${to}`, { surface: 'viewer', kind: 'warm' });
      try {
        incoming.muted = isViewerAudioMuted();
        incoming.play();
      } catch {
        // The activation effect will handle a replacement native player.
      }
    },
  };
}
