/**
 * The containers ffmpeg may read a file as, by what the file is for.
 *
 * An upload is admitted on the type it declares (Storage and
 * `upload-finalization.ts` read the Content-Type the client sent, never the
 * bytes), and ffmpeg picks its demuxer from the bytes. Left to choose, it reads
 * a text playlist stored as `video/mp4` with the HLS demuxer and then opens
 * every entry the playlist names: another file on the machine for a local
 * input, any host and port for the duration probe, which reads over HTTPS
 * (security audit, 2026-11-26). The concat, DASH and image-sequence demuxers
 * open other files the same way.
 *
 * So every ffmpeg input names its demuxers with `-format_whitelist`, beside the
 * `-protocol_whitelist` that says where it may be read from. Each list holds
 * only single-file containers the buckets accept;
 * `ffmpeg-input-formats.test.ts` refuses a scripted one and holds each
 * invocation to its list.
 */

/** A clip: MP4, MOV and M4V (one demuxer under six names), WebM and Matroska. */
export const VIDEO_DEMUXERS = 'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm';

/** A reference track, as `reference-track-conversion.ts` reads one. */
export const TRACK_DEMUXERS = 'mp3,mov,mp4,m4a,3gp,3g2,mj2,wav,aac,ogg,matroska,webm,flac,caf,aiff';

/** A reference whose length is probed before a run: a clip or a track. */
export const REFERENCE_MEDIA_DEMUXERS = [
  ...new Set([...VIDEO_DEMUXERS.split(','), ...TRACK_DEMUXERS.split(',')]),
].join(',');

/** Input options for a clip in the server's own scratch space: a file, and a clip's container. */
export const LOCAL_VIDEO_INPUT_OPTIONS: readonly string[] = [
  '-protocol_whitelist', 'file',
  '-format_whitelist', VIDEO_DEMUXERS,
];
