import { describe, expect, it } from 'vitest';
import { CustodyUnsupportedError, SatStepLimitError } from '@ordspv/core';
import { sharedDomainRefusal } from '../src/failover.js';

/**
 * The bookkeeping both build loops share. What it decides is whether a refusal
 * no backend contradicted may be reported in its own class, and how far the
 * message says that refusal reaches. Every configured backend lands in exactly
 * one of three groups, and a set that does not account for all of them is a
 * build failure rather than a refusal.
 */

const A = 'https://a.test';
const B = 'https://b.test';
const C = 'https://c.test';

const refusal = (baseUrl: string): { baseUrl: string; error: Error } => ({
  baseUrl,
  error: new CustodyUnsupportedError('fee-tail ancestry', 700_000),
});

describe('sharedDomainRefusal', () => {
  it('says one configured backend is one server\'s word', () => {
    const e = sharedDomainRefusal([refusal(A)], 1);
    expect(e?.unanimous).toBe(false);
    expect(e?.message).toMatch(new RegExp(`the single configured backend reported it: ${A}`));
    expect(e?.message).toMatch(/a second configured backend is what would make it more/);
    expect(e?.message).not.toMatch(/each configured backend/);
  });

  it('is unanimous only when two or more all reached it', () => {
    const both = sharedDomainRefusal([refusal(A), refusal(B)], 2);
    expect(both?.unanimous).toBe(true);
    expect(both?.message).toMatch(/each configured backend led an attempt that ended this way/);
  });

  it('names the two other groups with their causes, and says no more than that', () => {
    const e = sharedDomainRefusal(
      [refusal(A)],
      3,
      [{ baseUrl: B, error: new Error('HTTP 429') }],
      [C],
    );
    expect(e?.unanimous).toBe(false);
    expect(e?.message).toMatch(/1 of 3 configured backends/);
    expect(e?.message).toMatch(new RegExp(`1 produced no usable answer: ${B}: HTTP 429`));
    expect(e?.message).toMatch(new RegExp(`1 never led an attempt: ${C}`));
    // a backend that answered was never unreachable, and neither word is used
    expect(e?.message).not.toMatch(/could not be reached/);
  });

  it('declines to report anything the groups do not account for', () => {
    expect(sharedDomainRefusal([], 2, [{ baseUrl: A, error: new Error('x') }])).toBeUndefined();
    // A refused, B and C are unaccounted for
    expect(sharedDomainRefusal([refusal(A)], 3)).toBeUndefined();
    // one refusal each, in different classes
    expect(
      sharedDomainRefusal(
        [refusal(A), { baseUrl: B, error: new SatStepLimitError('too deep') }],
        2,
      ),
    ).toBeUndefined();
  });

  it('refuses a second call on the same error instance', () => {
    const once = [refusal(A), refusal(B)];
    const e = sharedDomainRefusal(once, 2);
    expect(e).toBeDefined();
    // the mutation is not idempotent: a second call would append a second
    // parenthetical and could flip the marker, so it is a caller bug
    expect(() => sharedDomainRefusal(once, 3, [], [C])).toThrow(
      /called twice on the same error instance/,
    );
    expect(e?.unanimous).toBe(true);
  });
});
