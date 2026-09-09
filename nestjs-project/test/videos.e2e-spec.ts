import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import type { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { User } from '../src/users/entities/user.entity';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';

describe('videos', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let videoProcessingQueue: Queue;
  let storageService: StorageService;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
    videoProcessingQueue = moduleFixture.get<Queue>(
      getQueueToken('video-processing'),
    );
    storageService = moduleFixture.get(StorageService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    await videoProcessingQueue.drain(true);
  });

  async function captureConfirmationToken(
    email: string,
    password = 'password123',
  ): Promise<string> {
    const authService = app.get(AuthService);
    const mailServiceInstance = (authService as any).mailService;
    let capturedToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_e: string, _n: string, t: string) => {
        capturedToken = t;
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    return capturedToken;
  }

  async function registerConfirmAndLogin(
    email: string,
    password = 'password123',
  ): Promise<string> {
    const token = await captureConfirmationToken(email, password);
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
    return res.body.access_token as string;
  }

  async function getChannelIdForEmail(email: string): Promise<string> {
    const user = await dataSource
      .getRepository(User)
      .findOneByOrFail({ email });
    const channel = await dataSource
      .getRepository(Channel)
      .findOneByOrFail({ user_id: user.id });
    return channel.id;
  }

  async function createVideoAndUploadParts(accessToken: string): Promise<{
    videoId: string;
    parts: { partNumber: number; eTag: string }[];
  }> {
    const createRes = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        fileName: 'video.mp4',
        fileSizeBytes: 1024,
        mimeType: 'video/mp4',
      });

    const parts = await Promise.all(
      createRes.body.parts.map(
        async (part: { partNumber: number; url: string }) => {
          const res = await fetch(part.url, {
            method: 'PUT',
            body: Buffer.from(`part-${part.partNumber}-bytes`),
          });
          return {
            partNumber: part.partNumber,
            eTag: res.headers.get('etag') as string,
          };
        },
      ),
    );

    return { videoId: createRes.body.id, parts };
  }

  let readyVideoCounter = 0;
  async function createReadyVideoWithContent(
    channelId: string,
    content: Buffer,
  ): Promise<string> {
    readyVideoCounter += 1;
    const video = await dataSource.getRepository(Video).save(
      dataSource.getRepository(Video).create({
        channel_id: channelId,
        original_storage_key: `stream-test/${readyVideoCounter}/original.mp4`,
        status: VideoStatus.READY,
      }),
    );
    await storageService.putObject(
      video.original_storage_key,
      content,
      'video/mp4',
    );
    return video.id;
  }

  function requestBinary(path: string, accessToken: string) {
    return request(app.getHttpServer())
      .get(path)
      .set('Authorization', `Bearer ${accessToken}`)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
  }

  // POST /videos
  describe('POST /videos', () => {
    it('valid payload returns 201 with upload parts', async () => {
      const email = 'owner1@example.com';
      const accessToken = await registerConfirmAndLogin(email);

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          fileName: 'my-video.mp4',
          fileSizeBytes: 1024 * 1024,
          mimeType: 'video/mp4',
        });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('id');
      expect(res.body).toHaveProperty('uploadId');
      expect(res.body).toHaveProperty('partSize');
      expect(Array.isArray(res.body.parts)).toBe(true);
      expect(res.body.parts.length).toBeGreaterThan(0);
      expect(res.body.parts[0]).toHaveProperty('partNumber');
      expect(res.body.parts[0]).toHaveProperty('url');
    });

    it('fileSizeBytes over the 10GB limit returns 400', async () => {
      const email = 'owner2@example.com';
      const accessToken = await registerConfirmAndLogin(email);

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          fileName: 'huge-video.mp4',
          fileSizeBytes: 10737418240 + 1,
          mimeType: 'video/mp4',
        });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('statusCode', 400);
      expect(res.body).toHaveProperty('error');
      expect(res.body).toHaveProperty('message');
    });

    it('mimeType that does not start with video/ returns 400 INVALID_MIME_TYPE', async () => {
      const email = 'owner3@example.com';
      const accessToken = await registerConfirmAndLogin(email);

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          fileName: 'not-a-video.pdf',
          fileSizeBytes: 1024,
          mimeType: 'application/pdf',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_MIME_TYPE');
    });

    it('created video persists with draft status and the owner channel', async () => {
      const email = 'owner4@example.com';
      const accessToken = await registerConfirmAndLogin(email);
      const channelId = await getChannelIdForEmail(email);

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          fileName: 'my-video.mp4',
          fileSizeBytes: 1024 * 1024,
          mimeType: 'video/mp4',
        });

      expect(res.status).toBe(201);

      const video = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ id: res.body.id });

      expect(video.status).toBe('draft');
      expect(video.channel_id).toBe(channelId);
    });
  });

  // POST /videos/:id/complete-upload
  describe('POST /videos/:id/complete-upload', () => {
    it('owner with valid parts returns 202 processing', async () => {
      const accessToken = await registerConfirmAndLogin(
        'complete1@example.com',
      );
      const { videoId, parts } = await createVideoAndUploadParts(accessToken);

      const res = await request(app.getHttpServer())
        .post(`/videos/${videoId}/complete-upload`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts });

      expect(res.status).toBe(202);
      expect(res.body.id).toBe(videoId);
      expect(res.body.status).toBe('processing');
    });

    it('non-owner returns 403', async () => {
      const ownerToken = await registerConfirmAndLogin(
        'complete2-owner@example.com',
      );
      const { videoId, parts } = await createVideoAndUploadParts(ownerToken);
      const nonOwnerToken = await registerConfirmAndLogin(
        'complete2-nonowner@example.com',
      );

      const res = await request(app.getHttpServer())
        .post(`/videos/${videoId}/complete-upload`)
        .set('Authorization', `Bearer ${nonOwnerToken}`)
        .send({ parts });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('FORBIDDEN');
    });

    it('nonexistent video returns 404 VIDEO_NOT_FOUND', async () => {
      const accessToken = await registerConfirmAndLogin(
        'complete3@example.com',
      );

      const res = await request(app.getHttpServer())
        .post('/videos/00000000-0000-0000-0000-000000000000/complete-upload')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts: [{ partNumber: 1, eTag: '"fake"' }] });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });

    it('successful completion publishes the video.process job', async () => {
      const accessToken = await registerConfirmAndLogin(
        'complete4@example.com',
      );
      const { videoId, parts } = await createVideoAndUploadParts(accessToken);

      const res = await request(app.getHttpServer())
        .post(`/videos/${videoId}/complete-upload`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts });

      expect(res.status).toBe(202);

      const jobs = await videoProcessingQueue.getJobs([
        'waiting',
        'delayed',
        'active',
      ]);
      const matching = jobs.filter((job) => job.name === 'video.process');

      expect(matching).toHaveLength(1);
      expect(matching[0].data).toEqual({ videoId });
    });
  });

  // GET /videos/:id
  describe('GET /videos/:id', () => {
    it('owner returns 200 with current status', async () => {
      const email = 'status1@example.com';
      const accessToken = await registerConfirmAndLogin(email);
      const channelId = await getChannelIdForEmail(email);
      const video = await dataSource.getRepository(Video).save(
        dataSource.getRepository(Video).create({
          channel_id: channelId,
          original_storage_key: `${channelId}/original.mp4`,
          status: VideoStatus.PROCESSING,
        }),
      );

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.id}`)
        .set('Authorization', `Bearer ${accessToken}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(video.id);
      expect(res.body.status).toBe('processing');
      expect(res.body).toHaveProperty('durationSeconds');
      expect(res.body).toHaveProperty('createdAt');
    });

    it('non-owner returns 403', async () => {
      const ownerEmail = 'status2-owner@example.com';
      await registerConfirmAndLogin(ownerEmail);
      const channelId = await getChannelIdForEmail(ownerEmail);
      const video = await dataSource.getRepository(Video).save(
        dataSource.getRepository(Video).create({
          channel_id: channelId,
          original_storage_key: `${channelId}/original.mp4`,
        }),
      );
      const nonOwnerToken = await registerConfirmAndLogin(
        'status2-nonowner@example.com',
      );

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.id}`)
        .set('Authorization', `Bearer ${nonOwnerToken}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('FORBIDDEN');
    });

    it('nonexistent video returns 404 VIDEO_NOT_FOUND', async () => {
      const accessToken = await registerConfirmAndLogin('status3@example.com');

      const res = await request(app.getHttpServer())
        .get('/videos/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${accessToken}`);

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });
  });

  // GET /videos/:id/stream
  describe('GET /videos/:id/stream', () => {
    it('no Range header returns 200 with the full video', async () => {
      const email = 'stream1@example.com';
      const accessToken = await registerConfirmAndLogin(email);
      const channelId = await getChannelIdForEmail(email);
      const content = Buffer.from(
        Array.from({ length: 1000 }, (_, i) => i % 256),
      );
      const videoId = await createReadyVideoWithContent(channelId, content);

      const res = await requestBinary(`/videos/${videoId}/stream`, accessToken);

      expect(res.status).toBe(200);
      expect(Buffer.compare(res.body as Buffer, content)).toBe(0);
    });

    it('Range: bytes=0-99 returns 206 with correct Content-Range', async () => {
      const email = 'stream2@example.com';
      const accessToken = await registerConfirmAndLogin(email);
      const channelId = await getChannelIdForEmail(email);
      const content = Buffer.from(
        Array.from({ length: 1000 }, (_, i) => i % 256),
      );
      const videoId = await createReadyVideoWithContent(channelId, content);

      const res = await requestBinary(
        `/videos/${videoId}/stream`,
        accessToken,
      ).set('Range', 'bytes=0-99');

      expect(res.status).toBe(206);
      expect(res.headers['content-range']).toBe(`bytes 0-99/${content.length}`);
      expect(Buffer.compare(res.body as Buffer, content.subarray(0, 100))).toBe(
        0,
      );
    });

    it('non-ready video returns 409 VIDEO_NOT_READY', async () => {
      const email = 'stream3@example.com';
      const accessToken = await registerConfirmAndLogin(email);
      const channelId = await getChannelIdForEmail(email);
      const video = await dataSource.getRepository(Video).save(
        dataSource.getRepository(Video).create({
          channel_id: channelId,
          original_storage_key: `${channelId}/original.mp4`,
          status: VideoStatus.PROCESSING,
        }),
      );

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.id}/stream`)
        .set('Authorization', `Bearer ${accessToken}`);

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('VIDEO_NOT_READY');
    });

    it('non-owner returns 403', async () => {
      const ownerEmail = 'stream4-owner@example.com';
      await registerConfirmAndLogin(ownerEmail);
      const channelId = await getChannelIdForEmail(ownerEmail);
      const videoId = await createReadyVideoWithContent(
        channelId,
        Buffer.from('some video bytes'),
      );
      const nonOwnerToken = await registerConfirmAndLogin(
        'stream4-nonowner@example.com',
      );

      const res = await request(app.getHttpServer())
        .get(`/videos/${videoId}/stream`)
        .set('Authorization', `Bearer ${nonOwnerToken}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('FORBIDDEN');
    });
  });
});
