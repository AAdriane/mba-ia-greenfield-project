import { registerAs } from '@nestjs/config';

export default registerAs('queue', () => ({
  host: process.env.REDIS_HOST || 'redis',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  /**
   * Redis logical database index. Tests point this at a dedicated index so the
   * long-running video-worker never consumes (or pollutes) the test queue.
   */
  db: parseInt(process.env.REDIS_DB || '0', 10),
}));
