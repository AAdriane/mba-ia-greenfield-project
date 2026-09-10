---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.7
target_file: nestjs-project/test/videos.e2e-spec.ts
---

# POST /videos/:id/complete-upload Test Plan

## Application Overview

`POST /videos/:id/complete-upload` finalizes the multipart upload on the object storage (using the part `eTag`s the client collected while uploading directly to storage) and enqueues the `video.process` background job, moving the video from `draft`/`uploaded` to `processing`.

## Test Scenarios

### 1. POST /videos/:id/complete-upload

**Setup:** `beforeAll` bootstraps `AppModule` via `Test.createTestingModule` and reproduces `main.ts` global config; seed two authenticated users each with their own channel (owner and non-owner) via the existing auth/channels E2E helpers. Before each scenario, create a `Video` row for the owner's channel via `POST /videos` (real multipart upload against the MinIO test instance, parts uploaded with real bytes, `eTag`s captured) so `complete-upload` has a real `uploadId`/parts pair to finalize. `afterEach` truncates the `videos` table.

#### 1.1. owner-with-valid-parts-returns-202-processing

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-08T23:14:08Z

**Steps:**
  1. Owner POSTs `/videos/:id/complete-upload` with the `parts` array (`partNumber` + `eTag`) collected from the real part uploads
    - expect: `202` status
    - expect: response body `id` matches the video id and `status` is `"processing"`

#### 1.2. non-owner-returns-403

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-08T23:14:08Z

**Steps:**
  1. Non-owner POSTs `/videos/:id/complete-upload` for a video belonging to the owner's channel, with a valid `parts` body
    - expect: `403` status
    - expect: response body `error` is `FORBIDDEN`

#### 1.3. nonexistent-video-returns-404

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-08T23:14:08Z

**Steps:**
  1. Owner POSTs `/videos/<random-uuid>/complete-upload` for an id that does not exist
    - expect: `404` status
    - expect: response body `error` is `VIDEO_NOT_FOUND`

#### 1.4. successful-completion-publishes-video-process-job

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-08T23:14:08Z

**Steps:**
  1. Owner POSTs `/videos/:id/complete-upload` with valid `parts`
    - expect: `202` status
  2. Inspect the real `video-processing` BullMQ queue (via the injected `Queue` instance / `getJobs`) for a job matching `video.process`
    - expect: exactly one job is present with payload `{ videoId: <id> }`
