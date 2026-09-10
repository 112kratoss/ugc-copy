import type { VideoPlayer } from 'expo-video';

import { isViewerAudioMuted } from './viewer-audio';

function stopPlayer(player: VideoPlayer) {
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
  let autoplayAllowed = false;

  return {
    register(postId: string, player: VideoPlayer) {
      players.set(postId, player);
      return () => {
        if (players.get(postId) === player) players.delete(postId);
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
      try {
        incoming.muted = isViewerAudioMuted();
        incoming.play();
      } catch {
        // The activation effect will handle a replacement native player.
      }
    },
  };
}
