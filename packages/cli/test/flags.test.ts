import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The argument surface itself: which commands accept which flags, and what a
 * value flag without its value does. Everything asserted here fails at the
 * argument parser or at a guard ahead of the command's work, so the CLI runs
 * for real, the way verifynote.test.ts runs it, and never opens a socket.
 * The commands that could reach a backend are pointed at a loopback port
 * nothing listens on, so a regression in a guard fails against connection
 * refused instead of a live server.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const MAIN = join(ROOT, 'packages/cli/src/main.ts');
const EXT = join(ROOT, 'fixtures/extended');

// a real inscription id, so parseOrdUri accepts it and the failure under test
// is the flag's rather than the argument's
const ID = '6dc2c16a74dedcae46300b2058ebadc7ca78aea78236459662375c8d7d9804dbi0';
const OFFLINE = ['--esplora', 'http://127.0.0.1:9'];

function run(args: string[]): { status: number | null; stderr: string } {
  const r = spawnSync('npx', ['tsx', MAIN, ...args], { cwd: ROOT, encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr };
}

describe('--timeout-ms', () => {
  it('is refused on parse, which opens no socket', () => {
    const r = run(['parse', ID, '--timeout-ms', '5000']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--timeout-ms applies to the network commands/);
  });

  it('is refused on verify, which reads a file', () => {
    const r = run(['verify', join(EXT, `${ID}.bundle.json`), '--timeout-ms', '5000']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--timeout-ms applies to the network commands/);
  });

  // validated the way --max-hops and --max-steps are; the failure fires while
  // the option object is being built, ahead of any request
  it('refuses a non-positive value where the flag does apply', () => {
    const r = run(['custody', ID, ...OFFLINE, '--timeout-ms', '0']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/custody: --timeout-ms must be a positive integer/);
  });
});

describe('--max-steps placement', () => {
  // sat bounds its funding walk with it and verify bounds its read of a
  // genealogy bundle; custody bounds nothing with it, and the mirror-image
  // mistake, --max-hops outside custody, is already refused at exit 2
  it('is refused on custody instead of being silently ignored', () => {
    const r = run(['custody', ID, ...OFFLINE, '--max-steps', '10']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--max-steps applies to the sat and verify commands/);
  });
});

describe('a value flag followed by another flag', () => {
  // parseArgs reads `--max-steps --json` as boolean true, str() turns that
  // into undefined, and the command would run at the default cap the caller
  // believed they had raised
  it('refuses --max-steps with its value swallowed', () => {
    const r = run(['sat', ID, ...OFFLINE, '--max-steps', '--json']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--max-steps needs a value/);
  });

  // the same silent default changes what the build fetches: a bare
  // --witness-section falls through to when-needed
  it('refuses --witness-section with its value swallowed', () => {
    const r = run(['custody', ID, ...OFFLINE, '--witness-section', '--json']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--witness-section needs a value/);
  });
});
