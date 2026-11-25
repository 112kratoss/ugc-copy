/**
 * Whether media a feed failed to load is gone for this viewer, asked of the
 * failed address itself. The rule is shared with the app's Home feed and lives
 * in `ugc-mobile/lib/media-availability/media-availability.ts`, which says what
 * each answer means.
 */
export {
  checkMediaAvailability,
  MEDIA_AVAILABILITY_TIMEOUT_MS,
  type CheckMediaAvailabilityOptions,
  type MediaAvailability,
} from '../../ugc-mobile/lib/media-availability/media-availability';
