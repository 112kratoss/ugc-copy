# Section 7J — assistant application transaction evidence

October 4, 2026. Existing audit checkout, incorporating main f1a6e7b7. This batch
adds permanent evidence to WORKFLOW-04; it changes no runtime code or migration.
The existing authenticated, invoker SQL routine behaved correctly in these probes.

`workflow-assistant-transitions-database.test.ts` now has 17 actual database cases:
the seven existing discard controls plus ten apply controls. Three previously
private probes are permanent: stale revisions, rollback when a real history
insert trigger raises, and competing ready proposals at the same base revision.
The additional cases cover service-normalized graph/history/publication updates,
a save committed after the service reads, lost acknowledgement after observed
commit, duplicate concurrent application, foreign authenticated identity, anonymous
execution, and a graph that does not change.

The fixture executes actual service code and SQL on isolated localhost port 55322,
with two authenticated connections and independent privileged fixture/readback.
Concurrent proposals produce one apply and one conflict, revision advances once,
and history contains exactly one row. A history failure leaves the graph,
revision and proposal unchanged, then succeeds after the failing trigger is removed.
A lost acknowledgement returns an error; a retry sees the committed proposal and
returns conflict without applying again. This proves persisted-state safety, not
a success response to the retried request.

All 17 SQL cases pass. The combined service/route suite passes 34 cases in four
files; test TypeScript and targeted ESLint pass. The first added stale-graph
assertion compared JavaScript's undefined fields to stored JSON; its expectation
was corrected to compare the serialized graph, without changing runtime code.
Failure and passing logs are retained in private `assistant-apply-*.log`.
The existing CI database step already runs this file. Candidate CI is pending.

Limits: the small Supabase-shaped adapter runs real PostgreSQL statements but is
not PostgREST/HTTP transport. Lost acknowledgement is injected after the real
commit is observed by another connection. Provider proposal generation, message
history, hosted identity admission, real Storage and the broader method matrix
remain open. No whole checklist obligation is closed by these cases.
