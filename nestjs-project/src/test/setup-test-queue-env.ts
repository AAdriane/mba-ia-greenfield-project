/**
 * Jest setup file — runs after `dotenv/config`, so it overrides whatever the
 * developer's `.env` says.
 *
 * Integration/e2e tests publish to the real Redis, but they must never share a
 * queue with the long-running `video-worker` container: that worker would pick
 * up test jobs (whose videos are deleted by `cleanAllTables`) and, in return,
 * its own orphan retries would show up in the tests' `queue.getJobs()`
 * assertions. Pointing the tests at a dedicated Redis logical database keeps
 * both sides blind to each other.
 */
process.env.REDIS_DB = process.env.TEST_REDIS_DB ?? '15';
