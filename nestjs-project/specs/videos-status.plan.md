---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.9
target_file: nestjs-project/test/videos.e2e-spec.ts
---

# GET /videos/:id Test Plan

## Application Overview

`GET /videos/:id` lets the owning channel poll the current processing status of a video (`draft`, `uploaded`, `processing`, `ready`, or `error`) along with its duration once available, restricted to the video's owning channel per the owner-only access policy of this phase.

## Test Scenarios

### 1. GET /videos/:id

**Setup:** `beforeAll` bootstraps `AppModule` via `Test.createTestingModule` and reproduces `main.ts` global config; seed two authenticated users each with their own channel (owner and non-owner) via the existing auth/channels E2E helpers. Before each scenario, insert a `Video` row directly for the owner's channel with a known `status`. `afterEach` truncates the `videos` table.

#### 1.1. owner-returns-200-with-current-status

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-08T23:14:08Z

**Steps:**
  1. Owner GETs `/videos/:id` for a video belonging to their own channel
    - expect: `200` status
    - expect: response body has `id`, `status` equal to the seeded status, `durationSeconds`, and `createdAt`

#### 1.2. non-owner-returns-403

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-08T23:14:08Z

**Steps:**
  1. Non-owner GETs `/videos/:id` for a video belonging to the owner's channel
    - expect: `403` status
    - expect: response body `error` is `FORBIDDEN`

#### 1.3. nonexistent-video-returns-404

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-08T23:14:08Z

**Steps:**
  1. Owner GETs `/videos/<random-uuid>` for an id that does not exist
    - expect: `404` status
    - expect: response body `error` is `VIDEO_NOT_FOUND`
