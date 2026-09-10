---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-09-05T16:38:59.668880877-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-09-05T16:38:27.825735028-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-05T16:37:27.789013690-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-09-05T12:57:32.520811506-03:00"
  docs/project-plan.md: "2026-09-05T12:57:32.528811038-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-09-05T12:57:32.524811273-03:00"
  docs/phases/phase-02-auth/context.md: "2026-09-05T12:57:32.524811273-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-09-05T12:57:32.524811273-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-09-05T12:57:32.360820876-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Implementar o upload assíncrono de vídeos até 10GB (via multipart presigned direto ao object storage), o pré-cadastro automático do vídeo como rascunho, o processamento automático em background (extração de duração/metadados + geração de thumbnail via FFmpeg, orquestrado por uma fila BullMQ/Redis com worker dedicado), a geração de URL única por vídeo, e a entrega via streaming (Range/206) e download — tudo restrito ao dono do canal nesta fase, antes de a Fase 04 introduzir visibilidade pública.

---

## Step Implementations

### SI-03.1 — Infra: object storage, fila e worker no Docker Compose

**Description:** Adiciona os três serviços novos de infraestrutura da Fase 03 (MinIO, Redis, worker de vídeo) ao `compose.yaml` do backend, sem os quais nenhuma capability desta fase pode ser exercitada.

**Technical actions:**

1. Adicionar serviço `minio` ao `nestjs-project/compose.yaml` (imagem `minio/minio`, portas 9000/9001, volume persistente, healthcheck) (per `phase-03-videos/TD-07`)
2. Adicionar serviço `redis` ao `compose.yaml` (imagem `redis:7-alpine`) (per `phase-03-videos/TD-01`)
3. Adicionar serviço `video-worker` ao `compose.yaml` (mesmo `Dockerfile.dev`/imagem do `nestjs-api`, comando de start do worker) (per `phase-03-videos/TD-03`)
4. Adicionar as novas variáveis a `.env.example` (`MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `MINIO_BUCKET`, `REDIS_HOST`, `REDIS_PORT`) — sempre referenciando o serviço do Compose pelo nome, nunca `localhost`

**Tests:** _(empty — Infra)_

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` sobe `minio`, `redis` e `video-worker` sem erros, todos com status `running`
- MinIO aceita conexões em `http://minio:9000` de dentro da rede do Compose
- Redis aceita conexões em `redis:6379` de dentro da rede do Compose

---

### SI-03.2 — Migration e entidade Video

**Description:** Cria a tabela `videos` e a entidade TypeORM correspondente, ligada ao `Channel` por FK, seguindo o Data Model desta fase.

**Technical actions:**

1. Criar migration `<timestamp>-CreateVideos.ts` com todas as colunas do Data Model (`id`, `channel_id`, `status`, `original_storage_key`, `thumbnail_storage_key`, `upload_id`, `duration_seconds`, `metadata`, `created_at`, `updated_at`) (per `phase-03-videos/TD-04`, `phase-03-videos/TD-06`, `phase-03-videos/TD-07`, `phase-03-videos/TD-02`, `phase-03-videos/TD-03`)
2. Criar `src/videos/entities/video.entity.ts` com `@Entity('videos')`, `@ManyToOne(() => Channel)` em `channel_id` (per `phase-03-videos/TD-08`)
3. Rodar `npm run migration:run` para validar a migration contra o banco real

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: constraints, defaults, enum de `status` | `video.entity.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- Migration `CreateVideos` cria a tabela `videos` com todas as colunas do Data Model
- Entidade `Video` persiste e recupera um registro com `status: draft`
- Inserção com `channel_id` inexistente viola a constraint de FK

---

### SI-03.3 — StorageService (adapter S3/MinIO)

**Description:** Encapsula o `@aws-sdk/client-s3` num serviço único, cobrindo multipart upload (init/URL por parte/complete) e leitura de objeto com suporte a `Range` — usado por todas as SIs de upload, processamento e streaming.

**Technical actions:**

1. Criar `src/storage/storage.config.ts` — `registerAs` factory com endpoint/credenciais/bucket do MinIO, `forcePathStyle: true` em dev (per `phase-01-configuracao-base/TD-03` convenção, `phase-03-videos/TD-07`)
2. Criar `src/storage/storage.service.ts` com `createMultipartUpload`, `getUploadPartUrl`, `completeMultipartUpload`, `getObjectStream(key, range?)` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-07`)
3. Criar `src/storage/storage.module.ts` exportando `StorageService`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration: MinIO real — cria multipart upload, gera presigned URL, completa upload, lê objeto com/sem Range | `storage.service.integration-spec.ts` |

**Dependencies:** SI-03.1 — MinIO precisa estar no ar

**Acceptance criteria:**

- `createMultipartUpload` retorna um `uploadId` válido no MinIO real
- `getUploadPartUrl` gera uma URL que aceita um `PUT` de bytes reais
- `completeMultipartUpload` finaliza o objeto, que fica recuperável via `getObjectStream`
- `getObjectStream` com `range` retorna apenas os bytes solicitados

---

### SI-03.4 — QueueModule (BullMQ)

**Description:** Registra a conexão Redis e a fila `video-processing` via `@nestjs/bullmq`, base para o producer (SI-03.7) e o consumer (SI-03.8).

**Technical actions:**

1. Criar `src/queue/queue.config.ts` — `registerAs` factory com host/port/senha do Redis (per `phase-03-videos/TD-01`)
2. Criar `src/queue/queue.module.ts` com `BullModule.forRootAsync` (injeta `queue.config.ts`) + `BullModule.registerQueue({ name: 'video-processing' })` (per `phase-03-videos/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `QueueModule` | Unit: compilation test | `queue.module.spec.ts` |

**Dependencies:** SI-03.1 — Redis precisa estar no ar

**Acceptance criteria:**

- `QueueModule` compila e resolve a fila `video-processing` via injeção de dependência

---

### SI-03.5 — Guard de propriedade do canal

**Description:** Implementa a política de acesso decidida — só o dono do canal do vídeo pode acessar qualquer endpoint de vídeo nesta fase, independentemente do status.

**Technical actions:**

1. Criar `src/videos/guards/channel-owner.guard.ts` — resolve o `Video` pelo `:id` da rota, compara `video.channel_id` com o canal do `request.user` autenticado, rejeita com `403 FORBIDDEN` em caso de divergência (per `phase-03-videos/TD-08`)

**Tests:** _(empty — comportamento exercitado pelos testes E2E dos endpoints que o utilizam)_

**Dependencies:** SI-03.2 — precisa da entidade `Video`

**Acceptance criteria:**

- Requisição de um usuário autenticado que não é dono do canal do vídeo retorna `403 FORBIDDEN`
- Requisição do dono do canal passa pelo guard normalmente

---

### SI-03.6 — Endpoint POST /videos (início do upload)

**Description:** Cria o vídeo como rascunho e inicia o multipart upload presignado, entregando ao cliente as URLs de parte para envio direto ao storage.

**Route:** POST /videos
**Test Specs:** see `nestjs-project/specs/videos-create.plan.md`
**Authorization:** Owner (dono do canal autenticado)

**Technical actions:**

1. Criar `src/videos/dto/create-video.dto.ts` — `fileName` (string), `fileSizeBytes` (number, `<= 10737418240`), `mimeType` (string, deve começar com `video/`), validado via `class-validator` (per `phase-02-auth/TD-06` convenção, `phase-03-videos/TD-02`)
2. Criar `src/videos/videos.service.ts` com o método `initiateUpload` — cria `Video` com `status: draft`, chama `StorageService.createMultipartUpload`, calcula partes e gera as presigned URLs (per `phase-03-videos/TD-02`, `phase-03-videos/TD-04`, `phase-03-videos/TD-07`)
3. Criar `src/videos/videos.controller.ts` com `POST /videos` (per `### API Contracts`)
4. Criar `src/videos/videos.module.ts` — registra controller, service, guard e entidade

**Tests:** _(empty — E2E authored externally via /plan-test-specs per **Test Specs:** above; controllers/DTOs não recebem unit tests per testing-guide-nestjs-project)_

**Dependencies:** SI-03.2 + SI-03.3 — precisa da entidade `Video` e do `StorageService`

**Acceptance criteria:**

- `POST /videos` com payload válido retorna `201` com `id`, `uploadId`, `partSize` e `parts`
- `POST /videos` com `fileSizeBytes` acima de 10GB retorna `400` com erro de validação
- `POST /videos` com `mimeType` que não começa com `video/` retorna `400 INVALID_MIME_TYPE`
- Vídeo criado fica com `status: draft` no banco

---

### SI-03.7 — Endpoint POST /videos/:id/complete-upload

**Description:** Finaliza o multipart upload no storage e enfileira o job de processamento automático do vídeo.

**Route:** POST /videos/:id/complete-upload
**Test Specs:** see `nestjs-project/specs/videos-complete-upload.plan.md`
**Authorization:** Owner (dono do canal autenticado)

**Technical actions:**

1. Criar `src/videos/dto/complete-upload.dto.ts` — `parts: { partNumber: number, eTag: string }[]` (per `phase-03-videos/TD-02`)
2. Adicionar método `completeUpload` em `videos.service.ts` — chama `StorageService.completeMultipartUpload`, atualiza `status` para `processing` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-06`)
3. Adicionar rota `POST /videos/:id/complete-upload` protegida por `ChannelOwnerGuard` (per `### API Contracts`)
4. Injetar `@InjectQueue('video-processing')` no service e publicar o job `video.process` com `{ videoId }` (per `phase-03-videos/TD-01`, `### Events/Messages`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Integration: transição de status `uploaded → processing`, job publicado na fila real | `videos.service.integration-spec.ts` |

**Dependencies:** SI-03.4 + SI-03.5 + SI-03.6 — precisa da fila, do guard e do endpoint de início

**Acceptance criteria:**

- `POST /videos/:id/complete-upload` do dono com partes válidas retorna `202` com `status: "processing"`
- `POST /videos/:id/complete-upload` de não-dono retorna `403 FORBIDDEN`
- `POST /videos/:id/complete-upload` de vídeo inexistente retorna `404 VIDEO_NOT_FOUND`
- Job `video.process` é publicado na fila `video-processing` com `{ videoId }`

---

### SI-03.8 — Worker de processamento (FFmpeg)

**Description:** Consome o job `video.process`, extrai duração/metadados via `ffprobe` e gera o thumbnail via `screenshots()`, deixando o vídeo `ready` ou `error`.

**Technical actions:**

1. Criar o entrypoint do worker (processo/container separado, reaproveitando `QueueModule` e `StorageModule`) (per `phase-03-videos/TD-03`)
2. Criar `src/videos/video-processing.processor.ts` — `@Processor('video-processing')` estendendo `WorkerHost`: baixa o objeto original via `StorageService`, roda `ffmpeg.ffprobe` (duração/metadados) e `.screenshots({ timestamps: ['50%'] })` (thumbnail), sobe o thumbnail via `StorageService`, atualiza o `Video` para `status: ready` com `duration_seconds`/`metadata`/`thumbnail_storage_key` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-06`, `phase-03-videos/TD-07`)
3. Tratar o evento `failed` do worker (disparado só após esgotar as `attempts` configuradas) atualizando `Video.status` para `error` (per `phase-03-videos/TD-06`)
4. Configurar o Dockerfile do worker com os binários `ffmpeg`/`ffprobe` instalados (per `phase-03-videos/TD-03`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingProcessor` | Integration: MinIO real + FFmpeg real — processa um vídeo de teste e valida duração/thumbnail/status | `video-processing.processor.integration-spec.ts` |

**Dependencies:** SI-03.3 + SI-03.4 + SI-03.7 — precisa do storage, da fila e do producer publicando jobs

**Acceptance criteria:**

- Um job `video.process` processado com sucesso deixa o vídeo com `status: ready`, `duration_seconds` preenchido e `thumbnail_storage_key` apontando para um objeto existente no bucket
- Um job cujo arquivo de origem está corrompido esgota as tentativas configuradas e deixa o vídeo com `status: error`
- O thumbnail gerado é uma imagem válida recuperável do bucket `videos`

---

### SI-03.9 — Endpoint GET /videos/:id (status)

**Description:** Expõe o status atual do vídeo (rascunho/processando/pronto/erro) para o dono do canal acompanhar o processamento.

**Route:** GET /videos/:id
**Test Specs:** see `nestjs-project/specs/videos-status.plan.md`
**Authorization:** Owner (dono do canal autenticado)

**Technical actions:**

1. Adicionar rota `GET /videos/:id` no controller, protegida por `ChannelOwnerGuard`, retornando `id`, `status`, `durationSeconds`, `createdAt` (per `### API Contracts`)

**Tests:** _(empty — E2E authored externally via /plan-test-specs per **Test Specs:** above)_

**Dependencies:** SI-03.2 + SI-03.5 — precisa da entidade `Video` e do guard

**Acceptance criteria:**

- `GET /videos/:id` do dono retorna `200` com o `status` atual do vídeo
- `GET /videos/:id` de não-dono retorna `403 FORBIDDEN`
- `GET /videos/:id` de vídeo inexistente retorna `404 VIDEO_NOT_FOUND`

---

### SI-03.10 — Endpoint GET /videos/:id/stream

**Description:** Reproduz o vídeo via streaming, repassando o header `Range` do cliente ao storage e respondendo `206 Partial Content` quando aplicável.

**Route:** GET /videos/:id/stream
**Test Specs:** see `nestjs-project/specs/videos-stream.plan.md`
**Authorization:** Owner (dono do canal autenticado)

**Technical actions:**

1. Adicionar método em `videos.service.ts` que resolve o `Video`, valida `status: ready` (per `phase-03-videos/TD-05`)
2. Adicionar rota `GET /videos/:id/stream` — lê o header `Range`, chama `StorageService.getObjectStream(key, range)`, responde via `@Res({ passthrough: true })` com `200`/`206` e `Content-Range`/`Accept-Ranges` (per `phase-03-videos/TD-05`, `### API Contracts`)

**Tests:** _(empty — E2E authored externally via /plan-test-specs per **Test Specs:** above)_

**Dependencies:** SI-03.3 + SI-03.5 + SI-03.8 — precisa do storage, do guard e do vídeo poder chegar a `ready`

**Acceptance criteria:**

- `GET /videos/:id/stream` sem `Range` retorna `200` com o vídeo completo
- `GET /videos/:id/stream` com `Range: bytes=0-99` retorna `206` com `Content-Range` correto
- Requisição de vídeo com `status` diferente de `ready` retorna `409 VIDEO_NOT_READY`
- Requisição de não-dono retorna `403 FORBIDDEN`

---

### SI-03.11 — Endpoint GET /videos/:id/download

**Description:** Permite o download completo do vídeo pelo dono do canal.

**Route:** GET /videos/:id/download
**Test Specs:** see `nestjs-project/specs/videos-download.plan.md`
**Authorization:** Owner (dono do canal autenticado)

**Technical actions:**

1. Adicionar rota `GET /videos/:id/download` — reaproveita o método de resolução/validação da SI-03.10, chama `StorageService.getObjectStream(key)` sem `Range`, responde com `Content-Disposition: attachment` (per `phase-03-videos/TD-05`, `### API Contracts`)

**Tests:** _(empty — E2E authored externally via /plan-test-specs per **Test Specs:** above)_

**Dependencies:** SI-03.10 — reaproveita a resolução/validação do vídeo

**Acceptance criteria:**

- `GET /videos/:id/download` retorna `200` com header `Content-Disposition: attachment`
- Requisição de vídeo com `status` diferente de `ready` retorna `409 VIDEO_NOT_READY`
- Requisição de não-dono retorna `403 FORBIDDEN`

---

## Technical Specifications

### Data Model

#### Video

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated (`uuid_generate_v4()`) — reused as the public URL identifier *(per phase-03-videos/TD-04)* |
| channel_id | uuid | FK → `Channel`, not null — owner reference required by the access policy *(per phase-03-videos/TD-08)* |
| status | enum(`draft`, `uploaded`, `processing`, `ready`, `error`) | not null, default `draft` *(per phase-03-videos/TD-06)* |
| original_storage_key | varchar | not null — object key `{videoId}/original.<ext>` in the `videos` bucket *(per phase-03-videos/TD-07)* |
| thumbnail_storage_key | varchar | nullable — object key `{videoId}/thumbnail.jpg`, populated after processing *(per phase-03-videos/TD-07, phase-03-videos/TD-03)* |
| upload_id | varchar | nullable — storage multipart `UploadId`, needed to complete/abort the multipart upload *(per phase-03-videos/TD-02)* |
| duration_seconds | numeric | nullable — populated by `ffprobe` after processing *(per phase-03-videos/TD-03)* |
| metadata | jsonb | nullable — raw `ffprobe` format/stream metadata *(per phase-03-videos/TD-03)* |
| created_at | timestamptz | default `now()` |
| updated_at | timestamptz | default `now()`, updated on write |

**Relations:** `Video` belongs to `Channel` (many-to-one) — the ownership check in every endpoint resolves the requester's channel against this FK *(per phase-03-videos/TD-08)*.
**Indexes:** FK index on `channel_id` (owner-scoped lookups, per phase-03-videos/TD-08).

### API Contracts

#### POST /videos (SI-03.6)

**Request headers:**
- Content-Type: application/json

**Request body:**
- fileName: string, required
- fileSizeBytes: number, required — must be `> 0` and `<= 10737418240` (10GB) *(per phase-03-videos/TD-02, capability "Upload de vídeos... até 10GB")*
- mimeType: string, required — must start with `video/`

**Response 201:**
- id: string (uuid)
- uploadId: string — storage multipart upload id *(per phase-03-videos/TD-02)*
- partSize: number — bytes per part
- parts: array of `{ partNumber: number, url: string }` — one presigned `UploadPart` URL per part *(per phase-03-videos/TD-02, phase-03-videos/TD-07)*

**Error responses:**
- 400 validation error: `fileSizeBytes` missing, `<= 0`, or exceeds the 10GB limit
- 400 INVALID_MIME_TYPE: `mimeType` does not start with `video/`

---

#### POST /videos/:id/complete-upload (SI-03.7)

**Request body:**
- parts: array of `{ partNumber: number, eTag: string }`, required — one entry per uploaded part *(per phase-03-videos/TD-02)*

**Response 202:**
- id: string (uuid)
- status: `"processing"`

**Error responses:**
- 404 VIDEO_NOT_FOUND: video does not exist or does not belong to the requester
- 403 FORBIDDEN: requester is not the owning channel *(per phase-03-videos/TD-08)*
- 409 INVALID_STATE: video is not in `draft`/`uploaded` state when this is called
- 502 STORAGE_COMPLETE_FAILED: storage rejected `CompleteMultipartUpload` (e.g., part ETags mismatch) *(per phase-03-videos/TD-02)*

---

#### GET /videos/:id (SI-03.9)

**Response 200:**
- id: string (uuid)
- status: enum(`draft`, `uploaded`, `processing`, `ready`, `error`) *(per phase-03-videos/TD-06)*
- durationSeconds: number, nullable *(per phase-03-videos/TD-03)*
- createdAt: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 403 FORBIDDEN *(per phase-03-videos/TD-08)*

---

#### GET /videos/:id/stream (SI-03.10)

**Request headers:**
- Range: string, optional — `bytes=start-end` *(per phase-03-videos/TD-05)*

**Response 200 or 206:** raw video bytes proxied from the object storage, with `Content-Range`/`Accept-Ranges` headers when `Range` is present *(per phase-03-videos/TD-05)*.

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 403 FORBIDDEN *(per phase-03-videos/TD-08)*
- 409 VIDEO_NOT_READY: `status` is not `ready`
- 416 RANGE_NOT_SATISFIABLE: `Range` header outside the object's byte length

---

#### GET /videos/:id/download (SI-03.10)

**Response 200:** raw video bytes proxied from the object storage with `Content-Disposition: attachment` *(per phase-03-videos/TD-05)*.

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 403 FORBIDDEN *(per phase-03-videos/TD-08)*
- 409 VIDEO_NOT_READY: `status` is not `ready`

---

### Authorization Matrix

| Endpoint | Anonymous | Authenticated (non-owner) | Owner |
|----------|-----------|---------------------------|-------|
| POST /videos | ✗ | ✗ | ✓ |
| POST /videos/:id/complete-upload | ✗ | ✗ | ✓ |
| GET /videos/:id | ✗ | ✗ | ✓ |
| GET /videos/:id/stream | ✗ | ✗ | ✓ |
| GET /videos/:id/download | ✗ | ✗ | ✓ |

_(Every endpoint is owner-only in this phase — per phase-03-videos/TD-08, no video is visible to anyone but the owning channel until Fase 04 introduces public/unlisted visibility.)_

### Error Catalog

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_NOT_FOUND | 404 | Vídeo não existe ou não pertence ao canal do requisitante |
| FORBIDDEN | 403 | Requisitante autenticado não é o dono do canal do vídeo *(per phase-03-videos/TD-08)* |
| INVALID_MIME_TYPE | 400 | `mimeType` do upload não começa com `video/` |
| INVALID_STATE | 409 | `complete-upload` chamado com o vídeo fora de `draft`/`uploaded` |
| STORAGE_COMPLETE_FAILED | 502 | Storage rejeitou `CompleteMultipartUpload` (ETags de partes inconsistentes) *(per phase-03-videos/TD-02)* |
| VIDEO_NOT_READY | 409 | Streaming/download solicitado com `status` diferente de `ready` |
| RANGE_NOT_SATISFIABLE | 416 | Header `Range` fora do tamanho do objeto |

_(Formato do envelope de erro — `{ statusCode, error, message }` — já estabelecido em phase-02-auth/TD-07, herdado sem mudanças.)_

### Events/Messages

#### video.process

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideosService`, ao final de `POST /videos/:id/complete-upload` (per phase-03-videos/TD-01, phase-03-videos/TD-02)
**Consumer:** `VideoProcessingWorker` (processo/container separado) (per phase-03-videos/TD-03)
**Trigger:** multipart upload confirmado com sucesso no storage — vídeo passa de `uploaded` para `processing`
**Delivery semantics:** at-least-once, com `attempts` + backoff exponencial nativos do BullMQ; `status: error` só é marcado depois de esgotadas todas as tentativas configuradas (per phase-03-videos/TD-01, phase-03-videos/TD-06)

---

<!-- phase-a-complete -->

## Dependency Map

```
SI-03.1 (root — infra Docker: MinIO, Redis, worker)
├── SI-03.3 — depende de SI-03.1 (MinIO precisa estar no ar)
│   └── SI-03.6 — depende de SI-03.2 + SI-03.3
│       └── SI-03.7 — depende de SI-03.4 + SI-03.5 + SI-03.6
│           └── SI-03.8 — depende de SI-03.3 + SI-03.4 + SI-03.7
│               └── SI-03.10 — depende de SI-03.3 + SI-03.5 + SI-03.8
│                   └── SI-03.11 — depende de SI-03.10
└── SI-03.4 — depende de SI-03.1 (Redis precisa estar no ar)

SI-03.2 (root — migration + entidade Video)
├── SI-03.5 — depende de SI-03.2
│   ├── SI-03.9 — depende de SI-03.2 + SI-03.5
│   └── (SI-03.6, SI-03.7, SI-03.10, SI-03.11 também dependem de SI-03.5 — ver árvore acima)
└── (SI-03.6 também depende de SI-03.2 — ver árvore acima)
```

---

## Deliverables

- [ ] SI-03.1 — Infra: object storage, fila e worker no Docker Compose
- [ ] SI-03.2 — Migration e entidade Video
- [ ] SI-03.3 — StorageService (adapter S3/MinIO)
- [ ] SI-03.4 — QueueModule (BullMQ)
- [ ] SI-03.5 — Guard de propriedade do canal
- [ ] SI-03.6 — Endpoint POST /videos (início do upload)
- [ ] SI-03.7 — Endpoint POST /videos/:id/complete-upload
- [ ] SI-03.8 — Worker de processamento (FFmpeg)
- [ ] SI-03.9 — Endpoint GET /videos/:id (status)
- [ ] SI-03.10 — Endpoint GET /videos/:id/stream
- [ ] SI-03.11 — Endpoint GET /videos/:id/download

**Full test suites:**

- [ ] Backend tests pass (`cd nestjs-project && docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`cd nestjs-project && docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`cd nestjs-project && docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`cd nestjs-project && docker compose exec nestjs-api npm run lint`)
