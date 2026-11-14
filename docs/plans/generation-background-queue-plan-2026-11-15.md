# Generation background queue: plan (2026-11-15)

Status: **PR 1 (server and web) built**; PR 2 (app wording, by OTA) not started. Two things changed while building, both in "As built" at the end. Owner asked on 2026-11-15: "add the background queue with a
Queued state … we need the most ideal solution for this task".

## Where we are

- #808: the provider gate holds starts to 18 per 12 s for the account, 12 for one model, 50 in
  flight (`src/lib/provider-admission.ts`, `admit_provider_submission`).
- #810: a creator's start over those limits waits its turn **inside its own request**, first
  come first served (`provider_submission_waiters`, `reserve_provider_submission`), for up to
  45 s, then is refused and refunded.

That is a wait, not a queue. A line longer than about 45 s of waiting still fails, the Generate
button just spins, and nothing shows the creator where they stand.

## What "ideal" means here

1. A start over the limits answers **at once** as Queued, with its credits held.
2. The **server** sends it when its turn comes, whether or not the app or page is still open.
3. Web and mobile show **Queued**, then Generating, then the result, on every surface that
   lists a run.
4. A start that cannot be sent within a set time is **refunded and the creator is told**.
5. Nothing a creator can do to a queued run (delete it, retry it, close the app) loses credits
   or starts it twice.
6. App versions already installed keep working without an update.

## Facts the design rests on (checked 2026-11-15)

- Every client follows a run by `predictionId`: the status routes look the row up with
  `.eq('prediction_id', id)` (`image|video|motion-generation-status-service.ts`), the web start
  throws on a response without one, the app's saved active run rejects an empty one, and
  `contracts/mobile-api-v1.json` pins it. A queued row has no provider task, so today it is a
  404 to every poll.
- Provider task ids are 32 hex characters or `veo_task_…`; a generation id is a dashed UUID.
  Nothing validates the `?id=` format, so the two cannot be confused and the route can tell
  them apart.
- Both clients already accept the status `waiting`. Today it only ever means "queued at Kie".
  Mobile shows "Queued with the model"; web shows "Waiting for provider".
- After the credit hold, the only step of a start that needs the provider task is attaching it
  (`markGenerationProviderStarted`). Everything else needs the generation id alone.
- The provider request carries signed links to the creator's inputs that last **one hour**, and
  for a private recipe it carries the prompt, which is deliberately not stored on the
  generation row.
- `after()` from `next/server` is the established way to work after the response; it runs for
  the route's `maxDuration`. `/api/generations` sets none today.
- A once-a-minute cron would break the cron budget and seven assertions
  (`backend-job-registry.test.ts`); the three existing crons run every 10 minutes.
- Deleting a `pending` generation today deletes the row **without refunding its hold**.
- There is no "could not start" notice; `notifyGenerationStatus` sends the generic failure with
  "Your N credits were returned."

## Design

### 1. The queued start

In `createKieTask`, a creator's start that the gate refuses for capacity is no longer held in
the request. It takes its ticket in the existing line and its **prepared provider request is
stored** in a new service-role-only table, `generation_queued_submissions`
(`generation_id` PK → `generations` on delete cascade, `user_id`, `model`, `endpoint`,
`request jsonb`, `queued_at`). The start then finishes everything that does not need the
provider task (input-media persistence, track copies) and answers:

```json
{ "success": true, "status": "waiting", "queued": true,
  "predictionId": "<the generation id>", "generationId": "<the generation id>", … }
```

`predictionId` is the generation id used as a **run handle**. Installed apps and the current
web keep working unchanged, because:

### 2. Following a queued run

The three status services accept a handle: an `id` that is a UUID is looked up by
`generations.id` (same ownership check). While the run is queued they answer
`{ status: "waiting", queued: true, queuePosition, retryAfterMs: 3000, … }`; once the provider
task is attached they answer exactly as for a poll by task id, through to the result. A client
never has to switch ids. `/api/generations/active` returns queued runs the same way.

### 3. Who sends it (no new cron)

Sending is one function, `drainQueuedSubmission(generationId)`: ask the line
(`reserve_provider_submission`), and when admitted **claim** the stored request with an atomic
`DELETE … RETURNING`, POST it to Kie and attach the task. The claim is what makes a double
send impossible: whoever deletes the row is the only one holding the request. The stored
request, private prompt included, exists only until it is claimed.

It is called from four places, fastest first:

1. **`after()` on the start request** (route `maxDuration = 300`): the same function keeps
   asking, as #810's loop does, for up to four minutes after it has answered. This covers
   almost every queued run, and its asks keep the ticket live, so the order among queued runs
   is strict.
2. **The creator's own status polls**: a poll that finds a queued run nobody is driving (no
   recent ask on its ticket) drives one attempt in its own `after()`.
3. **The Kie webhook**: a finished task frees a slot, so the handler tries the oldest
   undriven queued runs.
4. **The existing `generation-completions` cron** (every 10 min): the backstop for a run
   whose function died and whose creator left.

A queued run nobody is driving keeps its place by date: the line already orders such a caller
by `p_turn_since` (#810's run-step rule), here its `queued_at`.

### 4. Limits and expiry

- A queued run is sent within **10 minutes** or refunded (`settle_generation_start_failed`),
  the stored request deleted, and the creator notified ("could not start in time; your credits
  were returned"). Ten minutes is far inside the one-hour life of the signed input links, so
  no link has to be re-signed, and far inside the 45-minute reaper.
- The queue holds at most **200** runs, and **4** per creator. Past that a start is refused
  and refunded at once, as today.
- A claimed request that is never attached (the function died between the claim and the
  POST's answer) is left exactly as today's crashed start: pending, reserved, recovered by the
  provider callback or refunded by the reaper. It is never re-sent.

### 5. What a creator can do to a queued run

- **Delete it**: the delete claims the stored request first, refunds the hold, then deletes.
  If the refund cannot be made the creation is kept, for the reaper to settle. (A pending row
  that is not queued, a start that died, is still deleted unrefunded, as before.)
- **Retry with the same idempotency key** (the app's "Check again"): answers the queued run
  again, not a 409.
- **Close the app**: nothing changes; the server sends it and the completion push arrives as
  for any run.

### 6. What it shows

| Surface | Today | With the queue |
|---|---|---|
| Web creators | "Waiting for provider" | "Queued · N ahead of you", then the usual progress |
| Web Studio tiles (`/creations`) | "Processing" | "Queued" |
| App creator screen (installed versions) | "Queued with the model" | the same words, correct by accident |
| App creator screen (after an OTA) | – | "Queued · N ahead of you" |
| App profile and library | "Queued" only for `waiting` | "Queued" for a queued run |
| MCP `create_media` | `processing` | `queued` (`get_generation` goes on reporting the row's own `pending` until the run is sent) |

### 7. What stays and what goes

- Stays: the limits, the line's ordering, its SQL, the run-step turn, the breaker.
- Goes: the 45 s in-request wait and its deadline arithmetic (`waitBudgetMs`,
  `waitDeadlineMs`): the request no longer waits at all. The loop that asks again survives as
  the `after()` driver.
- Unchanged: template and workflow steps (their own 30-minute retry).

## Delivery

**PR 1: server and web** (one release; works with every installed app):
migration (`generation_queued_submissions`, claim and expiry functions, grants, pgTAP);
`src/lib/generation-submission-queue.ts`; `createKieTask` and the four start paths; unified
start and route (`after`, `maxDuration`); the three status services and
`creator-active-run-service`; `generation-delete-service`; webhook and completions-cron hooks;
MCP answers; web labels; contract fixtures for the queued start and the queued poll; unit,
database-concurrency and load tests; docs.

**PR 2: app wording** (JS only, by OTA, on the owner's word for that update): the creator
screen's "Queued · N ahead", profile and library chips, types.

Review: `max`-risk by the repo's rule (credits, a migration, route behaviour). One careful
fresh-context reviewer per PR, as the owner prefers, and a re-review after fixes.

Proof before merge: full migration replay and pgTAP; a database-backed test that two drivers
racing for one queued run send it once; the 80-start burst from #810 re-run to show all 80
are sent, none refused, in order.

## Decisions for the owner

1. **How long may a run stay queued before it is refunded?** Proposed: 10 minutes.
2. **App wording by OTA after PR 1 is live?** Installed apps work without it; the OTA only
   improves the words.

## Risks

- The stored request holds a private recipe's prompt for up to 10 minutes. The table is
  service-role only, the row is deleted the moment it is claimed or expires, and no API reads it.
- `after()` work ends when the function instance does. That is why polls, the webhook and the
  cron also drive the queue, and why a run keeps its place by date.
- More moving parts on the credit path than #810. The claim-by-delete and the existing
  settle functions keep every exit to "sent once" or "refunded once".

## As built (PR 1)

Two parts of the design above did not survive contact with the tests, and the code is what
this section says:

1. **The queue's rows are the line; nothing waits on a heartbeat.** The plan kept #810's
   tickets and had a queued run "keep its place by date" while nothing was asking for it. A
   concurrency test showed the gap: tickets only exist while something asks, so a queue nobody
   was serving was invisible to the gate, and a new start walked past it.
   `reserve_provider_submission` now counts the rows of `generation_queued_submissions` ahead
   of a caller, with a run's turn read from its own row. One model's queued runs count only
   for the places that model's share still has, so a single model's backlog cannot park other
   models behind it. New code takes no ticket at all; the ticket path stays in the function
   for the deployment before this one, which waits inside its requests.
2. **Every driver serves the head of the queue, not "its own" run.** With strict order in
   the gate, a run whose request died would have blocked everyone queued behind it until the
   cron came round. `driveQueuedSubmissions` makes passes over the oldest runs, oldest first,
   and stops at the first one the account has no place for. The start request keeps passing
   (every 2 s, for up to 4 minutes) until its own run has left the queue; a status check, the
   Kie callback and the cron each make one pass.

Also: the in-request wait loop is gone from `admitProviderSubmission`, which now asks once;
a queued run's start replays under its handle (`generation-start-idempotency.ts`); and a
timed-out ask of the gate queues the run instead of failing open.

Proof (scratch database, policy limits, tasks finishing 4 s after they are sent): 80 starts
at once across six models were all answered within 0.2 s, 18 sent at once and 62 queued, none
refused; the 62 were sent in exact queue order, 18 per 12 s window, the last after 50 s. On
one model: 12 at once, 68 queued, sent in order at 12 per window, the last after 75 s.

### What the review changed (2026-11-15)

Two fresh-context reviewers read the PR, one on the database and the credit path, one on the
request flow, the clients and the tests. Neither found a blocker in the SQL. What they found,
and what was done:

- **A refunded generation could be sent.** The reservation raises for a settled generation,
  and the gate failed open on any error, so a queue row left behind by a start that had
  refunded itself was claimed and posted. Now: whatever sends queued runs never fails open
  (`failOpen: false`, answered `unavailable`); the claim says whether the generation may still
  be sent (`sendable`), and a request that may not is dropped; a trigger deletes a queue row
  the moment its generation leaves `pending`; and a queueing whose answer was lost is asked
  again once instead of being refunded with its row possibly written.
- **A sent run was refunded when its task could not be attached.** The send and the attach
  shared one `try`. They are apart now: after the provider has accepted, nothing is refunded,
  and the callback attaches the task, as for a start that dies at that point.
- **Deleting a queued run could lose its credits** when the refund failed. The delete now
  keeps the creation.
- **A rollback would have held the gate shut.** Queue rows nothing drives counted ahead of
  every start until the reaper ended them. A row counts for 15 minutes at most now, and the
  deployment runbook has the two statements that end the queue by hand.
- **Load under a burst.** Every queued start's request asked the gate about the same head
  every two seconds. Within one server instance a pass that is running is joined and one
  straight after a full account is skipped; passes are spread; a pass reads 25 rows, asks
  once for a model whose share is full, and reaches another model's run behind it.
- **The route's time limit.** The four minutes are counted from when the request came in,
  and no send is begun after them.
- **False alerts.** Health counted a queued run as "pending without a provider task" after
  five minutes. It does not while the run is waiting its turn, and does again once it is
  overdue (20 minutes), which is a queue nothing is serving.
- **Ids.** A UUID that is no generation of the caller's is looked up as a provider task id,
  so a provider with UUID task ids would still be followed, and a failed lookup is a 500,
  not a "not found" that stops a poll.
- **Tests.** The `submission_pending` regression test deleted by mistake is back. Added: the
  three status routes followed by a handle from queued to sent; queueing on the video, motion
  and catalog starts; the callback serving the queue; the queued answer read by the web's
  status reader.

A third reviewer then read those fixes and found one more on the credit path, and four
smaller points, all answered:

- **A delete tried again lost the credits.** The first delete took the run out of the queue
  and, its refund failing, kept the creation; the second found nothing to claim and deleted
  it. A delete now also refunds a run that is out of the queue and still holds its credits
  with nothing on its way (pending, never admitted by the gate), and keeps it if it cannot.
- **A lost queueing answer could read as "queued" for a run nothing would send**, when the
  start's own reservation had gone through unseen. Asked again, the queue now says whether
  the run has its task (`onItsWay`); one that is only reserved is looked at once more two
  seconds on, and refused if it still has none.
- **A pass that hung held every caller in its instance.** A caller waits on a running pass
  no longer than its own time, and a pass running for 90 seconds is no longer joined.
- **The callback's pass could be skipped just after its task freed a place.** It now makes
  a pass of its own (`fresh`), after any that is running.
- **The runbook** said to end the queue before a rollback; that could refund a run being
  sent. It says straight after, now.

Known and left: 200 queued long videos cannot all start inside ten minutes when the 50
in-flight places are what they wait on, so the tail of such a burst waits, is refunded and is
told. `/creations` says "Queued" for every pending run, including the rare start that died
before it was sent, until the reaper ends it. A queueing whose answer is lost twice, with a
pass claiming the run in the same moment, can still refund a run that is being sent; so can
one that is still being posted two seconds after a lost answer.
