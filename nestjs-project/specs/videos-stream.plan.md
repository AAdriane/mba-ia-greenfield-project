---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.10
target_file: nestjs-project/test/videos.e2e-spec.ts
---

# GET /videos/:id/stream Test Plan

## Application Overview

`GET /videos/:id/stream` proxies the video bytes from the object storage to the owning channel, honoring the client's `Range` header (responding `206 Partial Content` with `Content-Range`/`Accept-Ranges` when present) so the video can be scrubbed/played without downloading the full file, restricted to videos in `ready` status.

## Test Scenarios

### 1. GET /videos/:id/stream

**Setup:** `beforeAll` bootstraps `AppModule` via `Test.createTestingModule` and reproduces `main.ts` global config; seed two authenticated users each with their own channel (owner and non-owner) via the existing auth/channels E2E helpers. Before each scenario, upload a real small video object to the MinIO test bucket and insert a `Video` row for the owner's channel pointing at that `original_storage_key` with a known `status`. `afterEach` truncates the `videos` table and removes the uploaded test object.

#### 1.1. no-range-returns-200-with-full-video

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-08T23:14:08Z

**Steps:**
  1. Owner GETs `/videos/:id/stream` (video `status: ready`) without a `Range` header
    - expect: `200` status
    - expect: response body bytes equal the full test video object

#### 1.2. range-header-returns-206-with-content-range

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-08T23:14:08Z

**Steps:**
  1. Owner GETs `/videos/:id/stream` (video `status: ready`) with header `Range: bytes=0-99`
    - expect: `206` status
    - expect: response header `Content-Range` matches `bytes 0-99/<total-size>`
    - expect: response body is exactly the requested 100 bytes

#### 1.3. non-ready-video-returns-409

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-08T23:14:08Z

**Steps:**
  1. Owner GETs `/videos/:id/stream` for a video with `status: processing`
    - expect: `409` status
    - expect: response body `error` is `VIDEO_NOT_READY`

#### 1.4. non-owner-returns-403

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-08T23:14:08Z

**Steps:**
  1. Non-owner GETs `/videos/:id/stream` for a video (`status: ready`) belonging to the owner's channel
    - expect: `403` status
    - expect: response body `error` is `FORBIDDEN`
