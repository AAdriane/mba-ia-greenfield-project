import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { extname } from 'path';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  ForbiddenChannelAccessException,
  InvalidMimeTypeException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import { StorageService } from '../storage/storage.service';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video } from './entities/video.entity';

const PART_SIZE_BYTES = 100 * 1024 * 1024;

export interface InitiateUploadResult {
  id: string;
  uploadId: string;
  partSize: number;
  parts: { partNumber: number; url: string }[];
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
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
}
