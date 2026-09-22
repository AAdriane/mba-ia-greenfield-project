import { Test, TestingModule } from '@nestjs/testing';
import type { Job } from 'bullmq';
import { VideoNotFoundException } from '../common/exceptions/domain.exception';
import { StorageService } from '../storage/storage.service';
import { VideoProcessingProcessor } from './video-processing.processor';
import { VideosService } from './videos.service';

describe('VideoProcessingProcessor', () => {
  let processor: VideoProcessingProcessor;
  let videosService: { markError: jest.Mock };

  function jobStub(overrides: Partial<Job> = {}): Job<{ videoId: string }> {
    return {
      data: { videoId: 'video-1' },
      opts: { attempts: 3 },
      attemptsMade: 3,
      ...overrides,
    } as unknown as Job<{ videoId: string }>;
  }

  beforeEach(async () => {
    videosService = { markError: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideoProcessingProcessor,
        { provide: VideosService, useValue: videosService },
        { provide: StorageService, useValue: {} },
      ],
    }).compile();

    processor = module.get(VideoProcessingProcessor);
  });

  describe('onFailed', () => {
    it('marks the video as errored once the retries are exhausted', async () => {
      await processor.onFailed(jobStub());

      expect(videosService.markError).toHaveBeenCalledWith('video-1');
    });

    it('does not mark the video while retries remain', async () => {
      await processor.onFailed(jobStub({ attemptsMade: 1 }));

      expect(videosService.markError).not.toHaveBeenCalled();
    });

    it('swallows VideoNotFoundException so an orphan job cannot kill the worker', async () => {
      videosService.markError.mockRejectedValue(new VideoNotFoundException());

      await expect(processor.onFailed(jobStub())).resolves.toBeUndefined();
    });

    it('rethrows any other failure to mark the video', async () => {
      videosService.markError.mockRejectedValue(new Error('connection lost'));

      await expect(processor.onFailed(jobStub())).rejects.toThrow(
        'connection lost',
      );
    });
  });
});
