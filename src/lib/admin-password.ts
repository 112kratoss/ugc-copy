import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Node-only password hashing for the master admin credential.
 *
 * The plaintext password never reaches the repository or the environment: only
 * `ADMIN_PASSWORD_HASH` is stored, in the format below. Keep this module out of
 * middleware — `node:crypto` is unavailable on the Edge runtime, which is why
 * session verification lives in `admin-session-token.ts` instead.
 *
 * Format: `scrypt.<N>.<r>.<p>.<saltBase64Url>.<keyBase64Url>`
 *
 * The delimiter is `.` and the encoding is base64url specifically so the whole
 * value matches [A-Za-z0-9._-]. The conventional `$`-delimited MCF form breaks
 * here: Next.js loads .env files through dotenv-expand, which treats `$name` as
 * a variable reference and silently rewrites `scrypt$16384$8$1$<salt>$<key>`
 * into a corrupted string. A hash that fails to parse would lock the operator
 * out with a misleading "invalid hash" message, so the encoding avoids every
 * character that any layer might interpret.
 */

const SCRYPT_ALGORITHM = 'scrypt';
const HASH_DELIMITER = '.';
const SCRYPT_COST = 16384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SCRYPT_KEY_LENGTH = 64;
const SALT_BYTES = 16;

export const ADMIN_PASSWORD_MIN_LENGTH = 12;

type ParsedPasswordHash = {
  cost: number;
  blockSize: number;
  parallelization: number;
  salt: Buffer;
  derivedKey: Buffer;
};

function deriveKey(
  password: string,
  salt: Buffer,
  options: { cost: number; blockSize: number; parallelization: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize('NFKC'),
      salt,
      SCRYPT_KEY_LENGTH,
      {
        N: options.cost,
        r: options.blockSize,
        p: options.parallelization,
        // scrypt's default maxmem (32 MiB) is below what N=16384, r=8 needs.
        maxmem: 128 * options.cost * options.blockSize * 2,
      },
      (error, derived) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(derived);
      },
    );
  });
}

export async function hashAdminPassword(password: string): Promise<string> {
  if (password.length < ADMIN_PASSWORD_MIN_LENGTH) {
    throw new Error(`Admin password must be at least ${ADMIN_PASSWORD_MIN_LENGTH} characters.`);
  }

  const salt = randomBytes(SALT_BYTES);
  const derivedKey = await deriveKey(password, salt, {
    cost: SCRYPT_COST,
    blockSize: SCRYPT_BLOCK_SIZE,
    parallelization: SCRYPT_PARALLELIZATION,
  });

  return [
    SCRYPT_ALGORITHM,
    SCRYPT_COST,
    SCRYPT_BLOCK_SIZE,
    SCRYPT_PARALLELIZATION,
    salt.toString('base64url'),
    derivedKey.toString('base64url'),
  ].join(HASH_DELIMITER);
}

export function parseAdminPasswordHash(value: string | null | undefined): ParsedPasswordHash | null {
  const parts = value?.trim().split(HASH_DELIMITER) ?? [];
  if (parts.length !== 6 || parts[0] !== SCRYPT_ALGORITHM) {
    return null;
  }

  const cost = Number(parts[1]);
  const blockSize = Number(parts[2]);
  const parallelization = Number(parts[3]);
  if (
    !Number.isInteger(cost) || cost < 1024
    || !Number.isInteger(blockSize) || blockSize < 1
    || !Number.isInteger(parallelization) || parallelization < 1
  ) {
    return null;
  }

  try {
    const salt = Buffer.from(parts[4], 'base64url');
    const derivedKey = Buffer.from(parts[5], 'base64url');
    if (salt.length === 0 || derivedKey.length !== SCRYPT_KEY_LENGTH) {
      return null;
    }
    return { cost, blockSize, parallelization, salt, derivedKey };
  } catch {
    return null;
  }
}

export async function verifyAdminPassword(
  password: string,
  storedHash: string | null | undefined,
): Promise<boolean> {
  const parsed = parseAdminPasswordHash(storedHash);
  if (!parsed) {
    return false;
  }

  const candidate = await deriveKey(password, parsed.salt, {
    cost: parsed.cost,
    blockSize: parsed.blockSize,
    parallelization: parsed.parallelization,
  });

  return candidate.length === parsed.derivedKey.length
    && timingSafeEqual(candidate, parsed.derivedKey);
}
