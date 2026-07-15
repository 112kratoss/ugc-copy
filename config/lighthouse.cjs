// eslint-disable-next-line @typescript-eslint/no-require-imports
const { URL } = require('node:url');

// eslint-disable-next-line @typescript-eslint/no-require-imports
const budgets = require('./performance-budgets.json');

const ALLOWED_FORM_FACTORS = new Set(['mobile', 'desktop']);
const DEFAULT_BASE_URL = 'https://magicbooklet.com';
const MAX_RUNS = 5;

const formFactor = process.env.LHCI_FORM_FACTOR || 'mobile';
if (!ALLOWED_FORM_FACTORS.has(formFactor)) {
  throw new Error('LHCI_FORM_FACTOR must be mobile or desktop.');
}

const numberOfRuns = Number(process.env.PERF_LIGHTHOUSE_RUNS || '3');
if (!Number.isInteger(numberOfRuns) || numberOfRuns < 1 || numberOfRuns > MAX_RUNS) {
  throw new Error(`PERF_LIGHTHOUSE_RUNS must be an integer between 1 and ${MAX_RUNS}.`);
}

const baseUrl = new URL(process.env.PERF_BASE_URL || DEFAULT_BASE_URL);
const loopbackHostnames = new Set(['localhost', '127.0.0.1', '[::1]']);
const isLoopbackHttp = baseUrl.protocol === 'http:'
  && loopbackHostnames.has(baseUrl.hostname.toLowerCase());
if (
  (baseUrl.protocol !== 'https:' && !isLoopbackHttp)
  || baseUrl.username
  || baseUrl.password
  || baseUrl.search
  || baseUrl.hash
) {
  throw new Error('Lighthouse targets must use credential-free HTTPS, except for loopback HTTP development servers.');
}

const pageTargets = budgets.load.targets.filter((target) => (
  target.method === 'GET' && !target.path.startsWith('/api/')
));
if (pageTargets.length < 3) {
  throw new Error('At least three browser page targets are required.');
}

for (const target of pageTargets) {
  if (!/^\/(?!\/)/.test(target.path) || target.path.includes('\\')) {
    throw new Error(`${target.name} is not a safe same-origin browser path.`);
  }
}

const urls = pageTargets.map((target) => {
  const url = new URL(target.path, baseUrl);
  if (url.origin !== baseUrl.origin) {
    throw new Error(`${target.name} resolved outside the Lighthouse origin.`);
  }
  return url.href;
});

const vitals = budgets.webVitals;
const aggregationMethod = 'median';

const config = {
  ci: {
    collect: {
      numberOfRuns,
      url: urls,
      settings: {
        chromeFlags: '--headless=new --no-sandbox --disable-dev-shm-usage',
        maxWaitForLoad: 60_000,
        onlyCategories: ['performance'],
        // Apply the network/CPU constraints in Chrome. Lantern's simulated
        // dependency model overstates LCP for streamed React Server Component
        // HTML by treating already-painted server content as hydration-bound.
        throttlingMethod: 'devtools',
        ...(formFactor === 'desktop' ? { preset: 'desktop' } : {}),
      },
    },
    assert: {
      assertions: {
        'categories:performance': ['warn', { minScore: 0.85, aggregationMethod }],
        'largest-contentful-paint': ['error', { maxNumericValue: vitals.LCP, aggregationMethod }],
        'cumulative-layout-shift': ['error', { maxNumericValue: vitals.CLS, aggregationMethod }],
        'first-contentful-paint': ['error', { maxNumericValue: vitals.FCP, aggregationMethod }],
        'server-response-time': ['error', { maxNumericValue: vitals.TTFB, aggregationMethod }],
        // Lighthouse cannot measure field INP; TBT is its lab main-thread responsiveness proxy.
        'total-blocking-time': ['error', { maxNumericValue: vitals.INP, aggregationMethod }],
        interactive: ['error', { maxNumericValue: 5_000, aggregationMethod }],
      },
    },
    upload: {
      target: 'filesystem',
      outputDir: `lighthouse-results/${formFactor}`,
    },
  },
};

module.exports = config;

if (require.main === module) {
  process.stdout.write(
    `Lighthouse config self-check passed for ${urls.length} ${formFactor} page targets and ${numberOfRuns} run(s).\n`
  );
}
