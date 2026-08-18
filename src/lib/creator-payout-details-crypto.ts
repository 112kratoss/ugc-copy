import 'server-only';

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { isProductionDeployment } from '@/lib/backend-environment';
import { logBackendWarning } from '@/lib/backend-logger';

/**
 * At-rest encryption for `creator_payout_requests.payout_details` (UPI ids,
 * bank contact details). AES-256-GCM with a server-held key; the database and
 * its backups only ever see ciphertext, and the admin payout queue decrypts on
 * read.
 *
 * Stored format: `enc.v1.<iv>.<ciphertext>.<tag>` with dot-delimited base64url
 * segments — dot-delimited for the same reason as ADMIN_PASSWORD_HASH: values
 * flow through dotenv-expand in `.env` files, which mangles `$`-delimited
 * forms. Rows written before this module existed are plaintext; readers fall
 * back to returning them as-is so the operator queue never loses history.
 */

const ENCRYPTED_PREFIX = 'enc.v1.';
const KEY_ENV_VAR = 'CREATOR_PAYOUT_DETAILS_ENCRYPTION_KEY';
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

export class CreatorPayoutDetailsCryptoError extends Error {}

export type DecryptCreatorPayoutDetailsResult =
  | { ok: true; plaintext: string; encrypted: boolean }
  | { ok: false; reason: 'key_unconfigured' | 'malformed' | 'decrypt_failed' };

export function isEncryptedCreatorPayoutDetails(value: string): boolean {
  return value.startsWith(ENCRYPTED_PREFIX);
}

function loadKey(environment: NodeJS.ProcessEnv): Buffer | null {
  const raw = environment[KEY_ENV_VAR]?.trim();
  if (!raw) {
    return null;
  }

  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new CreatorPayoutDetailsCryptoError(
      `${KEY_ENV_VAR} must be base64 for exactly 32 bytes (mint with \`openssl rand -base64 32\`).`,
    );
  }

  return key;
}

/**
 * Encrypts payout details for storage. Fails closed in production when the key
 * is unconfigured — silently storing plaintext would defeat the guarantee — and
 * passes plaintext through (with a warning) in non-production environments so
 * local development does not require the key.
 */
export function encryptCreatorPayoutDetails(
  plaintext: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const key = loadKey(environment);
  if (!key) {
    if (isProductionDeployment(environment)) {
      throw new CreatorPayoutDetailsCryptoError(
        `${KEY_ENV_VAR} is not configured; refusing to store payout details in plaintext.`,
      );
    }

    logBackendWarning('creator_payout_details_stored_plaintext', {
      reason: `${KEY_ENV_VAR} is not configured in this non-production environment.`,
    });
    return plaintext;
  }

  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${ENCRYPTED_PREFIX}${iv.toString('base64url')}.${ciphertext.toString('base64url')}.${tag.toString('base64url')}`;
}

export function decryptCreatorPayoutDetails(
  stored: string,
  environment: NodeJS.ProcessEnv = process.env,
): DecryptCreatorPayoutDetailsResult {
  if (!isEncryptedCreatorPayoutDetails(stored)) {
    // Legacy row written before encryption existed.
    return { ok: true, plaintext: stored, encrypted: false };
  }

  const key = loadKey(environment);
  if (!key) {
    return { ok: false, reason: 'key_unconfigured' };
  }

  const segments = stored.slice(ENCRYPTED_PREFIX.length).split('.');
  if (segments.length !== 3) {
    return { ok: false, reason: 'malformed' };
  }

  const [iv, ciphertext, tag] = segments.map((segment) => Buffer.from(segment, 'base64url'));
  if (iv.length !== GCM_IV_BYTES || tag.length !== GCM_TAG_BYTES) {
    return { ok: false, reason: 'malformed' };
  }

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    return { ok: true, plaintext, encrypted: true };
  } catch {
    // Wrong key or tampered ciphertext; GCM authentication failed.
    return { ok: false, reason: 'decrypt_failed' };
  }
}
