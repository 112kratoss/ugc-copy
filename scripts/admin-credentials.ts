#!/usr/bin/env tsx
/**
 * Generates the master admin credential for the /admin console.
 *
 * The generated password is printed to this terminal once and never written to
 * disk: only the scrypt hash goes into the environment. Store the password in a
 * password manager immediately — it cannot be recovered from the hash.
 *
 *   npm run admin:credentials
 *   npm run admin:credentials -- --username ops
 *   npm run admin:credentials -- --password-stdin   # supply your own password
 */

import { randomBytes, randomInt } from 'node:crypto';

import { ADMIN_PASSWORD_MIN_LENGTH, hashAdminPassword } from '../src/lib/admin-password';

// Excludes characters that are easy to misread when copied by hand (0/O, 1/l/I).
const PASSWORD_ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789-_';
const GENERATED_PASSWORD_LENGTH = 28;

function parseArgs(argv: string[]) {
  const args = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      args.set(key, next);
      index += 1;
    } else {
      args.set(key, true);
    }
  }
  return args;
}

function generatePassword(): string {
  let password = '';
  for (let index = 0; index < GENERATED_PASSWORD_LENGTH; index += 1) {
    password += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
  }
  return password;
}

async function readPasswordFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const username = typeof args.get('username') === 'string'
    ? (args.get('username') as string).trim()
    : 'admin';

  if (!username) {
    throw new Error('--username cannot be empty.');
  }

  const usingStdin = args.get('password-stdin') === true;
  const password = usingStdin ? await readPasswordFromStdin() : generatePassword();

  if (password.length < ADMIN_PASSWORD_MIN_LENGTH) {
    throw new Error(`Password must be at least ${ADMIN_PASSWORD_MIN_LENGTH} characters.`);
  }

  const passwordHash = await hashAdminPassword(password);
  const sessionSecret = randomBytes(48).toString('base64url');

  process.stdout.write('\nMaster admin credential generated.\n');
  process.stdout.write('─'.repeat(72) + '\n');
  process.stdout.write(`  Username: ${username}\n`);
  if (usingStdin) {
    process.stdout.write('  Password: (the value you supplied on stdin)\n');
  } else {
    process.stdout.write(`  Password: ${password}\n`);
    process.stdout.write('\n  Save the password now — it is not stored anywhere and cannot be recovered.\n');
  }
  process.stdout.write('─'.repeat(72) + '\n\n');
  process.stdout.write('Add these to .env.local (and to the Vercel project for production):\n\n');
  process.stdout.write(`ADMIN_USERNAME=${username}\n`);
  process.stdout.write(`ADMIN_PASSWORD_HASH=${passwordHash}\n`);
  process.stdout.write(`ADMIN_SESSION_SECRET=${sessionSecret}\n`);
  process.stdout.write('ADMIN_REVIEWER_USER_ID=<your Supabase auth.users UUID>\n\n');
  process.stdout.write(
    'ADMIN_REVIEWER_USER_ID must be a real Supabase auth user: moderation writes it\n'
    + 'to reviewed_by, which is a foreign key into auth.users. Use your own account id.\n\n',
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
