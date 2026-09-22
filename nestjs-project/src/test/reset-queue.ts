import type { Queue } from 'bullmq';

/**
 * Empties a queue between tests. `drain` only removes waiting/delayed jobs, so
 * completed and failed leftovers from a previous run are cleaned as well —
 * otherwise they leak into `getJobs()` assertions.
 */
export async function resetQueue(queue: Queue): Promise<void> {
  await queue.drain(true);
  await queue.clean(0, 0, 'completed');
  await queue.clean(0, 0, 'failed');
}
