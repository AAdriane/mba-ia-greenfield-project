# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 6/11 completed

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
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.8 — Worker de processamento (FFmpeg)
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.9 — Endpoint GET /videos/:id (status)
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.10 — Endpoint GET /videos/:id/stream
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.11 — Endpoint GET /videos/:id/download
- **Status:** pending
- **Tests:** no tests
- **Observations:** none
