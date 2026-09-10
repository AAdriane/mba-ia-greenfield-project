import type { DeepPartial } from 'typeorm';

/**
 * Builds a typed entity fixture from a partial literal.
 *
 * Unit tests only populate the fields the code under test actually reads.
 * Casting those literals with `as any` leaks an untyped value into every
 * assertion that follows; this helper confines the cast to one place and hands
 * back a value typed as the real entity, so the assertions stay checked.
 *
 * `DeepPartial` is used so nested relations can be partial too — a fixture for
 * a token normally carries only a couple of fields of its related user.
 */
export function fixture<T>(partial: DeepPartial<T>): T {
  return partial as T;
}
