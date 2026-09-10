import type { Response } from 'supertest';
import type { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';

/**
 * supertest types `Response.body` as `any`. Reading it directly leaks that
 * `any` into every assertion, which the project's type-safety lint rules
 * reject. These helpers narrow the body once, at the single point where the
 * untyped value enters the test, so assertions stay typed.
 */
export function bodyOf<T>(res: Response): T {
  return res.body as T;
}

/** Narrows a response body to the API's standard error envelope. */
export function errorBody(res: Response): ApiErrorEnvelope {
  return bodyOf<ApiErrorEnvelope>(res);
}
