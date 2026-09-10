import type * as Joi from 'joi';
import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  MINIO_ACCESS_KEY: 'access-key',
  MINIO_SECRET_KEY: 'secret-key',
};

/** Only the key this suite asserts on; Joi types `value` as `any` otherwise. */
interface ValidatedEnv {
  SWAGGER_ENABLED: string;
}

const validate = (
  env: Record<string, string>,
): Joi.ValidationResult<ValidatedEnv> =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const result = validate({});
    expect(result.error).toBeUndefined();
    // Narrows the ValidationResult union to its success member, where `value`
    // is typed; on the failure member Joi types it as `any`.
    if (result.error) return;
    expect(result.value.SWAGGER_ENABLED).toBe('false');
  });
});
