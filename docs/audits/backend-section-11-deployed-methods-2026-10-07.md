# Section 11N — deployed protocol and anonymous admission controls

Twenty actual live HTTP controls pass before and after the #390 release:
`a171fd76c0dadfef8ce307a62b9188c2c475f055`, then
`2ee4066b3d763714d379e43ad2945e67e6c47f77`. The tested proxy, compatibility
policy, app-version adapter and mobile operations contract are byte-identical
between these builds. No runtime or configuration change was needed.

The live controls cover:

- App-version GET and bodyless HEAD, including old/future client exemption so
  incompatible clients can retrieve policy. GET reports the exact released build.
- App-version/profile preflight responses: the site's origin receives the CORS
  grant and an unrelated origin receives none.
- Old-app and future-API rejection before GET, unsupported POST and preflight
  handling, with the expected 426/409 code and private/no-store response.
- Current and unversioned mobile profile requests without identity return 401.
  Admin API HEAD/preflight remain independently gated with 401 and no mobile
  CORS grant; admin page HEAD redirects to login with no body.

The POST cases target `/api/fx`, which exports GET only, with no body. Their
version rejection occurs before the adapter; even an absent version gate would
reach an unsupported method rather than a mutation. No positive telemetry,
payment, generation, customer mutation or provider operation runs.

This verifies server responses and headers. It does not certify browser CORS
execution, genuine installed-client delivery, positive authenticated methods,
all framework-generated methods, or every operations collector. OPS-04/MAP-02
remain untested for their broader matrices. Earlier 11B actual loopback ingress
and 11C/H production Next/browser evidence remain complementary.

Private results and runtime digests are under
`.audit-evidence/backend-social/deployed-methods/`, with the preceding build's
results preserved separately. The 53-row checklist is unchanged.
