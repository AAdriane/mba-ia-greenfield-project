import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { ChannelsModule } from '../channels/channels.module';
import { ChannelsService } from '../channels/channels.service';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { QueueModule } from '../queue/queue.module';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import type { CompleteUploadDto } from './dto/complete-upload.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, Video];

describe('VideosService.completeUpload (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let videosService: VideosService;
  let channelsService: ChannelsService;
  let queue: Queue;

  beforeAll(async () => {
    const ds = createTestDataSource(ALL_ENTITIES);
    const moduleFixture = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(ds.options),
        ChannelsModule,
        QueueModule,
        VideosModule,
      ],
    }).compile();

    dataSource = moduleFixture.get(DataSource);
    userRepository = dataSource.getRepository(User);
    videosService = moduleFixture.get(VideosService);
    channelsService = moduleFixture.get(ChannelsService);
    queue = moduleFixture.get<Queue>(getQueueToken('video-processing'));
  });

  afterAll(async () => {
    await queue.close();
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.drain(true);
  });

  let counter = 0;
  async function createOwnerUser(): Promise<string> {
    counter += 1;
    const user = await userRepository.save(
      userRepository.create({
        email: `complete_upload_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    await channelsService.createChannel(user.id, user.email);
    return user.id;
  }

  async function uploadAndReturnCompleteDto(
    userId: string,
  ): Promise<{ videoId: string; dto: CompleteUploadDto }> {
    const initiated = await videosService.initiateUpload(userId, {
      fileName: 'video.mp4',
      fileSizeBytes: 1024,
      mimeType: 'video/mp4',
    });

    const parts = await Promise.all(
      initiated.parts.map(async (part) => {
        const res = await fetch(part.url, {
          method: 'PUT',
          body: Buffer.from(`part-${part.partNumber}-bytes`),
        });
        return {
          partNumber: part.partNumber,
          eTag: res.headers.get('etag') as string,
        };
      }),
    );

    return { videoId: initiated.id, dto: { parts } };
  }

  it('transitions video status from draft to processing', async () => {
    const userId = await createOwnerUser();
    const { videoId, dto } = await uploadAndReturnCompleteDto(userId);

    const result = await videosService.completeUpload(videoId, userId, dto);

    expect(result.status).toBe(VideoStatus.PROCESSING);

    const video = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: videoId });
    expect(video.status).toBe(VideoStatus.PROCESSING);
  });

  it('publishes the video.process job on the real queue', async () => {
    const userId = await createOwnerUser();
    const { videoId, dto } = await uploadAndReturnCompleteDto(userId);

    await videosService.completeUpload(videoId, userId, dto);

    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    const matching = jobs.filter((job) => job.name === 'video.process');

    expect(matching).toHaveLength(1);
    expect(matching[0].data).toEqual({ videoId });
  });
});
