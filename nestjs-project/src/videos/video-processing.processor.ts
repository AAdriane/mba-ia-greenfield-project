import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { createWriteStream } from 'fs';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import ffmpeg from 'fluent-ffmpeg';
import { VideoNotFoundException } from '../common/exceptions/domain.exception';
import { StorageService } from '../storage/storage.service';
import { VideosService } from './videos.service';

interface VideoProcessJobData {
  videoId: string;
}

const THUMBNAIL_FILE_NAME = 'thumbnail.jpg';

@Injectable()
@Processor('video-processing')
export class VideoProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  constructor(
    private readonly storageService: StorageService,
    private readonly videosService: VideosService,
  ) {
    super();
  }

  async process(job: Job<VideoProcessJobData>): Promise<void> {
    const { videoId } = job.data;
    const video = await this.videosService.findByIdOrFail(videoId);

    const workDir = await mkdtemp(join(tmpdir(), 'video-'));
    try {
      const originalPath = join(workDir, 'original');
      const { body } = await this.storageService.getObjectStream(
        video.original_storage_key,
      );
      await pipeline(body, createWriteStream(originalPath));

      const metadata = await this.probe(originalPath);
      const durationSeconds = metadata.format.duration ?? 0;

      await this.generateThumbnail(originalPath, workDir);
      const thumbnailBuffer = await readFile(
        join(workDir, THUMBNAIL_FILE_NAME),
      );
      const thumbnailStorageKey = `${videoId}/thumbnail.jpg`;
      await this.storageService.putObject(
        thumbnailStorageKey,
        thumbnailBuffer,
        'image/jpeg',
      );

      await this.videosService.markReady(videoId, {
        durationSeconds,
        metadata: metadata as unknown as Record<string, unknown>,
        thumbnailStorageKey,
      });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<VideoProcessJobData>): Promise<void> {
    const attemptsAllowed = job.opts.attempts ?? 1;
    if (job.attemptsMade < attemptsAllowed) {
      return;
    }

    const { videoId } = job.data;
    this.logger.error(
      `Video ${videoId} failed processing after ${job.attemptsMade} attempts`,
    );

    try {
      await this.videosService.markError(videoId);
    } catch (error) {
      // The video may have been deleted while the job was retrying. There is
      // nothing left to mark, and throwing here would escape the event handler
      // and take the whole worker process down.
      if (error instanceof VideoNotFoundException) {
        this.logger.warn(
          `Video ${videoId} no longer exists; skipping error status update`,
        );
        return;
      }
      throw error;
    }
  }

  private probe(filePath: string): Promise<ffmpeg.FfprobeData> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, data) => {
        if (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        } else {
          resolve(data);
        }
      });
    });
  }

  private generateThumbnail(
    inputPath: string,
    outputDir: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .on('end', () => resolve())
        .on('error', (err: Error) => reject(err))
        .screenshots({
          timestamps: ['50%'],
          filename: THUMBNAIL_FILE_NAME,
          folder: outputDir,
        });
    });
  }
}
