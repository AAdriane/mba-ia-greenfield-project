import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { User } from '../src/users/entities/user.entity';
import { Video } from '../src/videos/entities/video.entity';

describe('videos', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;

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
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
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
});
