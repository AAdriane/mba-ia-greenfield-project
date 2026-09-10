import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { Readable } from 'stream';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

async function streamToString(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

describe('StorageService (integration)', () => {
  let app: INestApplication;
  let service: StorageService;

  const testKeyPrefix = 'test-storage-integration/';

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    service = moduleFixture.get(StorageService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('createMultipartUpload returns a valid uploadId', async () => {
    const uploadId = await service.createMultipartUpload(
      `${testKeyPrefix}case1.mp4`,
      'video/mp4',
    );

    expect(typeof uploadId).toBe('string');
    expect(uploadId.length).toBeGreaterThan(0);
  });

  it('getUploadPartUrl generates a URL that accepts a PUT of real bytes', async () => {
    const key = `${testKeyPrefix}case2.mp4`;
    const uploadId = await service.createMultipartUpload(key, 'video/mp4');
    const url = await service.getUploadPartUrl(key, uploadId, 1);

    const response = await fetch(url, {
      method: 'PUT',
      body: Buffer.from('hello world part bytes'),
    });

    expect(response.ok).toBe(true);
    expect(response.headers.get('etag')).toBeTruthy();
  });

  it('completeMultipartUpload finalizes the object, retrievable via getObjectStream', async () => {
    const key = `${testKeyPrefix}case3.mp4`;
    const content = 'the quick brown fox jumps over the lazy dog';
    const uploadId = await service.createMultipartUpload(key, 'video/mp4');
    const url = await service.getUploadPartUrl(key, uploadId, 1);

    const putResponse = await fetch(url, {
      method: 'PUT',
      body: Buffer.from(content),
    });
    const eTag = putResponse.headers.get('etag');
    expect(eTag).toBeTruthy();

    await service.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, eTag: eTag as string },
    ]);

    const result = await service.getObjectStream(key);
    const retrieved = await streamToString(result.body);

    expect(retrieved).toBe(content);
  });

  it('getObjectStream with a Range header returns only the requested bytes', async () => {
    const key = `${testKeyPrefix}case4.mp4`;
    const content = '0123456789abcdefghij';
    const uploadId = await service.createMultipartUpload(key, 'video/mp4');
    const url = await service.getUploadPartUrl(key, uploadId, 1);

    const putResponse = await fetch(url, {
      method: 'PUT',
      body: Buffer.from(content),
    });
    const eTag = putResponse.headers.get('etag');

    await service.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, eTag: eTag as string },
    ]);

    const result = await service.getObjectStream(key, 'bytes=0-4');
    const retrieved = await streamToString(result.body);

    expect(retrieved).toBe('01234');
    expect(result.contentRange).toContain('bytes 0-4');
  });
});
