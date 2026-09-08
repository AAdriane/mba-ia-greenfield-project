---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.6
target_file: nestjs-project/test/videos.e2e-spec.ts
---

# POST /videos Test Plan

## Application Overview

`POST /videos` starts the upload flow: it creates a `Video` row as a `draft` for the authenticated user's channel and initiates a multipart upload on the object storage, returning the `uploadId`, `partSize`, and one presigned `UploadPart` URL per part so the client can upload the file directly to storage without proxying bytes through the API.

## Test Scenarios

### 1. POST /videos

**Setup:** `beforeAll` bootstraps `AppModule` via `Test.createTestingModule` and reproduces `main.ts` global config (`ValidationPipe({ whitelist: true })`); seed one authenticated owner user with a channel via the existing auth/channels E2E helpers to obtain a bearer token. `afterEach` truncates the `videos` table (`dataSource.query('DELETE FROM videos')`).

#### 1.1. valid-payload-returns-201-with-upload-parts

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-08T23:14:08Z

**Steps:**
  1. Authenticated owner POSTs `/videos` with a valid body (`fileName`, `fileSizeBytes` within the 10GB limit, `mimeType` starting with `video/`)
    - expect: `201` status
    - expect: response body has `id` (uuid), `uploadId` (string), `partSize` (number), `parts` (array of `{ partNumber, url }`, one entry per computed part)

#### 1.2. file-size-over-limit-returns-400

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-08T23:14:08Z

**Steps:**
  1. Authenticated owner POSTs `/videos` with `fileSizeBytes` greater than `10737418240` (10GB)
    - expect: `400` status
    - expect: response body is a validation error (per the project's error envelope `{ statusCode, error, message }`)

#### 1.3. invalid-mime-type-returns-400

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-08T23:14:08Z

**Steps:**
  1. Authenticated owner POSTs `/videos` with `mimeType: 'application/pdf'` (does not start with `video/`)
    - expect: `400` status
    - expect: response body `error` is `INVALID_MIME_TYPE`

#### 1.4. created-video-persists-with-draft-status

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-08T23:14:08Z

**Steps:**
  1. Authenticated owner POSTs `/videos` with a valid payload
    - expect: `201` status
  2. Query the `videos` table for the returned `id`
    - expect: the persisted row has `status: 'draft'` and `channel_id` equal to the authenticated user's channel
