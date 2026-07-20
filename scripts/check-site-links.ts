#!/usr/bin/env tsx
/**
 * Internal-link check over an assembled static site (default: _site).
 *
 * Every href/src in every .html file that points WITHIN the site must resolve
 * to a file that exists in the tree, so a typedoc layout change, a moved
 * example, or a landing-page typo cannot silently 404 after deploy
 * (pages.yml runs this between assembling _site and uploading it).
 *
 * Rules:
 *   - external references (any scheme, protocol-relative //) are ignored
 *   - fragment-only links (#…) are ignored; ?query/#fragment are stripped
 *   - root-absolute paths (/…) are errors outright: the site serves under a
 *     project-page prefix (ordspv.github.io/ordspv/), where they 404
 *   - a link resolving to a directory must contain an index.html
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve, dirname, sep } from 'node:path';

const root = resolve(process.argv[2] ?? '_site');

function htmlFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return htmlFiles(full);
    return entry.name.endsWith('.html') ? [full] : [];
  });
}

const ATTR = /\b(?:href|src)\s*=\s*("([^"]*)"|'([^']*)')/gi;

let checked = 0;
const problems: string[] = [];

for (const file of htmlFiles(root)) {
  const html = readFileSync(file, 'utf8');
  const rel = file.slice(root.length + 1);
  for (const match of html.matchAll(ATTR)) {
    const raw = (match[2] ?? match[3]).trim();
    if (raw === '' || raw.startsWith('#')) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) continue; // external
    checked++;
    if (raw.startsWith('/')) {
      problems.push(`${rel}: root-absolute "${raw}" breaks under the /ordspv/ project-page prefix`);
      continue;
    }
    let path = raw.split(/[?#]/, 1)[0];
    try {
      path = decodeURIComponent(path);
    } catch {
      problems.push(`${rel}: undecodable link "${raw}"`);
      continue;
    }
    let target = resolve(dirname(file), path);
    if (target !== root && !target.startsWith(root + sep)) {
      problems.push(`${rel}: "${raw}" escapes the site root`);
      continue;
    }
    if (existsSync(target) && statSync(target).isDirectory()) target = join(target, 'index.html');
    if (!existsSync(target)) {
      problems.push(`${rel}: "${raw}" does not resolve to a file`);
    }
  }
}

if (problems.length > 0) {
  console.error(`${problems.length} broken internal link(s) in ${root}:`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log(`internal links OK: ${checked} checked across ${htmlFiles(root).length} html file(s) in ${root}`);
