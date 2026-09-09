import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { QueueModule } from './queue.module';

describe('QueueModule', () => {
  it('should compile and resolve the video-processing queue via DI', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    }).compile();

    const queue = module.get<Queue>(getQueueToken('video-processing'));

    expect(module).toBeDefined();
    expect(queue).toBeDefined();
    expect(queue.name).toBe('video-processing');

    await queue.close();
    await module.close();
  }, 15000);
});
