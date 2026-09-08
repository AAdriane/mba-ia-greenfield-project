---
scope_type: phase
related_phases: [3]
status: pending
date: 2026-09-05
scope_description: "Upload assíncrono de vídeos até 10GB, fila de processamento em background, worker FFmpeg, object storage e streaming/download"
---

# Technical Decisions — Fase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — recebe o novo módulo de vídeos, a migration da tabela `videos`, os novos serviços de infraestrutura (storage, fila, worker) no `compose.yaml`, e os endpoints de upload/streaming/download.
- `next-frontend/` — **fora de escopo nesta fase**. O enunciado do desafio restringe explicitamente a Fase 03 a "API, worker, infraestrutura e artefatos do processo"; a interface de vídeo (telas de upload, player) é tratada em fases futuras (04/05). Nenhum TD deste documento cobre o frontend.

---

## TD-01: Tecnologia de fila de processamento em background

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** `docs/diagrams/software-arch.mermaid` já define um container "Message Queue" no C4, mas deixa a tecnologia como `TBD` — é a única decisão de stack genuinamente aberta desta fase. A API precisa publicar um job de processamento ao final do upload; um worker separado precisa consumi-lo, com retry em caso de falha (extração de metadados ou geração de thumbnail podem falhar por vídeo corrompido, timeout do FFmpeg, etc.).

**Options:**

### Option A: BullMQ + Redis
- Fila baseada em Redis, com suporte nativo a retries com backoff exponencial, concorrência configurável, delayed jobs e dead-letter (jobs falhos ficam retidos com o erro). O NestJS tem integração oficial de primeira classe (`@nestjs/bullmq`), com decorators `@Processor`/`@InjectQueue` e uma classe `WorkerHost` dedicada para rodar o worker como processo separado.
- **Pros:** integração nativa e madura com NestJS (confirmado via context7: `@nestjs/bullmq` v11-compatível); retry/backoff e progress tracking prontos, sem reinventar; Redis é uma peça de infra simples de subir via Docker Compose e amplamente compreendida.
- **Cons:** introduz Redis como nova dependência de infraestrutura (mais um serviço no compose, mais um ponto de falha operacional).

### Option B: RabbitMQ (AMQP) via `@nestjs/microservices` (transporte RMQ)
- Broker AMQP dedicado, com o NestJS suportando RabbitMQ nativamente como transporte de microserviço (`ClientsModule.register` + `@MessagePattern`/`@EventPattern`). Suporta ack manual, dead-letter exchanges e prefetch.
- **Pros:** modelo de mensageria mais rico (exchanges, routing keys, DLX) se o projeto crescer para múltiplos tipos de evento; desacopla completamente API e worker via protocolo padrão.
- **Cons:** mais complexo de configurar corretamente (filas, exchanges, bindings) para um caso de uso que é essencialmente "um job por vídeo enviado — processe e me avise"; nova infraestrutura (RabbitMQ) sem reaproveitar nada já decidido no projeto; curva de configuração maior que BullMQ para o mesmo resultado.

### Option C: pg-boss (fila sobre PostgreSQL)
- Biblioteca de fila que usa o próprio PostgreSQL (já no stack) como backend de persistência da fila, via `SKIP LOCKED` — sem exigir Redis ou RabbitMQ novos.
- **Pros:** zero infraestrutura nova — reaproveita o Postgres 17 já decidido nas Fases 01/02; simplifica o `compose.yaml`.
- **Cons:** sem integração oficial com NestJS (precisaria de um módulo custom fino); acopla a carga de processamento de vídeo (potencialmente pesada) ao mesmo banco transacional usado por toda a aplicação, competindo por conexões/IO com o tráfego principal; ecossistema e maturidade de retries/observability bem menores que BullMQ.

**Recommendation:** Option A (BullMQ + Redis) — é a única opção com integração de primeira classe confirmada no NestJS 11 instalado (`@nestjs/bullmq`, com `WorkerHost` já pensado para rodar como processo/container separado — o que a Fase 03 explicitamente precisa), e resolve retry/backoff sem código customizado. O custo de adicionar Redis é baixo (mais um serviço no Compose) frente ao ganho de não reinventar fila+retry em cima do Postgres (Option C) nem configurar AMQP para um caso de uso simples (Option B).

**Decision:** A (BullMQ + Redis)
**Libraries:** bullmq, @nestjs/bullmq, ioredis

---

## TD-02: Estratégia de upload de vídeos até 10GB sem travar a API

**Scope:** Backend

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** Passar um arquivo de até 10GB pelo processo Node da API (buffer em memória, ou mesmo `multipart/form-data` via Multer com disco temporário) trava o event loop, consome memória/disco do container da API e limita o throughput a um único ponto de gargalo. A API precisa, além disso, criar o registro do vídeo como rascunho no exato momento em que o upload começa — antes do arquivo estar completo.

**Options:**

### Option A: Presigned URL (upload direto ao object storage)
- O cliente chama um endpoint da API (`POST /videos`) que cria o vídeo como rascunho no banco e retorna uma URL pré-assinada (via `@aws-sdk/s3-request-presigner`) apontando diretamente para o bucket no MinIO/S3. O cliente faz o `PUT` do arquivo direto para o storage — o processo da API nunca vê os bytes do vídeo. Ao concluir, o cliente (ou um webhook/callback) notifica a API, que enfileira o job de processamento.
- **Pros:** a API nunca segura o arquivo — zero impacto em memória/CPU do processo Node independente do tamanho; escala horizontalmente sem replicar tráfego de upload; é o padrão consagrado para uploads grandes contra S3-compatible storage.
- **Cons:** exige um segundo passo (a API precisa ser avisada quando o upload terminar, ou fazer polling/HEAD no objeto) para dar o "start" no processamento; upload de arquivo único via `PUT` simples tem limite prático de ~5GB por objeto no protocolo S3 (single PUT) — para garantir os 10GB completos é necessário combinar com multipart (ver Option B) ou emitir múltiplas presigned URLs de parte.

### Option B: Multipart upload direto ao storage (presigned multipart)
- Extensão da Option A: a API inicia um multipart upload no storage (`CreateMultipartUpload`), gera uma presigned URL por parte (`UploadPart`, tipicamente de 5–100MB cada), o cliente envia as partes em paralelo/sequência diretamente ao storage, e a API finaliza (`CompleteMultipartUpload`) quando avisada.
- **Pros:** resolve o limite de tamanho por objeto de forma nativa ao protocolo S3, permite retomar partes individuais falhas (resiliência de rede) e paralelizar partes — essencial para 10GB de forma robusta.
- **Cons:** mais estados para orquestrar na API (iniciar multipart, gerar N presigned URLs, receber confirmação de cada parte, completar) — mais superfície de erro (partes órfãs se o cliente abandona o upload); exige que o cliente (frontend, fora de escopo desta fase, ou um script de teste) implemente a lógica de particionamento.

### Option C: Upload via API com streaming direto ao storage (sem persistir em disco/memória)
- O cliente envia o arquivo por `multipart/form-data` para um endpoint da própria API; o handler faz streaming do corpo da requisição diretamente para o storage (`PutObjectCommand` com um stream, sem buffer completo em memória nem gravação em disco temporário).
- **Pros:** um único endpoint simples do ponto de vista do cliente (sem orquestrar múltiplas URLs pré-assinadas); mantém o "front door" único já estabelecido pela API.
- **Cons:** o processo da API permanece no caminho crítico do upload inteiro — mesmo sem bufferizar, ele segura uma conexão HTTP longa por vídeo (10GB a uma conexão típica pode levar dezenas de minutos), competindo por conexões/threads do processo Node com o resto do tráfego da API; qualquer reinício/deploy da API durante um upload em andamento derruba a transferência inteira, sem possibilidade de retomada por partes.

**Recommendation:** Option B (presigned multipart direto ao storage) — é a única que atende literalmente a exigência do projeto ("sem travar o sistema") e o limite de 10GB por vídeo de forma robusta (Option A sozinha esbarra no teto prático de objeto único; Option C mantém a API no caminho do arquivo inteiro, o antipadrão que o enunciado pede para evitar). O fluxo de "pré-cadastro como rascunho" se encaixa naturalmente: o rascunho é criado no mesmo request que inicia o multipart upload, antes de qualquer byte do vídeo trafegar.

**Decision:** B (presigned multipart direto ao storage)
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

---

## TD-03: Execução do worker e processamento de mídia (FFmpeg)

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** `docs/diagrams/software-arch.mermaid` já define o Video Worker como um container separado rodando FFmpeg, consumindo jobs da fila e atualizando storage + banco. Falta decidir como o código Node invoca o FFmpeg/ffprobe (wrapper declarativo vs `child_process` cru) e como esse processo interage com a fila do TD-01.

**Options:**

### Option A: `fluent-ffmpeg` como wrapper + `WorkerHost` do BullMQ rodando em processo/container dedicado
- O worker é um segundo entrypoint Node (novo `Dockerfile`/serviço no compose, mesma base de código do `nestjs-project` ou um módulo standalone), registrando um `@Processor`/`WorkerHost` do BullMQ que consome a fila do TD-01. Dentro do handler, `fluent-ffmpeg` chama `ffmpeg.ffprobe()` para metadados/duração e `.screenshots({ timestamps, size, folder })` para gerar o thumbnail a partir de um frame — API fluente e declarativa confirmada via context7, sem gerenciar manualmente argumentos de CLI do FFmpeg.
- **Pros:** API de alto nível testada e madura para os dois casos exatos do enunciado (ffprobe para metadados, screenshots para thumbnail); menos código de parsing de stdout do FFmpeg; ainda assim `fluent-ffmpeg` só invoca o binário `ffmpeg`/`ffprobe` do sistema — nenhuma mágica escondida.
- **Cons:** mais uma dependência npm para manter (embora fina — é só um wrapper de CLI); requer a imagem do worker ter os binários `ffmpeg`/`ffprobe` instalados (pacote do SO), independente da lib escolhida.

### Option B: `child_process.spawn('ffmpeg'/'ffprobe', [...args])` direto, sem wrapper
- O worker monta os argumentos de linha de comando manualmente e faz parsing do stdout/stderr do FFmpeg (ou usa `ffprobe -print_format json` para metadados estruturados).
- **Pros:** zero dependência npm adicional; controle total sobre os argumentos e sobre timeouts/kill de processos travados.
- **Cons:** reimplementa manualmente o que `fluent-ffmpeg` já resolve (parsing de JSON do ffprobe, cálculo de timestamps para screenshot); mais código de baixo nível para manter e testar; maior risco de bugs sutis de escaping de argumentos.

### Option C: Serviço de transcodificação gerenciado na nuvem (ex.: AWS Elemental MediaConvert)
- Delega a extração de metadados e geração de thumbnail a uma API externa gerenciada, sem rodar FFmpeg localmente.
- **Pros:** nenhuma manutenção de binário FFmpeg nem de worker próprio; escala automaticamente.
- **Cons:** contradiz a arquitetura do projeto (MinIO local + Docker Compose self-hosted, sem dependência de conta/serviço cloud para rodar em dev); adiciona custo e uma dependência de rede externa só para gerar duração/thumbnail, algo que o `software-arch.mermaid` já modela como um container FFmpeg local.

**Recommendation:** Option A (`fluent-ffmpeg` + worker BullMQ dedicado) — aproxima o código do exato par de operações que o enunciado pede (ffprobe + screenshot), com API já confirmada e madura (340 exemplos indexados no context7), evitando reescrever parsing de ffprobe (Option B) ou trazer uma dependência de nuvem incompatível com a arquitetura self-hosted já decidida (Option C).

**Decision:** A (`fluent-ffmpeg` + worker BullMQ dedicado)
**Libraries:** fluent-ffmpeg, bullmq, @nestjs/bullmq

---

## TD-04: Estratégia de URL única por vídeo

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Cada vídeo precisa de um identificador público que nunca colida com o de outro vídeo. O padrão já estabelecido nas Fases 01/02 (`users`, `channels`) usa `uuid_generate_v4()` como chave primária das entidades.

**Options:**

### Option A: Reaproveitar o UUID da entidade `Video` como identificador público da URL
- O `id` (uuid v4, gerado pelo Postgres via `uuid_generate_v4()`, mesmo padrão de `users`/`channels`) é usado diretamente como o segmento de URL único (`/videos/{id}`, `/videos/{id}/stream`, etc.).
- **Pros:** zero código novo — a garantia de unicidade já existe (chave primária); consistente com o padrão das entidades anteriores do projeto; nenhuma lógica de geração/retry de colisão para escrever ou testar.
- **Cons:** URLs longas e não amigáveis (UUIDs não são memoráveis) — irrelevante para o requisito da fase (que pede apenas unicidade, não brevidade).

### Option B: Slug curto dedicado (ex.: nanoid de 8-10 caracteres) em coluna separada
- Uma coluna adicional `slug` é gerada (ex.: `nanoid()`) na criação do rascunho, com um índice único no banco e uma verificação/retry em caso de colisão (rara, mas possível com alfabetos curtos).
- **Pros:** URLs mais curtas e "amigáveis" a compartilhamento.
- **Cons:** exige lógica adicional (geração + retry em colisão + índice único extra); nenhuma capacidade desta fase pede URL curta/amigável — é uma otimização não solicitada pelo escopo (a Fase 07, busca/home, é quem eventualmente lidaria com apresentação amigável).

### Option C: Identificador incremental ofuscado (ex.: id sequencial + hashids)
- Usa uma coluna serial/sequence do Postgres, ofuscada com uma lib como hashids para não expor a contagem real de vídeos.
- **Pros:** URLs curtas e sem colisão por construção (sequence garante isso).
- **Cons:** introduz uma sequence adicional e uma lib de ofuscação só para reproduzir o que o UUID já entrega de graça; maior complexidade sem ganho de requisito.

**Recommendation:** Option A (reaproveitar o UUID da entidade) — a capacidade pedida é exclusivamente "sem conflito com outros vídeos", que o UUID já garante por construção e sem nenhum código adicional, seguindo o padrão já decidido nas Fases 01/02. Brevidade de URL (Options B/C) não é um requisito desta fase.

**Decision:** A (reaproveitar o UUID da entidade)

---

## TD-05: Estratégia de entrega — streaming e download

**Scope:** Backend

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** O arquivo de vídeo vive no object storage (MinIO/S3), não no processo da API. É preciso decidir como o cliente reproduz por streaming (requisições HTTP Range, resposta `206 Partial Content`) e como baixa o arquivo completo, sem duplicar a lógica de acesso ao storage.

**Options:**

### Option A: API atua como proxy de streaming (repassa `Range` ao storage)
- O endpoint de reprodução lê o header `Range` da requisição do cliente, chama `GetObjectCommand` no S3/MinIO com o mesmo `Range`, e repassa o stream retornado (via `@Res({ passthrough: true })`, já que `StreamableFile` do NestJS não lida nativamente com `Range`/`206` — confirmado via context7, que documenta `StreamableFile` apenas para streaming completo simples) com status `206` e os headers `Content-Range`/`Accept-Ranges` corretos. O endpoint de download usa o mesmo caminho, sem `Range`, com `Content-Disposition: attachment`.
- **Pros:** único ponto de acesso ao storage — a API controla autorização por requisição (relevante quando a Fase 04/05 introduzir vídeos "unlisted"/privados); nenhuma URL de storage é exposta ao cliente; um único código de acesso a objeto serve tanto streaming quanto download (mesma capability, dois modos de resposta).
- **Cons:** o tráfego de bytes do vídeo passa pelo processo da API (ainda que como stream, sem bufferizar) — consumo de banda da API proporcional ao consumo de vídeo, diferente do upload (que evita a API via TD-02).

### Option B: Redirect para presigned GET URL do storage
- O endpoint de reprodução/download gera uma presigned URL de leitura (`GetObjectCommand` + `s3-request-presigner`) e responde com um redirect (302) para ela — o cliente então negocia `Range`/streaming diretamente com o MinIO/S3, sem a API no caminho dos bytes.
- **Pros:** zero tráfego de vídeo pela API — todo o bandwidth é servido pelo storage, que é feito para isso; simples de implementar (uma chamada ao SDK + redirect).
- **Cons:** expõe a URL real do storage ao cliente (mesmo assinada e com expiração) — controle de acesso fica limitado à janela de expiração da URL, não a cada requisição; qualquer necessidade futura (Fase 05/06) de controlar acesso por-requisição (ex.: vídeo unlisted, "somente autenticados podem baixar") exigiria reemitir presigned URLs com TTL curto e reautenticar a cada player seek, complicando o player.

**Recommendation:** Option A (API como proxy de streaming/download) — mantém a API como único ponto de controle de acesso ao arquivo, essencial porque a Fase 04 já prevê visibilidade "unlisted" e a Fase 05 acesso anônimo controlado — decisões que dependem de a API decidir, a cada requisição, se aquele vídeo pode ser servido àquele cliente. O custo (bandwidth passando pela API) é aceitável para o escopo desta fase e pode ser revisitado depois sem quebrar contrato de URL pública (TD-04 já resolve isso via UUID estável).

**Decision:** A (API como proxy de streaming/download)
**Libraries:** @aws-sdk/client-s3

---

## TD-06: Ciclo de status do vídeo e tratamento de falha de processamento

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** O vídeo passa por estados distintos entre o início do upload e ficar pronto para reprodução; é preciso definir esses estados, quem os transiciona, e o que acontece quando o processamento (TD-03) falha — sem essa decisão, a coluna de status e o contrato de erro da API ficam ambíguos.

**Options:**

### Option A: Enum de status simples na entidade + retry nativo do BullMQ, status `error` só após esgotar tentativas
- Coluna `status` (`draft` → `uploaded` → `processing` → `ready` | `error`) na entidade `Video`. O job de processamento usa `attempts`/`backoff` nativos do BullMQ (TD-01); a API só marca `error` no evento `failed` do worker quando o BullMQ já esgotou todas as tentativas configuradas (falha definitiva), evitando marcar erro prematuramente em uma falha transitória que ainda será reprocessada.
- **Pros:** reaproveita a infraestrutura de retry já decidida no TD-01, sem reescrever lógica de tentativas na aplicação; modelo de estados mínimo e direto de mapear para os bullets da fase.
- **Cons:** o motivo detalhado da falha (qual etapa: metadados ou thumbnail, qual erro do FFmpeg) fica só no log do job/worker, não em uma coluna estruturada — aceitável para o escopo desta fase, mas exigiria uma coluna extra (`error_reason`) se telemetria mais rica for necessária depois.

### Option B: Máquina de estados mais granular (por etapa: `extracting_metadata`, `generating_thumbnail`, etc.) com tabela de eventos de auditoria
- Estados intermediários por sub-etapa do processamento, persistidos em uma tabela separada `video_processing_events` com histórico completo de cada tentativa.
- **Pros:** rastreabilidade completa de cada etapa e tentativa, útil para debugging fino de falhas em produção.
- **Cons:** complexidade adicional bem além do que os bullets da fase pedem (eles falam em "processamento automático" e "pronto/erro", não em uma máquina de estados granular); mais uma tabela, mais uma migration, mais superfície para os testes cobrirem sem benefício claro no escopo atual.

**Recommendation:** Option A — os bullets da Fase 03 pedem um resultado binário observável (processamento aconteceu automaticamente, vídeo fica pronto ou em erro), e o BullMQ (já decidido no TD-01) resolve retry/backoff nativamente; reconstruir uma máquina de estados granular (Option B) é complexidade não pedida por nenhuma capability desta fase.

**Decision:** A

---

## TD-07: Uso do object storage — organização de buckets/keys e SDK cliente

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** O object storage em si (MinIO local / S3-compatível em produção) já é dado pela arquitetura do projeto — não é uma escolha de tecnologia. O que resta decidir é (a) qual SDK cliente usar a partir do NestJS e (b) como organizar buckets/keys para vídeo original e thumbnail de forma que a troca de MinIO→S3 real em produção não exija mudança de código.

**Options:**

### Option A: `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`, com `endpoint` customizado e `forcePathStyle: true` apontando para o MinIO
- SDK oficial da AWS (v3, modular), configurado com `endpoint: http://<minio-service>:9000` e `forcePathStyle: true` para dev (confirmado via context7 como o padrão documentado para endpoints S3-compatíveis tipo MinIO/Cloudflare R2); em produção, apenas remove-se `endpoint`/`forcePathStyle` e aponta para a região AWS real — mesmo código, zero branch condicional por ambiente.
- **Pros:** é literalmente o SDK oficial da AWS — trocar MinIO por S3 real em produção é uma mudança de configuração (env vars), não de código, exatamente como a arquitetura do projeto já prevê; maior ecossistema de documentação e exemplos (14k+ snippets indexados).
- **Cons:** API um pouco mais verbosa que clientes MinIO-nativos para operações simples (put/get) — irrelevante frente ao ganho de portabilidade.

### Option B: SDK oficial `minio` (cliente MinIO nativo)
- Cliente JS oficial do projeto MinIO, com API de alto nível (`putObject`, `presignedPutObject`, etc.) pensada especificamente para MinIO.
- **Pros:** API mais simples para os casos de uso básicos.
- **Cons:** é um cliente MinIO-específico — embora o servidor MinIO fale o protocolo S3, o pacote `minio` não é o SDK da AWS; trocar para S3 real em produção exigiria reescrever a camada de acesso a storage (ou manter duas implementações), contradizendo a premissa da arquitetura ("MinIO localmente, S3 em produção, mesma API").

**Recommendation:** Option A (`@aws-sdk/client-s3`) — é a única opção que cumpre literalmente a premissa já dada pela arquitetura do projeto (mesma API contra MinIO local e S3 real em produção, troca só de configuração), confirmada via context7 como o padrão documentado para endpoints S3-compatíveis.

Organização de buckets/keys proposta (para `plan-context`/`plan-build` refinarem, não é uma decisão de biblioteca): um bucket `videos` com prefixo por vídeo, ex. `{videoId}/original.<ext>` e `{videoId}/thumbnail.jpg` — evita colisão entre vídeos (chave prefixada pelo UUID do TD-04) e mantém original/thumbnail agrupados sob o mesmo prefixo para lifecycle/limpeza conjunta.

**Decision:** A (`@aws-sdk/client-s3`)
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

---

## TD-08: Política de acesso aos endpoints de vídeo nesta fase (pré-visibilidade da Fase 04)

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** `plan-validate` (MD-1) apontou que nenhuma TD decide, para o estado atual do sistema (só rascunho → processando → pronto/erro, **sem** o conceito de visibilidade pública/unlisted nem fluxo de publicação, que só chegam na Fase 04), quem pode consultar status, streamar ou baixar um vídeo. A TD-05 já decidiu que a API atua como proxy de acesso (arquitetura), mas não decidiu a **regra de autorização** que esse proxy aplica a cada requisição — é essa lacuna que esta TD fecha.

**Options:**

### Option A: Somente o dono do canal (owner-only) em todos os status
- Toda requisição a `GET /videos/:id` (status), streaming e download exige que o usuário autenticado seja o dono do canal proprietário do vídeo, independentemente do status (`draft`, `processing`, `ready` ou `error`). Nenhum outro usuário — autenticado ou anônimo — acessa o vídeo nesta fase.
- **Pros:** modelo de segurança mais simples e conservador — nenhum vídeo (nem mesmo "pronto") fica acessível antes de a Fase 04 introduzir explicitamente publicação/visibilidade; reaproveita o guard JWT global já existente (Fase 02) sem introduzir nenhum conceito novo de autorização; evita o cenário de um vídeo terminar de processar e ficar acessível a terceiros antes do dono decidir publicá-lo.
- **Cons:** endpoints de streaming/download ficam "fechados" mesmo para vídeos já prontos, o que exigirá uma mudança de regra (não apenas uma adição) quando a Fase 04 introduzir visibilidade pública/unlisted — a checagem de "dono do canal" precisará ser substituída/complementada pela checagem de visibilidade.

### Option B: Owner-only para rascunho/processando/erro; aberto para "pronto"
- Vídeos em `draft`, `processing` ou `error` só são acessíveis ao dono do canal. Vídeos `ready` ficam acessíveis a qualquer requisição autenticada (ou até anônima) via streaming/download/status.
- **Pros:** antecipa o comportamento final do produto (Fase 05 prevê acesso anônimo a vídeos) e evita reescrever a regra de acesso quando a Fase 04 chegar — só adiciona um filtro de visibilidade em cima do que já existe.
- **Cons:** introduz uma forma de "publicação implícita": o vídeo fica público assim que o processamento automático termina, sem o dono ter decidido nada — a Fase 04 é explicitamente quem deveria introduzir o conceito de "publicar" um vídeo; antecipar isso aqui contradiz a sequência do projeto (`Depende de: Fase 01, Fase 02`, sem menção a publicação nesta fase) e o project-plan.md, que só introduz "visibilidade pública/unlisted" e "fluxo de rascunho → publicação" na Fase 04.

### Option C: Sem controle de acesso nesta fase (todos os endpoints públicos)
- Nenhuma checagem de propriedade — qualquer requisição, autenticada ou não, acessa status/streaming/download de qualquer vídeo pelo UUID.
- **Pros:** custo de implementação zero nesta fase; mais simples de testar.
- **Cons:** contradiz a postura defensiva já estabelecida no projeto (guard JWT global por padrão, opt-out explícito via `@Public()` — Fase 02); vídeos em rascunho/processando (potencialmente conteúdo incompleto ou impróprio) ficariam publicamente acessíveis por qualquer um que descubra o UUID; seria necessário reverter essa abertura na Fase 04, uma mudança maior do que apenas adicionar uma regra.

**Recommendation:** Option A (somente o dono do canal) — nenhuma capability desta fase exige que um vídeo seja visível a terceiros antes da Fase 04 (que introduz explicitamente "fluxo de rascunho → publicação" e "visibilidade pública/unlisted" no project-plan.md); abrir acesso a vídeos `ready` agora (Option B) equivale a implementar uma forma de publicação implícita que a Fase 04 deveria decidir, e não ter controle algum (Option C) contradiz a postura defensiva já adotada desde a Fase 02 (JWT guard global, opt-out explícito).

**Decision:** A: Somente o dono do canal (owner-only) 

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Tecnologia de fila de processamento em background | BullMQ + Redis |A |
| TD-02 | Backend | Estratégia de upload de até 10GB | Presigned multipart direto ao storage | B |
| TD-03 | Backend | Execução do worker e processamento de mídia | `fluent-ffmpeg` + worker BullMQ dedicado | A |
| TD-04 | Backend | Estratégia de URL única por vídeo | Reaproveitar o UUID da entidade `Video` | A |
| TD-05 | Backend | Estratégia de entrega — streaming e download | API como proxy de streaming/download | A |
| TD-06 | Backend | Ciclo de status do vídeo e tratamento de falha | Enum simples + retry nativo do BullMQ | A |
| TD-07 | Backend | Uso do object storage — SDK e organização de chaves | `@aws-sdk/client-s3` + `s3-request-presigner` | A |
| TD-08 | Backend | Política de acesso aos endpoints de vídeo (pré-Fase 04) | Somente o dono do canal (owner-only) | A |
