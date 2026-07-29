import { describe, expect, it } from 'vitest';
import * as core from '@ordspv/core';
import * as fetchPkg from '@ordspv/fetch';
import {
  CoinbaseHeightUnprovenError,
  CustodyUnsupportedError,
  EnvelopeIndexUnprovenError,
  SatPositionError,
  SatStepLimitError,
} from '@ordspv/core';
import {
  isRecordableBuildRefusal,
  REFUSAL_CLASS_FACTS,
  WitnessSectionUnavailableError,
} from '@ordspv/fetch';
import {
  CATEGORY_EXIT_CODES,
  EXCLUDED_ERRORS,
  REFUSAL_TABLE,
  WRAPPER_ERRORS,
  WRAPPER_TABLE,
} from '../src/taxonomy.js';

/**
 * The refusal taxonomy is one table, and what tsc cannot check is checked
 * here. The Record keys make a missing row a compile error, but nothing at
 * compile time notices an error class exported from core or fetch that never
 * reaches the CLI at all, or a row whose constructor belongs to another key.
 */

/** every exported class whose prototype chain reaches Error */
function errorExports(mod: Record<string, unknown>): [string, Function][] {
  return Object.entries(mod).filter(
    (entry): entry is [string, Function] =>
      typeof entry[1] === 'function' && entry[1].prototype instanceof Error,
  );
}

describe('refusal taxonomy coverage', () => {
  it('accounts for every error class exported from core and fetch', () => {
    const covered = new Set<Function>([
      ...Object.values(REFUSAL_TABLE).map((row) => row.ctor),
      ...WRAPPER_ERRORS,
      ...EXCLUDED_ERRORS.map((entry) => entry.ctor),
    ]);
    const unaccounted = [...errorExports(core), ...errorExports(fetchPkg)]
      .filter(([, ctor]) => !covered.has(ctor))
      .map(([name]) => name);
    expect(unaccounted).toEqual([]);
  });

  it('binds each row to the class its key names, in both tables', () => {
    for (const [name, row] of Object.entries(REFUSAL_TABLE)) {
      expect(row.ctor.name).toBe(name);
      // the CLI row and the fetch facts row describe one class
      expect(REFUSAL_CLASS_FACTS[name as keyof typeof REFUSAL_CLASS_FACTS].ctor).toBe(row.ctor);
    }
    for (const entry of EXCLUDED_ERRORS) {
      // an excluded class must not also have a row
      expect(Object.values(REFUSAL_TABLE).map((r) => r.ctor)).not.toContain(entry.ctor);
    }
  });

  it('maps each category to the exit code the CLI documents', () => {
    expect(CATEGORY_EXIT_CODES).toEqual({
      UNPROVEN: 3,
      'OUT OF SCOPE': 4,
      INCOMPLETE: 5,
      INVALID: 1,
    });
    expect(WRAPPER_TABLE.BUILD_FAILED.category).toBe('INCOMPLETE');
    expect(WRAPPER_TABLE.HEADER_TRUST.category).toBe('UNPROVEN');
    expect(WRAPPER_TABLE.VERIFY_FAILED.category).toBe('INVALID');
  });

  it('names the flag that changes the outcome wherever one exists', () => {
    expect(REFUSAL_TABLE.EnvelopeIndexUnprovenError.note.verify).toMatch(/--witness-section/);
    expect(REFUSAL_TABLE.EnvelopeIndexUnprovenError.note.live).toMatch(/--witness-section/);
    expect(REFUSAL_TABLE.SatStepLimitError.note.verify).toMatch(/--max-steps/);
    expect(REFUSAL_TABLE.SatStepLimitError.note.live).toMatch(/--max-steps/);
    expect(REFUSAL_TABLE.CoinbaseHeightUnprovenError.note.live).toMatch(/--anchor-source/);
    expect(REFUSAL_TABLE.WitnessSectionUnavailableError.note.live).toMatch(/--esplora/);
    const buildFailed = WRAPPER_TABLE.BUILD_FAILED;
    if (buildFailed.category !== 'INVALID') expect(buildFailed.note).toMatch(/--esplora/);
    const headerTrust = WRAPPER_TABLE.HEADER_TRUST;
    if (headerTrust.category !== 'INVALID') expect(headerTrust.note).toMatch(/--anchor-source/);
  });
});

describe('the build-time rotate predicate', () => {
  it('records exactly the classes whose deciding data the txid does not commit', () => {
    expect(isRecordableBuildRefusal(new CustodyUnsupportedError('x'))).toBe(true);
    expect(isRecordableBuildRefusal(new SatStepLimitError('x'))).toBe(true);
    expect(isRecordableBuildRefusal(new WitnessSectionUnavailableError('x'))).toBe(true);
    // no builder raises the class today; the row says what would hold if one did
    expect(isRecordableBuildRefusal(new CoinbaseHeightUnprovenError('x'))).toBe(true);
    // the input count is inside the txid, so the loops rethrow rather than rotate
    expect(isRecordableBuildRefusal(new EnvelopeIndexUnprovenError('x'))).toBe(false);
    // rotated by name at the loops, deliberately outside the table
    expect(isRecordableBuildRefusal(new SatPositionError('x'))).toBe(false);
    expect(isRecordableBuildRefusal(new Error('x'))).toBe(false);
    expect(isRecordableBuildRefusal(undefined)).toBe(false);
  });
});
