import { dirname, join, relative } from 'node:path';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const projectRoot = process.cwd();
const apiRoot = join(projectRoot, 'src/app/api');
const vercelConfig = JSON.parse(readFileSync(join(projectRoot, 'vercel.json'), 'utf8')) as {
  crons?: Array<{ path: string; schedule: string }>;
};

const mutationRoutePattern = /export\s+async\s+function\s+(POST|PUT|PATCH|DELETE)\b/g;
const rateLimitGuardPattern = /\b(?:enforceBackendRateLimit|enforceWorkflowCanvasMutationRateLimit)\b/;
const providerAuthGuardPattern = /\b(?:webhookAuthorizationMatches|verifyKieWebhookAuthorization|verifyRazorpaySignature|verifyRazorpayPaymentSignature)\b/;
const webhookPayloadGuardPattern = /\bisWebhookPayloadTooLarge\b/;
const cronAuthGuardPattern = /\bisAuthorizedCronRequest\b/;
const privateNoStoreGuardPattern = /(?:\b(?:applyPrivateNoStoreApiResponseHeaders|createPrivateNoStoreApiResponseHeaders|API_CACHE_CONTROL\.privateNoStore)\b|['"]Cache-Control['"]\s*:\s*['"]private, no-store['"])/;
const razorpaySdkPattern = /(?:from\s+['"]razorpay['"]|\bnew\s+Razorpay\b|\border[s]?\s*\.\s*create\b)/;
const directRazorpayOrderClientPattern = /\bcreateRazorpayOrder\b/;
const localImportPattern = /import\s+(?:type\s+)?(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/g;

const knownProviderWebhookRoutes = new Set([
  'src/app/api/mobile/commerce/revenuecat-webhook/route.ts',
  'src/app/api/razorpay/webhook/route.ts',
  'src/app/api/webhooks/kie/route.ts',
]);
const knownBoundedPublicMutationRoutes = new Set([
  'src/app/api/security/csp-report/route.ts',
]);

const paymentOrderRoutes = new Set([
  'src/app/api/marketplace/order/route.ts',
  'src/app/api/posts/[postId]/resource-bundle/order/route.ts',
  'src/app/api/razorpay/order/route.ts',
]);
const maxApiRouteEntrypointLines = 12;

function listRouteFiles(root: string): string[] {
  if (!existsSync(root)) return [];

  return readdirSync(root)
    .flatMap((entry) => {
      const fullPath = join(root, entry);
      if (statSync(fullPath).isDirectory()) {
        return listRouteFiles(fullPath);
      }

      return entry === 'route.ts' ? [fullPath] : [];
    })
    .sort();
}

function exportedMutationMethods(source: string): string[] {
  return [...source.matchAll(mutationRoutePattern)].map((match) => match[1]);
}

function toProjectPath(path: string): string {
  return relative(projectRoot, path).replaceAll('\\', '/');
}

function resolveLocalImportPath(specifier: string, importerPath: string): string | null {
  if (specifier.startsWith('@/')) {
    return resolveImportCandidate(join(projectRoot, 'src', specifier.slice(2)));
  }

  if (specifier.startsWith('.')) {
    return resolveImportCandidate(join(dirname(importerPath), specifier));
  }

  return null;
}

function resolveImportCandidate(basePath: string): string | null {
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    join(basePath, 'index.ts'),
    join(basePath, 'index.tsx'),
  ];

  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
}

function readRouteProtectionSource(path: string, visited = new Set<string>(), depth = 0): string {
  if (visited.has(path) || depth > 6) return '';
  visited.add(path);

  const source = readFileSync(path, 'utf8');
  const importedSources = [...source.matchAll(localImportPattern)]
    .map((match) => resolveLocalImportPath(match[1], path))
    .filter((importPath): importPath is string => Boolean(importPath))
    .map((importPath) => readRouteProtectionSource(importPath, visited, depth + 1));

  return [source, ...importedSources].join('\n');
}

describe('API route protection coverage', () => {
  it('keeps every mutating API route behind a rate-limit or provider-auth guard', () => {
    const unprotectedRoutes = listRouteFiles(apiRoot)
      .map((path) => {
        const source = readFileSync(path, 'utf8');
        return {
          path: toProjectPath(path),
          source: readRouteProtectionSource(path),
          methods: exportedMutationMethods(source),
        };
      })
      .filter((route) => route.methods.length > 0)
      .filter((route) => !knownBoundedPublicMutationRoutes.has(route.path))
      .filter((route) => (
        !rateLimitGuardPattern.test(route.source)
        && !providerAuthGuardPattern.test(route.source)
      ))
      .map((route) => `${route.path} (${route.methods.join(', ')})`);

    expect(unprotectedRoutes).toEqual([]);
  });

  it('keeps every mutating API response private and non-cacheable', () => {
    const cacheableMutationRoutes = listRouteFiles(apiRoot)
      .map((path) => {
        const source = readFileSync(path, 'utf8');
        return {
          path: toProjectPath(path),
          source: readRouteProtectionSource(path),
          methods: exportedMutationMethods(source),
        };
      })
      .filter((route) => route.methods.length > 0)
      .filter((route) => !privateNoStoreGuardPattern.test(route.source))
      .map((route) => `${route.path} (${route.methods.join(', ')})`);

    expect(cacheableMutationRoutes).toEqual([]);
  });

  it('keeps provider webhook routes protected by provider auth and a cheap payload-size guard', () => {
    const missingWebhookGuards = [...knownProviderWebhookRoutes]
      .filter((path) => {
        const source = readRouteProtectionSource(join(projectRoot, path));
        return !providerAuthGuardPattern.test(source) || !webhookPayloadGuardPattern.test(source);
      });

    expect(missingWebhookGuards).toEqual([]);
  });

  it('keeps every configured Vercel cron route behind the shared cron secret guard', () => {
    const unprotectedCronRoutes = (vercelConfig.crons ?? [])
      .map((cron) => ({
        routePath: `src/app${cron.path}/route.ts`,
        schedule: cron.schedule,
      }))
      .filter(({ routePath }) => {
        const source = readRouteProtectionSource(join(projectRoot, routePath));
        return !cronAuthGuardPattern.test(source);
      })
      .map(({ routePath, schedule }) => `${routePath} (${schedule})`);

    expect(unprotectedCronRoutes).toEqual([]);
  });

  it('keeps payment order routes on the shared abortable Razorpay client', () => {
    const directSdkRoutes = listRouteFiles(apiRoot)
      .map((path) => {
        const source = readFileSync(path, 'utf8');
        return {
          path: toProjectPath(path),
          source,
        };
      })
      .filter((route) => razorpaySdkPattern.test(route.source))
      .map((route) => route.path);

    const missingSharedClient = [...paymentOrderRoutes]
      .filter((path) => {
        const source = readRouteProtectionSource(join(projectRoot, path));
        return !directRazorpayOrderClientPattern.test(source);
      });

    expect(directSdkRoutes).toEqual([]);
    expect(missingSharedClient).toEqual([]);
  });

  it('keeps API route entrypoints thin enough to delegate business logic', () => {
    const oversizedRoutes = listRouteFiles(apiRoot)
      .map((path) => ({
        path: toProjectPath(path),
        lineCount: readFileSync(path, 'utf8').trimEnd().split('\n').length,
      }))
      .filter((route) => route.lineCount > maxApiRouteEntrypointLines)
      .map((route) => `${route.path} (${route.lineCount} lines)`);

    expect(oversizedRoutes).toEqual([]);
  });
});
