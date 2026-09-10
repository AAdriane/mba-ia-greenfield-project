---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.11
target_file: nestjs-project/test/videos.e2e-spec.ts
---

# GET /videos/:id/download Test Plan

## Application Overview

`GET /videos/:id/download` lets the owning channel download the complete, processed video file, proxying the bytes from the object storage with `Content-Disposition: attachment`, restricted to videos in `ready` status.

## Test Scenarios

### 1. GET /videos/:id/download

**Setup:** `beforeAll` bootstraps `AppModule` via `Test.createTestingModule` and reproduces `main.ts` global config; seed two authenticated users each with their own channel (owner and non-owner) via the existing auth/channels E2E helpers. Before each scenario, upload a real small video object to the MinIO test bucket and insert a `Video` row for the owner's channel pointing at that `original_storage_key` with a known `status`. `afterEach` truncates the `videos` table and removes the uploaded test object.

#### 1.1. owner-returns-200-with-attachment-header

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-08T23:14:08Z

**Steps:**
  1. Owner GETs `/videos/:id/download` for a video with `status: ready`
    - expect: `200` status
    - expect: response header `Content-Disposition` starts with `attachment`
    - expect: response body bytes equal the full test video object

#### 1.2. non-ready-video-returns-409

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-08T23:14:08Z

**Steps:**
  1. Owner GETs `/videos/:id/download` for a video with `status: processing`
    - expect: `409` status
    - expect: response body `error` is `VIDEO_NOT_READY`

#### 1.3. non-owner-returns-403

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-08T23:14:08Z

**Steps:**
  1. Non-owner GETs `/videos/:id/download` for a video (`status: ready`) belonging to the owner's channel
    - expect: `403` status
    - expect: response body `error` is `FORBIDDEN`
