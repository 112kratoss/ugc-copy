import { describe, expect, it } from 'vitest';

import * as server from '@/lib/models';
import * as client from '@/lib/client-generation-models';

/**
 * The browser bundle must not import @/lib/models (pricing/provider ids stay
 * server-side), so client-generation-models.ts mirrors the display fields by
 * hand. Nothing verified the mirrors until now — real drift had already crept
 * in (differing descriptions, a hardcoded quality-mode list). This suite pins
 * every shared field so the mirrors cannot diverge silently again.
 */

const IMAGE_SHARED_FIELDS = [
  'displayName',
  'description',
  'badge',
  'badgeColor',
  'accentColor',
  'maxImages',
  'supportsGoogleSearch',
  'supportsOutputFormat',
  'aspectRatios',
  'resolutions',
  'outputFormats',
  'qualityModes',
  'requiresReference',
] as const;

const VIDEO_SHARED_FIELDS = [
  'displayName',
  'description',
  'supportsMultiShot',
  'supportsSound',
  'supportsFixedLens',
  'aspectRatios',
  'durations',
  'singleShotDurationRange',
  'resolutions',
  'modeOptions',
] as const;

const MOTION_SHARED_FIELDS = [
  'displayName',
  'description',
  'badge',
  'badgeColor',
  'maxDuration',
  'characterOrientations',
  'resolutions',
] as const;

function pick(entry: Record<string, unknown>, fields: readonly string[]) {
  return Object.fromEntries(fields
    .filter((field) => field in entry)
    .map((field) => [field, entry[field]]));
}

describe('server/client model registry parity', () => {
  it('mirrors the same image model ids', () => {
    expect(Object.keys(client.IMAGE_MODELS).sort()).toEqual(Object.keys(server.IMAGE_MODELS).sort());
  });

  it('mirrors the same video model ids', () => {
    expect(Object.keys(client.VIDEO_MODELS).sort()).toEqual(Object.keys(server.VIDEO_MODELS).sort());
  });

  it('mirrors the same motion model ids', () => {
    expect(Object.keys(client.MOTION_MODELS).sort()).toEqual(Object.keys(server.MOTION_MODELS).sort());
  });

  it.each(Object.keys(server.IMAGE_MODELS))('keeps image model %s field-identical', (id) => {
    const serverEntry = server.IMAGE_MODELS[id as keyof typeof server.IMAGE_MODELS] as Record<string, unknown>;
    const clientEntry = client.IMAGE_MODELS[id as keyof typeof client.IMAGE_MODELS] as Record<string, unknown>;
    expect(pick(clientEntry, IMAGE_SHARED_FIELDS)).toEqual(pick(serverEntry, IMAGE_SHARED_FIELDS));
  });

  it.each(Object.keys(server.VIDEO_MODELS))('keeps video model %s field-identical', (id) => {
    const serverEntry = server.VIDEO_MODELS[id as keyof typeof server.VIDEO_MODELS] as Record<string, unknown>;
    const clientEntry = client.VIDEO_MODELS[id as keyof typeof client.VIDEO_MODELS] as Record<string, unknown>;
    expect(pick(clientEntry, VIDEO_SHARED_FIELDS)).toEqual(pick(serverEntry, VIDEO_SHARED_FIELDS));
  });

  it.each(Object.keys(server.MOTION_MODELS))('keeps motion model %s field-identical', (id) => {
    const serverEntry = server.MOTION_MODELS[id as keyof typeof server.MOTION_MODELS] as Record<string, unknown>;
    const clientEntry = client.MOTION_MODELS[id as keyof typeof client.MOTION_MODELS] as Record<string, unknown>;
    expect(pick(clientEntry, MOTION_SHARED_FIELDS)).toEqual(pick(serverEntry, MOTION_SHARED_FIELDS));
  });
});
