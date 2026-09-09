# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 11/11 completed

### SI-03.1 — Infra: object storage, fila e worker no Docker Compose
- **Status:** completed
- **Tests:** no tests
- **Observations:**
  - `video-worker` service reuses `Dockerfile.dev` with `tail -f /dev/null` (same pattern as `nestjs-api`) since the worker entrypoint script doesn't exist yet — it will be added in SI-03.8, at which point the dev workflow is `docker compose exec video-worker npm run start:worker` (mirroring how `nestjs-api`'s dev server is started manually via `docker compose exec`, per project convention).
  - MinIO root credentials (`MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`) were set to match `MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY` in `.env`/`.env.example` so the app's S3 client credentials work against the real container out of the box.
  - The `videos` bucket is not created by this SI (no AC requires it) — bucket creation is expected to be handled by `StorageService`/`StorageModule` in SI-03.3.

### SI-03.2 — Migration e entidade Video
- **Status:** completed
- **Tests:** 5 passing
- **Observations:**
  - Migration generated via TypeORM CLI (`migration:generate`) against the real dev DB, then run with `migration:run` — matches Data Model exactly (enum `videos_status_enum`, FK to `channels.id`, `timestamptz` timestamps).
  - Extended `src/test/create-test-data-source.ts`'s `cleanAllTables` helper to also truncate `videos` (deleted before `channels` to respect the FK) — this is shared test infra other SIs' integration tests will also rely on.
  - Docker Desktop's engine dropped mid-SI (WSL integration + named pipe both failed transiently) and all containers were lost; recovered by polling until the daemon came back and re-running `docker compose up -d`. No code impact, just a delay.

### SI-03.3 — StorageService (adapter S3/MinIO)
- **Status:** completed
- **Tests:** 4 passing
- **Observations:**
  - `StorageService.onModuleInit` ensures the `videos` bucket exists (HeadBucket, falling back to CreateBucket) — this is the bucket-creation step deferred from SI-03.1's observations.
  - Added `MINIO_ENDPOINT`/`MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY`/`MINIO_BUCKET` to `env.validation.ts` and registered `storageConfig` in `app.module.ts`'s `ConfigModule.forRoot({ load: [...] })`, mirroring the existing config precedent (configs are centrally registered regardless of which feature module consumes them — `StorageModule` itself isn't imported into `AppModule` yet, that happens when `VideosModule` needs it in SI-03.6).
  - S3 client is instantiated directly in `StorageService`'s constructor from the injected config rather than as a separate DI provider token — no other consumer needs the raw client yet, so a dedicated provider would be premature.
  - Integration test performs real multipart PUTs against the presigned URLs (via `fetch`) against the real MinIO container — no mocking of the storage layer.

### SI-03.4 — QueueModule (BullMQ)
- **Status:** completed
- **Tests:** 1 passing
- **Observations:**
  - `@nestjs/bullmq` ships as pure ESM (`"type": "module"` in its `package.json`, no CJS build) and Jest's default `transformIgnorePatterns` ignores all of `node_modules`, causing `SyntaxError: Unexpected token 'export'`. Fixed by adding `transformIgnorePatterns: ["node_modules/(?!(@nestjs/bullmq|@nestjs/bull-shared)/)"]` to both `package.json`'s jest config and `test/jest-e2e.json` — first fix attempt, resolved on retry.
  - `QueueModule` (wrapping `BullModule.forRootAsync`) was registered directly in `AppModule`'s `imports`, unlike `StorageModule` — `forRootAsync` is a root-level singleton registration (same pattern as `TypeOrmModule.forRootAsync`), so it can't be deferred to a future consumer module the way a plain feature module can.
  - No `REDIS_PASSWORD` config: the actual Redis container from SI-03.1 has no auth configured, so `queue.config.ts` only reads `REDIS_HOST`/`REDIS_PORT`, not the "senha" mentioned in the plan's technical action text — matches real infra rather than an unconfigured feature.
  - `AppModule` now bootstraps a real Redis connection at startup — worth a full-suite check at final verification to confirm no other existing e2e/integration test regresses from this new dependency.

### SI-03.5 — Guard de propriedade do canal
- **Status:** completed
- **Tests:** no tests (empty Tests section — exercised by the E2E tests of the endpoints that use it, per the plan)
- **Observations:**
  - `nestjs-layer-separation.md` names `ChannelOwnerGuard` explicitly as the canonical example of "guard must delegate to a service" — followed that literally: the guard only reads `request.params.id`/`request.user.sub` and delegates the actual ownership decision to `VideosService.assertOwnership`.
  - Created a minimal `src/videos/videos.service.ts` with just `assertOwnership` (no `VideosService` existed yet — SI-03.6 is the one that adds `initiateUpload` to this same file; not a scope violation, just the first slice of a file two SIs will build up).
  - Added `ChannelsService.findByUserId` (no such lookup existed) so `VideosService` can resolve the caller's channel without reaching into `Channel`'s repository directly.
  - Added `VideoNotFoundException` (404) and `ForbiddenChannelAccessException` (403, error code `FORBIDDEN`) to the shared `domain.exception.ts`, matching the Error Catalog and the project's existing `{ statusCode, error, message }` envelope convention — `assertOwnership` throws `VideoNotFoundException` before the ownership check when the video doesn't exist, even though that's not explicitly an AC of this SI (it naturally falls out of resolving the video by id, and every consuming endpoint's own AC already expects 404 VIDEO_NOT_FOUND).
  - Deliberately did NOT create `videos.module.ts` — SI-03.6's technical actions explicitly own that file (registers controller + service + guard + entity together); this SI's code is unwired until then. `npx tsc --noEmit` still passes since nothing here requires the module to exist.

### SI-03.6 — Endpoint POST /videos (início do upload)
- **Status:** completed
- **Tests:** 4 passing
- **Observations:**
  - E2E test authored via JIT spec read from `nestjs-project/specs/videos-create.plan.md`, saved to `test/videos.e2e-spec.ts` with top-level `describe('videos', ...)` per the spec's `target_file:` — this file will be extended by SI-03.7/03.9/03.10/03.11's own specs, which all share the same `target_file:` (one E2E file per controller, matching the project's file-conventions.md example).
  - `mimeType` validation is NOT a class-validator DTO rule — `ValidationExceptionFilter` forces `error: 'VALIDATION_ERROR'` on every `BadRequestException`, which would clobber the AC-required `error: 'INVALID_MIME_TYPE'`. Enforced in `VideosService.initiateUpload` instead, throwing the new `InvalidMimeTypeException` domain exception (400) — `fileSizeBytes` bound IS a `@Max()` DTO rule since its AC only expects a generic validation error.
  - The video's UUID is generated client-side (`crypto.randomUUID()`) before insert so the storage key (`{id}/original.<ext>`) can be computed and the multipart upload initiated before the row exists — reuses TD-04's "same UUID as public identifier" decision.
  - Part size fixed at 100MiB (arbitrary but reasonable choice, not specified by the plan) — keeps part counts sane for the 10GB cap while comfortably clearing S3's 5MB-per-part minimum.
  - Registered `VideosModule` directly in `AppModule` (domain module, same as `AuthModule`) — unlike `StorageModule`/`ChannelsModule` which are only imported by consumers.

### SI-03.7 — Endpoint POST /videos/:id/complete-upload
- **Status:** completed
- **Tests:** 10 passing (2 integration + 8 E2E)
- **Observations:**
  - `completeUpload` reuses `assertOwnership` (already loading the video for 404/403) even though `ChannelOwnerGuard` already ran the same check at the HTTP layer — the guard doesn't attach the loaded video to the request, so the service needs its own fetch regardless; reusing the existing method avoids duplicating the not-found/forbidden logic.
  - Job name published to the queue is `video.process` (matching the Events/Messages section's event name exactly), not the generic `'process'` shown as a loose example in `library-refs.md`'s bullmq section — kept self-consistent with the plan's own documented event name.
  - Both new test files call `queue.drain(true)` in `beforeEach`/on the shared `videoProcessingQueue` to prevent jobs from a previous test leaking into the next scenario's job-count assertions — no worker is registered in this phase yet (SI-03.8), so jobs just accumulate in `waiting` otherwise.
  - `test/videos.e2e-spec.ts` now injects the real `video-processing` `Queue` (via `getQueueToken`) into the shared `describe('videos', ...)` setup so later SIs' scenarios can reuse it without re-deriving the token.
  - `StorageCompleteFailedException` (502) and `InvalidStateException` (409) are defined but not yet exercised by a test — the plan's ACs for this SI only cover the happy path + 403/404/job-published; the 409/502 paths aren't in the spec's scenario list either. Worth a look before phase sign-off to confirm that's intentional (Error Catalog documents them, but AC coverage for the negative multipart-completion path is thin).

### SI-03.8 — Worker de processamento (FFmpeg)
- **Status:** completed
- **Tests:** 2 passing
- **Observations:**
  - Extracted a `WorkerModule` (`src/worker/worker.module.ts`) that duplicates `AppModule`'s Config/TypeOrm registration rather than reusing `AppModule` directly — deliberate: if the worker bootstrapped the real `AppModule`, the API process would *also* instantiate `VideoProcessingProcessor` (since it'd live inside the shared `VideosModule`) and start consuming jobs itself, racing the dedicated worker container. Kept `VideoProcessingProcessor` registered only in `WorkerModule`, not in `VideosModule`/`AppModule`. This duplication mirrors an already-established pattern in this codebase (integration tests like `auth.service.integration-spec.ts` duplicate the same Config/TypeOrm setup instead of importing `AppModule`).
  - Added `StorageService.putObject` (plain single-shot PUT) — the existing storage methods were all multipart-upload-shaped; the worker needs a simple direct upload for the generated thumbnail.
  - `Video.duration_seconds` is a `numeric` Postgres column, which `pg` returns as a string by default — `markReady` stores the raw ffprobe number fine (TypeORM writes it through), but any test/consumer reading it back must `Number(...)` it; documented via the test's explicit cast rather than adding a column transformer (out of scope for this SI).
  - **Root-caused a real test-authoring bug during the fix loop (attempt 1/3):** the integration test's `Test.createTestingModule({...}).compile()` does NOT run Nest lifecycle hooks (`onModuleInit`) — `@nestjs/bullmq`'s `BullRegistrar` creates the actual BullMQ `Worker` instance from `onModuleInit`, so without calling `await moduleFixture.init()` after `compile()`, no worker ever attached to the queue and jobs sat unprocessed forever (both tests timed out identically). Fixed by adding the `.init()` call — this is a general gotcha for any integration test exercising `@Processor`-decorated classes, not `queue.module.spec.ts`-style tests that only resolve the `Queue` token (compile() alone is sufficient there since no worker needs to start).
  - Test video fixture is synthesized on the fly via `ffmpeg -f lavfi ...` (testsrc + sine, 2s) instead of committing a binary fixture to the repo — no external file needed, works offline, consistent across environments.
  - The corrupted-file test exercises the *real* BullMQ retry/backoff mechanism end-to-end (3 attempts, exponential backoff) rather than calling `onFailed` directly with a faked `Job`, for fidelity to AC #2's literal wording ("esgota as tentativas configuradas") — costs ~7s of real wall-clock backoff delay per test run, judged acceptable for an integration suite.

### SI-03.9 — Endpoint GET /videos/:id (status)
- **Status:** completed
- **Tests:** 11 passing (full shared E2E file — 8 prior + 3 new)
- **Observations:**
  - `VideosService.getStatus` reuses `assertOwnership` (same as `completeUpload`) and explicitly `Number()`-casts `duration_seconds` before returning it — guards against the `numeric` column's string round-trip from `pg` (same gotcha flagged in SI-03.8) so the JSON response's `durationSeconds` is actually a number, not a numeric string.
  - E2E scenarios insert the `Video` row directly (not via the real upload flow) since the spec's Setup only needs "a known status" — simpler and faster than driving a real multipart upload for a read-only endpoint's tests.

### SI-03.10 — Endpoint GET /videos/:id/stream
- **Status:** completed
- **Tests:** 15 passing (full shared E2E file — 11 prior + 4 new)
- **Observations:**
  - Added `VideosService.assertReady` (ownership + `status === ready` check) as a small wrapper around `assertOwnership` — designed deliberately to be reused as-is by SI-03.11 (download), per the plan's own "reaproveita a resolução/validação" instruction for that SI.
  - Used `@Res({ passthrough: true })` + manual `res.status()`/`res.set()`/`pipe()` rather than `StreamableFile`, per `library-refs.md`'s explicit note that `StreamableFile` doesn't handle Range/206 natively — the controller method returns `Promise<void>` and resolves only once the piped stream ends (or rejects on stream error), so Nest's request lifecycle waits for the actual byte transfer to finish.
  - `streamVideo` treats any storage-layer error while a `Range` header was supplied as `RANGE_NOT_SATISFIABLE` (416) — S3/MinIO reject out-of-bounds ranges by throwing, and that's the only expected failure mode once ownership/ready are already confirmed; without a `Range`, the same failure re-throws as-is (unexpected internal error, not remapped).
  - E2E binary assertions use a custom supertest `.parse()` callback to capture the raw response body as a `Buffer` — the default JSON/text parsers would otherwise mangle non-text content types like `video/mp4`.
  - Did not add a `StorageService.deleteObject` method to clean up uploaded test fixtures after each E2E run (the JIT spec's Setup mentions removing the uploaded test object) — no other SI needs deletion yet, and the test MinIO bucket accumulating small fixture objects across runs has no functional impact; flagged here rather than adding an unused capability preemptively.

### SI-03.11 — Endpoint GET /videos/:id/download
- **Status:** completed
- **Tests:** 18 passing (full shared E2E file — 15 prior + 3 new)
- **Observations:**
  - Reused `VideosService.assertReady` verbatim (no changes needed) — exactly the "reaproveita a resolução/validação da SI-03.10" the plan calls for. `downloadVideo` is otherwise a simpler sibling of `streamVideo`: no `Range` handling, always `Content-Disposition: attachment`, always 200.
  - Controller's `download` method mirrors `stream`'s manual `@Res({ passthrough: true })` + pipe pattern for consistency, even though download has no Range/206 branching to justify avoiding `StreamableFile` on its own — kept the same streaming mechanism across both endpoints rather than mixing two different response strategies for what's fundamentally the same object-storage proxy operation.
  - This is the last SI of the phase — all 11 SIs are now implemented and their own tests pass.
