import { pathToFileURL } from 'node:url';

import { createClient } from '@supabase/supabase-js';

import {
  listOpenModerationReports,
  resolvePostReport,
  resolveSubjectReport,
} from '../src/lib/moderation-ops';

const USAGE = `
Magicbooklet moderation operations (service role only)

Usage:
  npm run ops:moderation -- list [--limit 50] [--json]
  npm run ops:moderation -- take-down-post --report-id <uuid> --reviewer-id <uuid> --confirm [--note "..."]
  npm run ops:moderation -- dismiss-post --report-id <uuid> --reviewer-id <uuid> --confirm [--note "..."]
  npm run ops:moderation -- resolve-subject --report-id <uuid> --reviewer-id <uuid> --confirm
  npm run ops:moderation -- dismiss-subject --report-id <uuid> --reviewer-id <uuid> --confirm

Environment:
  SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL)
  SUPABASE_SERVICE_ROLE_KEY

Notes:
  - Apply all pending Supabase migrations before using mutation commands.
  - reviewer-id must identify the staff member's real auth.users row.
  - Resolve a user/generation report only after completing the required manual safety action.
`.trim();

type ParsedArguments = {
  command: string | null;
  flags: Map<string, string | true>;
};

function parseArguments(args: string[]): ParsedArguments {
  const [command = null, ...tokens] = args;
  const flags = new Map<string, string | true>();

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--')) {
      throw new Error(`Unexpected argument: ${token}`);
    }
    if (token === '--json' || token === '--confirm' || token === '--help') {
      flags.set(token, true);
      continue;
    }

    const value = tokens[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${token}.`);
    }
    flags.set(token, value);
    index += 1;
  }

  return { command, flags };
}

function requireFlag(flags: Map<string, string | true>, name: string) {
  const value = flags.get(name);
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
}

function requireConfirmation(flags: Map<string, string | true>) {
  if (flags.get('--confirm') !== true) {
    throw new Error('Mutation refused. Review the report, then repeat with --confirm.');
  }
}

function optionalLimit(flags: Map<string, string | true>) {
  const raw = flags.get('--limit');
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw new Error('--limit must be a positive integer.');
  }
  return Number(raw);
}

function summarizeDetails(value: string | null) {
  if (!value) return '';
  return value.length <= 100 ? value : `${value.slice(0, 97)}...`;
}

function printQueue(snapshot: Awaited<ReturnType<typeof listOpenModerationReports>>) {
  console.log(`Open post reports: ${snapshot.postReports.length}`);
  if (snapshot.postReports.length > 0) {
    console.table(snapshot.postReports.map((report) => ({
      report_id: report.id,
      post_id: report.postId,
      reason: report.reason,
      details: summarizeDetails(report.details),
      post_status: report.post?.reviewStatus ?? 'missing',
      post_title: report.post?.title ?? '',
      created_at: report.createdAt,
    })));
  }

  console.log(`Open/reviewing user and generation reports: ${snapshot.subjectReports.length}`);
  if (snapshot.subjectReports.length > 0) {
    console.table(snapshot.subjectReports.map((report) => ({
      report_id: report.id,
      target_type: report.targetType,
      target_id: report.reportedUserId ?? report.generationId,
      reason: report.reason,
      details: summarizeDetails(report.details),
      status: report.status,
      created_at: report.createdAt,
    })));
  }
}

export async function runModerationOps(
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
) {
  const { command, flags } = parseArguments(args);
  if (!command || command === 'help' || command === '--help' || flags.has('--help')) {
    console.log(USAGE);
    return;
  }

  const supabaseUrl = environment.SUPABASE_URL || environment.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = environment.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });

  if (command === 'list') {
    const snapshot = await listOpenModerationReports(supabase, { limit: optionalLimit(flags) });
    if (flags.get('--json') === true) {
      console.log(JSON.stringify(snapshot, null, 2));
    } else {
      printQueue(snapshot);
    }
    return;
  }

  requireConfirmation(flags);
  const reportId = requireFlag(flags, '--report-id');
  const reviewerId = requireFlag(flags, '--reviewer-id');

  if (command === 'take-down-post' || command === 'dismiss-post') {
    const result = await resolvePostReport(supabase, {
      reportId,
      reviewerId,
      action: command === 'take-down-post' ? 'take_down' : 'dismiss',
      resolutionNote: typeof flags.get('--note') === 'string' ? flags.get('--note') as string : null,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === 'resolve-subject' || command === 'dismiss-subject') {
    const result = await resolveSubjectReport(supabase, {
      reportId,
      reviewerId,
      action: command === 'resolve-subject' ? 'resolve' : 'dismiss',
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  throw new Error(`Unknown command: ${command}\n\n${USAGE}`);
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  runModerationOps(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
