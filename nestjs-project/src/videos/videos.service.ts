import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import { extname } from 'path';
import type { Readable } from 'stream';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  ForbiddenChannelAccessException,
  InvalidMimeTypeException,
  InvalidStateException,
  RangeNotSatisfiableException,
  StorageCompleteFailedException,
  VideoNotFoundException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import { StorageService } from '../storage/storage.service';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video, VideoStatus } from './entities/video.entity';

const PART_SIZE_BYTES = 100 * 1024 * 1024;
const COMPLETABLE_STATUSES: VideoStatus[] = [
  VideoStatus.DRAFT,
  VideoStatus.UPLOADED,
];

export interface InitiateUploadResult {
  id: string;
  uploadId: string;
  partSize: number;
  parts: { partNumber: number; url: string }[];
}

export interface CompleteUploadResult {
  id: string;
  status: VideoStatus;
}

export interface VideoStatusResult {
  id: string;
  status: VideoStatus;
  durationSeconds: number | null;
  createdAt: Date;
}

export interface VideoStreamResult {
  body: Readable;
  status: 200 | 206;
  contentLength?: number;
  contentRange?: string;
  contentType?: string;
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    @InjectQueue('video-processing')
    private readonly videoProcessingQueue: Queue,
  ) {}

  async assertOwnership(videoId: string, userId: string): Promise<Video> {
    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (!video) {
      throw new VideoNotFoundException();
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel || channel.id !== video.channel_id) {
      throw new ForbiddenChannelAccessException();
    }

    return video;
  }

  async initiateUpload(
    userId: string,
    dto: CreateVideoDto,
  ): Promise<InitiateUploadResult> {
    if (!dto.mimeType.startsWith('video/')) {
      throw new InvalidMimeTypeException();
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new ForbiddenChannelAccessException();
    }

    const id = randomUUID();
    const extension = extname(dto.fileName).slice(1) || 'bin';
    const key = `${id}/original.${extension}`;

    const uploadId = await this.storageService.createMultipartUpload(
      key,
      dto.mimeType,
    );

    const partCount = Math.max(
      1,
      Math.ceil(dto.fileSizeBytes / PART_SIZE_BYTES),
    );
    const parts = await Promise.all(
      Array.from({ length: partCount }, (_, index) => index + 1).map(
        async (partNumber) => ({
          partNumber,
          url: await this.storageService.getUploadPartUrl(
            key,
            uploadId,
            partNumber,
          ),
        }),
      ),
    );

    await this.videoRepository.save(
      this.videoRepository.create({
        id,
        channel_id: channel.id,
        original_storage_key: key,
        upload_id: uploadId,
      }),
    );

    return { id, uploadId, partSize: PART_SIZE_BYTES, parts };
  }

  async completeUpload(
    videoId: string,
    userId: string,
    dto: CompleteUploadDto,
  ): Promise<CompleteUploadResult> {
    const video = await this.assertOwnership(videoId, userId);

    if (!COMPLETABLE_STATUSES.includes(video.status)) {
      throw new InvalidStateException();
    }

    try {
      await this.storageService.completeMultipartUpload(
        video.original_storage_key,
        video.upload_id as string,
        dto.parts,
      );
    } catch {
      throw new StorageCompleteFailedException();
    }

    video.status = VideoStatus.PROCESSING;
    await this.videoRepository.save(video);

    await this.videoProcessingQueue.add(
      'video.process',
      { videoId: video.id },
      { attempts: 3, backoff: { type: 'exponential', delay: 1000 } },
    );

    return { id: video.id, status: video.status };
  }

  async getStatus(videoId: string, userId: string): Promise<VideoStatusResult> {
    const video = await this.assertOwnership(videoId, userId);
    return {
      id: video.id,
      status: video.status,
      durationSeconds:
        video.duration_seconds === null ? null : Number(video.duration_seconds),
      createdAt: video.created_at,
    };
  }

  async assertReady(videoId: string, userId: string): Promise<Video> {
    const video = await this.assertOwnership(videoId, userId);
    if (video.status !== VideoStatus.READY) {
      throw new VideoNotReadyException();
    }
    return video;
  }

  async streamVideo(
    videoId: string,
    userId: string,
    range: string | undefined,
  ): Promise<VideoStreamResult> {
    const video = await this.assertReady(videoId, userId);

    let result;
    try {
      result = await this.storageService.getObjectStream(
        video.original_storage_key,
        range,
      );
    } catch (error) {
      if (range) {
        throw new RangeNotSatisfiableException();
      }
      throw error;
    }

    return {
      body: result.body,
      status: range ? 206 : 200,
      contentLength: result.contentLength,
      contentRange: result.contentRange,
      contentType: result.contentType,
    };
  }

  async findByIdOrFail(videoId: string): Promise<Video> {
    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  async markReady(
    videoId: string,
    data: {
      durationSeconds: number;
      metadata: Record<string, unknown>;
      thumbnailStorageKey: string;
    },
  ): Promise<void> {
    const video = await this.findByIdOrFail(videoId);
    video.status = VideoStatus.READY;
    video.duration_seconds = data.durationSeconds;
    video.metadata = data.metadata;
    video.thumbnail_storage_key = data.thumbnailStorageKey;
    await this.videoRepository.save(video);
  }

  async markError(videoId: string): Promise<void> {
    const video = await this.findByIdOrFail(videoId);
    video.status = VideoStatus.ERROR;
    await this.videoRepository.save(video);
  }
}
