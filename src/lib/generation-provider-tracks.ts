/**
 * Where a run keeps the copies of its tracks converted for the provider
 * (reference-track-conversion): `generation_inputs/<userId>/<generationId>/provider-tracks/`,
 * in the run's own folder, written once the run is held. They are the
 * provider's files, not the run's inputs, so no input row names them: deleting
 * the run removes the folder (generation-delete-service), and account deletion
 * clears it with the rest of the user's folders.
 */
export const PROVIDER_TRACKS_FOLDER = 'provider-tracks';

export function providerTrackFolder(userId: string, generationId: string): string {
  return `${userId}/${generationId}/${PROVIDER_TRACKS_FOLDER}`;
}
