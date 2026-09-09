# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 3/11 completed

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
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.5 — Guard de propriedade do canal
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.6 — Endpoint POST /videos (início do upload)
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

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
