# Section 6H — staging cleanup completion and source cancellation

Status: locally verified; PR/CI/release pending.

## Reproduced behavior

Three filesystem lifecycle regressions failed against the original staging
helper before implementation:

- `cleanup()` set its completed flag before deletion succeeded. Removing write
  permission from an isolated temporary parent causes real EACCES/EPERM. After
  restoring permission, retry resolved successfully while leaving the directory.
- A concurrent second cleanup returned while the first deletion was pending;
  the supposedly cleaned file was still readable.
- The remote source was already open when temporary-directory allocation failed,
  but its body was not cancelled because allocation was outside the pipeline's
  error handling.

The standalone permission probe independently reproduced false-success cleanup,
then passed after the fix. Its isolated parent is restored and removed in finally.
Six permanent tests cover those three cases, normal cleanup isolation/idempotency,
partial download failure, and preservation of the allocation error when source
cancellation itself fails. Permission cases require an unprivileged POSIX user;
they run on the local Mac and Ubuntu CI, and explicitly skip on root/Windows.

## Fix and verification

Cleanup now shares one pending deletion promise. Every caller waits for completion;
a successful deletion stays idempotent, while a rejected promise is cleared so
the same owner can retry. The helper cancels the opened source body if temporary
directory creation fails, retaining the original allocation error.

All 102 focused staging/generation/preview cases pass, as do 25 real-database
output/crash recovery cases (the child-only entry test is intentionally skipped
in the parent run), app/test typing and targeted lint. A real isolated HTTP
server streaming a body observes its connection close after the fixed helper
fails directory allocation and cancels the source. Filesystem and stream behavior
are real; the remote-host validation boundary is replaced only for the local
probe. No production provider or customer data is involved.

This changes no route shape, mobile contract or SQL. No migration, mobile runtime
change or OTA is required. Generation callbacks and imports retain their existing
retry/settlement behavior. The helper makes an explicit cleanup retry truthful;
it does not create a background retry job or promise eventual deletion after a
persistent filesystem failure.

## Separate crash-retention finding remains open

A network-disabled Node 24 container with a 2 MiB tmpfs reproduced disk exhaustion:
three workers each staged 600 KiB and were killed with SIGKILL; the next staging
attempt failed ENOSPC, with 1,843,200 bytes retained. The failed attempt's own
partial directory was removed. This uses the actual bundled staging helper and
small synthetic media bytes, not a mocked filesystem or a large host allocation.
Container removal destroys the fixture filesystem.

This proves accumulation if temporary storage survives worker replacement. It
is not evidence of a production disk incident or Vercel's behavior after a killed
process. Vercel documents [instance reuse and concurrent execution](https://vercel.com/docs/functions)
and [500 MB writable temporary storage](https://vercel.com/docs/functions/runtimes),
but these statements do not specify retention after every termination mode.

No cross-worker stale-file sweep is added. The current `remote-media-*` directory
has no durable owner record, and a Node parent can die while a spawned preview
reader is still alive. An age cutoff or parent-PID check alone does not establish
that deletion is safe. PID reuse, active readers, concurrent invocations and
foreign temporary directories must be handled before automating deletion.

The staging helper has two call sites in generation-services.ts (single and
multiple output persistence). Callers await preview and settlement inside the
staged lifetime. Image preview reads the file via sharp; video preview spawns
ffmpeg, whose 30-second kill timer is owned by the parent Node process. That timer
cannot by itself prove the child is dead after the parent is killed. Additional
poster/rendition temporary namespaces are outside this narrow fix.

The crash-retention/disk-budget obligation remains open. Next: establish safe
staging ownership and reader lifetime across process replacement, including a
surviving preview child, before implementing reclamation. Genuine provider,
remote object-store and push delivery remain separate audit boundaries.

Private evidence: `.audit-evidence/backend-section-06h/`. Initial attempts with
an exactly fitting 512 KiB fixture and an ineffective filesystem mock are saved
as harness errors, not defect evidence. The corrected before-fix tests use real
filesystem permissions and reproduced three failures. Existing local evidence
and unrelated checkout changes are preserved.
