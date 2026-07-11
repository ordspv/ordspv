#!/usr/bin/env tsx
import { readFileSync, writeFileSync } from 'node:fs';
import { verifyProofBundle, type ProofBundleJson } from '@ordspv/core';
import {
  buildProofBundle,
  EsploraBackend,
  OrdResolver,
  parseOrdUri,
  DEFAULT_ESPLORA,
  type VerificationMode,
} from '@ordspv/fetch';

/**
 * ord-resolve — resolve and verify ord: URIs from the command line.
 *
 *   ord-resolve <uri>                          resolve, bytes to stdout
 *   ord-resolve <uri> --out file.png           resolve to a file
 *   ord-resolve <uri> --json                   resolution report as JSON
 *   ord-resolve <uri> --verify none|L1|L2|L3   verification level (default L2)
 *   ord-resolve proof <id> [--level L2|L3]     emit a proof bundle
 *   ord-resolve verify <bundle.json>           verify a bundle offline
 *   ord-resolve parse <uri>                    normalize/inspect a URI
 *
 * Options: --esplora url[,url]   --gateway url[,url]
 */

interface Args {
  positional: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, true);
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function fail(message: string, code = 1): never {
  console.error(`error: ${message}`);
  process.exit(code);
}

function str(v: string | boolean | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  if (positional.length === 0 || flags.has('help')) {
    console.error(
      [
        'usage:',
        '  ord-resolve <uri> [--verify none|L1|L2|L3] [--out FILE] [--json]',
        '  ord-resolve proof <inscription-id> [--level L2|L3]',
        '  ord-resolve verify <bundle.json>',
        '  ord-resolve parse <uri>',
        'options: --esplora url[,url]  --gateway url[,url]',
      ].join('\n'),
    );
    process.exit(positional.length === 0 ? 2 : 0);
  }

  const esplora = str(flags.get('esplora'))?.split(',') ?? DEFAULT_ESPLORA;
  const gateways = str(flags.get('gateway'))?.split(',');

  const [command] = positional;

  if (command === 'parse') {
    const uri = positional[1] ?? fail('parse: missing uri', 2);
    console.log(JSON.stringify(parseOrdUri(uri), (_, v) => (v instanceof Uint8Array ? undefined : v), 2));
    return;
  }

  if (command === 'proof') {
    const idArg = positional[1] ?? fail('proof: missing inscription id', 2);
    const level = (str(flags.get('level'))?.toUpperCase() ?? 'L2') as 'L2' | 'L3';
    if (level !== 'L2' && level !== 'L3') fail('proof: --level must be L2 or L3', 2);
    const parsed = parseOrdUri(idArg);
    const errors: string[] = [];
    for (const base of esplora) {
      try {
        const bundle = await buildProofBundle(new EsploraBackend(base), parsed.id, level);
        console.log(JSON.stringify(bundle, null, 2));
        return;
      } catch (e) {
        errors.push(`${base}: ${(e as Error).message}`);
      }
    }
    fail(`could not build proof:\n${errors.join('\n')}`);
  }

  if (command === 'verify') {
    const file = positional[1] ?? fail('verify: missing bundle file', 2);
    const bundle = JSON.parse(readFileSync(file, 'utf8')) as ProofBundleJson;
    try {
      const result = verifyProofBundle(bundle);
      console.log(
        JSON.stringify(
          {
            ok: true,
            level: result.level,
            inscriptionId: result.inscriptionId,
            block: result.header.hash,
            height: result.height,
            contentType: result.inscription.contentType,
            contentLength: result.inscription.body?.length ?? 0,
            l2Assurances: result.l2,
            note: 'header PoW verified; anchor the block hash against your own chain view',
          },
          null,
          2,
        ),
      );
      return;
    } catch (e) {
      fail(`bundle INVALID: ${(e as Error).message}`);
    }
  }

  // default: resolve <uri>
  const uri = command;
  const verification = (str(flags.get('verify')) ?? 'L2') as VerificationMode;
  if (!['none', 'L1', 'L2', 'L3'].includes(verification)) fail('--verify must be none|L1|L2|L3', 2);

  const resolver = new OrdResolver({ esplora, ordGateways: gateways, verification });
  try {
    const result = await resolver.resolve(uri);
    if (flags.has('json')) {
      console.log(
        JSON.stringify(
          {
            uri: result.uri.canonical,
            contentType: result.contentType,
            contentEncoding: result.contentEncoding,
            decoded: result.decoded,
            bytes: result.body.length,
            viaDelegate: result.viaDelegate,
            metadataJson: result.metadataJson,
            verification: result.verification,
          },
          null,
          2,
        ),
      );
    }
    const out = str(flags.get('out'));
    if (out) {
      writeFileSync(out, result.body);
      console.error(`wrote ${result.body.length} bytes to ${out} [${result.verification.level}]`);
    } else if (!flags.has('json')) {
      process.stdout.write(result.body);
      console.error(
        `\n[${result.verification.level}] ${result.contentType ?? 'application/octet-stream'} ` +
          `${result.body.length} bytes  block=${result.verification.blockHash ?? '-'}`,
      );
    }
  } catch (e) {
    fail((e as Error).message);
  }
}

main().catch((e) => fail(e?.stack ?? String(e)));
