---
libs:
  "bullmq":
    version: "^5.x"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-09-05T19:37:58Z"
  "@nestjs/bullmq":
    version: "^11.x"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-09-05T19:37:58Z"
  "ioredis":
    version: "^5.4.x"
    context7_id: "/redis/ioredis"
    fetched_at: "2026-09-05T19:37:58Z"
  "@aws-sdk/client-s3":
    version: "^3.x"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-09-05T19:37:58Z"
  "@aws-sdk/s3-request-presigner":
    version: "^3.x"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-09-05T19:37:58Z"
  "fluent-ffmpeg":
    version: "^2.1.x"
    context7_id: "/fluent-ffmpeg/node-fluent-ffmpeg"
    fetched_at: "2026-09-05T19:37:58Z"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-05T16:37:27.789013690-03:00"
---

# Library References — Fase 03 (Vídeos)

## bullmq

Fila e worker sobre Redis (TD-01, TD-03, TD-06). API central: `Queue` (produtor) e `Worker`/`WorkerHost` (consumidor), rodando em processos separados.

- **Retry/backoff nativo** (usado pela TD-06 para o ciclo de status): `queue.add(name, data, { attempts: 3, backoff: { type: 'exponential', delay: 1000 } })`. O evento `failed` do worker só dispara depois de esgotadas todas as `attempts` — é o gancho para transicionar o vídeo para `status: error` sem marcar erro prematuramente numa falha transitória.
- Delays calculados: `exponential` com `delay: 1000` produz 1s, 2s, 4s entre tentativas (3 attempts). Ajustável por job.
- Jobs também suportam `priority`, `delay`, `removeOnComplete`/`removeOnFail` para limpeza da fila.

## @nestjs/bullmq

Integração oficial do NestJS com BullMQ (TD-01, TD-03) — usada tanto na API (producer) quanto no worker (consumer), possivelmente como dois entrypoints da mesma base de código.

- **Módulo raiz** (conexão Redis, geralmente na API): 
  ```ts
  BullModule.forRootAsync({
    imports: [ConfigModule],
    inject: [ConfigService],
    useFactory: (config: ConfigService) => ({
      connection: { host: config.get('REDIS_HOST'), port: config.get('REDIS_PORT') },
    }),
  })
  ```
- **Registro de fila**: `BullModule.registerQueue({ name: 'video-processing' })`.
- **Producer** (na API, ao final do upload): `@InjectQueue('video-processing') private queue: Queue` + `queue.add('process', { videoId })`.
- **Consumer** (no worker, processo/container separado — atende à TD-03): classe decorada com `@Processor('video-processing')` estendendo `WorkerHost`, implementando `async process(job: Job)`. Hooks de ciclo de vida via `@OnWorkerEvent('failed' | 'completed' | ...)`.
- `RegisterQueueOptions` omite `connection` — a conexão é sempre herdada do `forRootAsync`/`forRoot` raiz, nunca duplicada por fila.

## ioredis

Cliente Redis usado internamente pelo BullMQ para a conexão (TD-01). Normalmente não é instanciado diretamente pelo código da aplicação — a config de `connection` do `BullModule.forRootAsync` já usa o formato de opções do ioredis (`host`, `port`, `password`, TLS, etc.), então o pacote entra como dependência transitiva explícita (BullMQ exige `ioredis` como peer dependency).

## @aws-sdk/client-s3

SDK oficial da AWS v3 para o object storage (TD-02, TD-05, TD-07) — usado tanto pela API (criar/gerenciar multipart upload, servir streaming/download) quanto para configurar o endpoint do MinIO local.

- **Endpoint customizado para MinIO** (dev): `new S3Client({ endpoint: 'http://<minio-service>:9000', forcePathStyle: true, region: 'us-east-1', credentials: {...} })`. Em produção, remove-se `endpoint`/`forcePathStyle` e aponta para a região AWS real — mesmo código (confirma a decisão da TD-07).
- **Multipart upload** (TD-02, Option B decidida): sequência `CreateMultipartUploadCommand({ Bucket, Key })` → uma `UploadPartCommand({ Bucket, Key, UploadId, PartNumber })` presignada por parte (ver `s3-request-presigner` abaixo) → `CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts: [{ ETag, PartNumber }, ...] } })` quando a API é avisada que todas as partes terminaram. A resposta do `CompleteMultipartUpload` inclui `ETag`/`Location` do objeto final — serve como confirmação de que o storage validou as partes.
- **Streaming/download** (TD-05, Option A decidida): `GetObjectCommand({ Bucket, Key, Range: 'bytes=start-end' })` repassando o header `Range` do cliente; o corpo retornado (`Body`) é um stream que a API repassa via `@Res({ passthrough: true })` do NestJS, com status `206` e `Content-Range`/`Accept-Ranges` — como `StreamableFile` não lida nativamente com Range/206.

## @aws-sdk/s3-request-presigner

Geração de URLs pré-assinadas (TD-02 para upload por partes, TD-07 documenta o padrão geral).

- **Padrão canônico** (confirma a decisão da TD-07): `import { getSignedUrl } from '@aws-sdk/s3-request-presigner'; const url = await getSignedUrl(client, command, { expiresIn: 3600 })` — funciona com qualquer `Command` do `@aws-sdk/client-s3` (inclusive `UploadPartCommand` e `GetObjectCommand`), `expiresIn` em segundos (default 900s se omitido).
- Alternativa de baixo nível via `S3RequestPresigner` (spread da config do client) existe mas não é necessária — `getSignedUrl` cobre o caso de uso das TDs.

## fluent-ffmpeg

Wrapper declarativo do FFmpeg/ffprobe (TD-03) — roda no worker (container separado, atende à TD-03), nunca na API.

- **Extração de metadados/duração** (`Processamento automático do vídeo após upload`): `ffmpeg.ffprobe(filePath, (err, metadata) => { ... })` ou `ffmpeg(filePath).ffprobe((err, data) => { console.dir(data.streams); console.dir(data.format); })` — `data.format.duration` dá a duração em segundos.
- **Geração de thumbnail** (`Geração automática de thumbnail a partir de um frame`): método `.screenshots({ timestamps: ['50%'], filename: 'thumbnail.jpg', folder: '/tmp/...', size: '320x240' })` (alias `.thumbnail()`/`.thumbnails()`). Evento `'end'` sinaliza conclusão; evento `'filenames'` retorna os nomes gerados.
- Limitação documentada: `screenshots()` não funciona em streams de entrada e não interage bem com filtros de tamanho — usar a opção `size` do próprio método, não `.size()`.
- Requer os binários `ffmpeg`/`ffprobe` instalados na imagem do worker (pacote do SO, independente da lib npm).
