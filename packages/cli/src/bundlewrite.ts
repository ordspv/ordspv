import { writeFileSync } from 'node:fs';

/**
 * Write a proven bundle to disk after the result it proves has been printed.
 * The caller prints first and writes second, so a failed write leaves the
 * result on stdout where a script can keep it. A failure comes back as a
 * message under the command's prefix, for the caller to put on stderr beside
 * a nonzero exit, so it cannot be confused with a walk failure; a landed
 * write returns undefined.
 */
export function writeBundleFile(
  command: string,
  path: string,
  bundle: unknown,
): string | undefined {
  try {
    writeFileSync(path, JSON.stringify(bundle, null, 2));
    return undefined;
  } catch (e) {
    return `${command}: cannot write bundle to ${path}: ${(e as Error).message}`;
  }
}
