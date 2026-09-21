# Feed admission locality and production dependency patches

## Problem and change

Release `b4c52f91` fixed the delivery-fact session lookup (a bounded missing-key
probe went from 1,509.665 ms to 1.585 ms), but the authenticated first-page feed
still exceeded its 1,800 ms P95 TTFB budget: 2,309.6 ms across 14 samples in
[production run 35568242689](https://github.com/112kratoss/ugc-copy/actions/runs/35568242689).
The global proxy still made a database round trip before routing to Mumbai.

Move the existing identity evaluator unchanged into a shared module. Only feed
GET/HEAD defer from the proxy to an explicit wrapper on the real route exports.
The route executes in the existing `vercel.json` function region (`bom1`), next
to Supabase (`ap-south-1`). Every request still freshly checks JWT validity,
session existence, ban status and lifecycle state. Incoming assertions/timings
are stripped, and the handler makes a new token/method/path-bound assertion for
the adapter. Public requests without a token retain their cache behavior.
Version gating, CORS and all other routes retain their existing proxy behavior.

The installed Next.js authentication guide recommends database-backed checks
near the data source, rather than in the globally invoked proxy. Its Node proxy
build output has no configurable region, and `preferredRegion` is deprecated.
Use the existing regional API function instead of adding an ineffective region
property or caching revocation checks.

Patch Next.js and its ESLint config to 16.3.3, sharp to 0.35.4, and refresh the
affected compatible browserslist, baseline-browser-mapping and fast-uri lockfile
entries. These address the production advisories, including AVIF/libheif input
processing. `npm audit --omit=dev` reports zero vulnerabilities. The full audit
still reports development-tool advisories (including the Lighthouse/Puppeteer
chain); no forced major changes or downgrades are included in this patch.

## Verification

Focused admission, assertion and feed-adapter tests: 41 passed. Test and app
typechecks, changed-file ESLint and diff checks passed. Regression cases exercise
the actual GET/HEAD exports, inactive and revoked identities, invalid claims,
database failure, incoming assertion stripping, tokenless reads, and adapter
reuse without an additional Auth lookup. Full Quality and production release
must pass before evaluating the live timing improvement.

After release, repeat the bounded production monitor on the exact live commit.
Compare `route-identity` and its lifecycle/verification phases with the previous
`proxy-identity` timing, along with complete TTFB. Small samples and different
runner locations limit a before/after comparison; this is not a capacity claim.

## References

- [Next.js authorization guidance](https://nextjs.org/docs/app/guides/authentication#optimistic-checks-with-proxy-optional)
- [Next.js AVIF advisory](https://github.com/advisories/GHSA-2xp9-vwfh-vxw4)
- [sharp/libheif advisory](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c)
