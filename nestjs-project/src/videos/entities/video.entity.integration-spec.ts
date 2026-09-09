import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    counter += 1;
    const user = await userRepository.save(
      userRepository.create({
        email: `video_user_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `video_chan_${counter}`,
        user_id: user.id,
      }),
    );
  }

  it('should persist and retrieve a video with default status draft', async () => {
    const channel = await createChannel();

    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        original_storage_key: `${channel.id}/original.mp4`,
      }),
    );

    const found = await videoRepository.findOneBy({ id: video.id });

    expect(found?.status).toBe(VideoStatus.DRAFT);
    expect(found?.original_storage_key).toBe(`${channel.id}/original.mp4`);
  });

  it('should reject insertion with a non-existent channel_id', async () => {
    await expect(
      videoRepository.save(
        videoRepository.create({
          channel_id: '00000000-0000-0000-0000-000000000000',
          original_storage_key: 'nonexistent/original.mp4',
        }),
      ),
    ).rejects.toThrow();
  });

  it('should reject an invalid status value', async () => {
    const channel = await createChannel();
    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        original_storage_key: `${channel.id}/original.mp4`,
      }),
    );

    await expect(
      dataSource.query('UPDATE "videos" SET "status" = $1 WHERE "id" = $2', [
        'not-a-real-status',
        video.id,
      ]),
    ).rejects.toThrow();
  });

  it('should allow null thumbnail_storage_key, upload_id, duration_seconds, and metadata', async () => {
    const channel = await createChannel();

    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        original_storage_key: `${channel.id}/original.mp4`,
      }),
    );

    expect(video.thumbnail_storage_key).toBeNull();
    expect(video.upload_id).toBeNull();
    expect(video.duration_seconds).toBeNull();
    expect(video.metadata).toBeNull();
  });

  it('should load the related channel via the ManyToOne relation', async () => {
    const channel = await createChannel();
    const saved = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        original_storage_key: `${channel.id}/original.mp4`,
      }),
    );

    const found = await videoRepository.findOne({
      where: { id: saved.id },
      relations: ['channel'],
    });

    expect(found?.channel.id).toBe(channel.id);
  });
});
