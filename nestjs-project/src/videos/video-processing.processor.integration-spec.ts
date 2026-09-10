import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { execFile } from 'child_process';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { DataSource, Repository } from 'typeorm';
import { promisify } from 'util';
import { Channel } from '../channels/entities/channel.entity';
import { ChannelsModule } from '../channels/channels.module';
import { ChannelsService } from '../channels/channels.service';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoProcessingProcessor } from './video-processing.processor';
import { VideosModule } from './videos.module';

const execFileAsync = promisify(execFile);
const ALL_ENTITIES = [User, Channel, Video];

async function pollUntil(
  check: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 200,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('pollUntil: condition not met within timeout');
}

describe('VideoProcessingProcessor (integration)', () => {
  let moduleFixture: TestingModule;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let videoRepository: Repository<Video>;
  let channelsService: ChannelsService;
  let storageService: StorageService;
  let queue: Queue;
  let generatedVideoBuffer: Buffer;

  beforeAll(async () => {
    const ds = createTestDataSource(ALL_ENTITIES);
    moduleFixture = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(ds.options),
        ChannelsModule,
        QueueModule,
        StorageModule,
        VideosModule,
      ],
      providers: [VideoProcessingProcessor],
    }).compile();
    await moduleFixture.init();

    dataSource = moduleFixture.get(DataSource);
    userRepository = dataSource.getRepository(User);
    videoRepository = dataSource.getRepository(Video);
    channelsService = moduleFixture.get(ChannelsService);
    storageService = moduleFixture.get(StorageService);
    queue = moduleFixture.get<Queue>(getQueueToken('video-processing'));
    moduleFixture.get(VideoProcessingProcessor);

    const workDir = await mkdtemp(join(tmpdir(), 'ffmpeg-fixture-'));
    const outputPath = join(workDir, 'sample.mp4');
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=2:size=320x240:rate=1',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=1000:duration=2',
      '-c:v',
      'libx264',
      '-c:a',
      'aac',
      '-shortest',
      outputPath,
    ]);
    generatedVideoBuffer = await readFile(outputPath);
    await rm(workDir, { recursive: true, force: true });
  }, 30000);

  afterAll(async () => {
    await queue.close();
    await moduleFixture.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.drain(true);
  });

  let counter = 0;
  async function createOwnerVideo(): Promise<{ videoId: string }> {
    counter += 1;
    const user = await userRepository.save(
      userRepository.create({
        email: `worker_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelsService.createChannel(user.id, user.email);
    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        original_storage_key: `worker-test/${counter}/original.mp4`,
      }),
    );
    return { videoId: video.id };
  }

  it('a successfully processed job leaves the video ready with duration and thumbnail', async () => {
    const { videoId } = await createOwnerVideo();
    const video = await videoRepository.findOneByOrFail({ id: videoId });
    await storageService.putObject(
      video.original_storage_key,
      generatedVideoBuffer,
      'video/mp4',
    );

    await queue.add(
      'video.process',
      { videoId },
      { attempts: 3, backoff: { type: 'exponential', delay: 1000 } },
    );

    await pollUntil(async () => {
      const current = await videoRepository.findOneByOrFail({
        id: videoId,
      });
      return current.status !== VideoStatus.DRAFT;
    }, 15000);

    const processed = await videoRepository.findOneByOrFail({
      id: videoId,
    });
    expect(processed.status).toBe(VideoStatus.READY);
    expect(Number(processed.duration_seconds)).toBeGreaterThan(0);
    expect(processed.thumbnail_storage_key).toBe(`${videoId}/thumbnail.jpg`);

    const thumbnail = await storageService.getObjectStream(
      processed.thumbnail_storage_key as string,
    );
    const chunks: Buffer[] = [];
    for await (const chunk of thumbnail.body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const thumbnailBuffer = Buffer.concat(chunks);

    expect(thumbnailBuffer.length).toBeGreaterThan(0);
    expect(thumbnailBuffer[0]).toBe(0xff);
    expect(thumbnailBuffer[1]).toBe(0xd8);
  }, 20000);

  it('a job with a corrupted source file exhausts retries and leaves the video errored', async () => {
    const { videoId } = await createOwnerVideo();
    const video = await videoRepository.findOneByOrFail({ id: videoId });
    await storageService.putObject(
      video.original_storage_key,
      Buffer.from('this is not a real video file'),
      'video/mp4',
    );

    await queue.add(
      'video.process',
      { videoId },
      { attempts: 3, backoff: { type: 'exponential', delay: 1000 } },
    );

    await pollUntil(async () => {
      const current = await videoRepository.findOneByOrFail({
        id: videoId,
      });
      return current.status === VideoStatus.ERROR;
    }, 20000);

    const processed = await videoRepository.findOneByOrFail({
      id: videoId,
    });
    expect(processed.status).toBe(VideoStatus.ERROR);
  }, 25000);
});
