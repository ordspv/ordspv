import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  bytesToHex,
  extractTapscript,
  hexToBytes,
  inscriptionsFromTx,
  interpretEnvelope,
  parseEnvelopesFromScript,
  parseEnvelopesFromTx,
  parseTx,
  splitPayload,
} from '../src/index.js';

/**
 * Property fuzz for the envelope parser. Everything is driven by a fixed-seed
 * PRNG, so the corpus is fully reproducible; bump SEED variants deliberately,
 * never randomly. Properties:
 *
 *   1. parseEnvelopesFromScript is TOTAL over arbitrary bytes (never throws)
 *      and deterministic.
 *   2. interpretEnvelope/splitPayload are total over arbitrary payloads, and
 *      the body rule holds: body exists iff an even-indexed empty push exists,
 *      and equals the concatenation of everything after the first one.
 *   3. Tx-level: whatever parseTx accepts, envelope extraction never throws,
 *      and global index / per-input offset numbering is dense and ordered.
 *
 * Seeds include mutations of the REAL vendored tapscripts (inscription 0 +
 * every extended fixture) so the fuzz walks realistic envelope structures,
 * not just noise.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures');

const SEED = 0xd15ea5e;

/** mulberry32 — tiny deterministic PRNG */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const randInt = (rng: () => number, n: number) => Math.floor(rng() * n);

function randBytes(rng: () => number, maxLen: number): Uint8Array {
  const out = new Uint8Array(randInt(rng, maxLen + 1));
  for (let i = 0; i < out.length; i++) out[i] = randInt(rng, 256);
  return out;
}

/** one random structural mutation of a byte string */
function mutateBytes(src: Uint8Array, rng: () => number): Uint8Array {
  const op = randInt(rng, 5);
  const out = Uint8Array.from(src);
  if (src.length === 0) return randBytes(rng, 16);
  switch (op) {
    case 0: {
      out[randInt(rng, out.length)] ^= 1 << randInt(rng, 8);
      return out;
    }
    case 1:
      return out.slice(0, randInt(rng, out.length)); // truncate
    case 2: {
      const at = randInt(rng, out.length + 1);
      const ins = randBytes(rng, 4);
      return new Uint8Array([...out.slice(0, at), ...ins, ...out.slice(at)]);
    }
    case 3: {
      const from = randInt(rng, out.length);
      const len = randInt(rng, out.length - from) + 1;
      return new Uint8Array([...out.slice(0, from), ...out.slice(from + len)]); // delete span
    }
    default: {
      const at = randInt(rng, out.length);
      out.set(randBytes(rng, Math.min(8, out.length - at)), at);
      return out;
    }
  }
}

/** random scripts biased toward envelope grammar tokens */
function tokenSoup(rng: () => number): Uint8Array {
  const parts: number[] = [];
  const n = randInt(rng, 24) + 1;
  for (let i = 0; i < n; i++) {
    switch (randInt(rng, 11)) {
      case 0:
        parts.push(0x00); // empty push
        break;
      case 1:
        parts.push(0x63); // OP_IF
        break;
      case 2:
        parts.push(0x68); // OP_ENDIF
        break;
      case 3:
        parts.push(0x03, 0x6f, 0x72, 0x64); // push "ord"
        break;
      case 4: {
        const data = randBytes(rng, 12);
        parts.push(data.length || 0x00, ...data); // small direct push (0 => OP_0)
        break;
      }
      case 5:
        parts.push(0x4f + randInt(rng, 18)); // pushnum range (incl. 0x60)
        break;
      case 6:
        parts.push(0x4c, randInt(rng, 20)); // PUSHDATA1, possibly truncated data
        break;
      case 7:
        parts.push(randInt(rng, 256)); // arbitrary opcode byte
        break;
      case 8:
        parts.push(0x00, 0x63, 0x03, 0x6f, 0x72, 0x64); // envelope opener: OP_0 OP_IF "ord"
        break;
      case 9: {
        // complete little envelope, so the accepting path meets surrounding junk
        const body = randBytes(rng, 6);
        parts.push(0x00, 0x63, 0x03, 0x6f, 0x72, 0x64, 0x01, randInt(rng, 256), 0x00);
        parts.push(body.length || 0x00, ...body, 0x68);
        break;
      }
      default:
        parts.push(0x00, 0x63); // stutter fodder
        break;
    }
  }
  return new Uint8Array(parts);
}

/** stable snapshot of parse output for determinism comparison */
function snapshot(envs: ReturnType<typeof parseEnvelopesFromScript>): string {
  return JSON.stringify(
    envs.map((e) => ({
      pushnum: e.pushnum,
      stutter: e.stutter,
      payload: e.payload.map(bytesToHex),
    })),
  );
}

/** all tapscripts from the vendored real reveal txs */
function realTapscripts(): Uint8Array[] {
  const reveals: Uint8Array[] = [
    hexToBytes(readFileSync(join(FIXTURES, 'insc0/reveal.hex'), 'utf8').trim()),
  ];
  const ext = join(FIXTURES, 'extended');
  for (const f of readdirSync(ext).filter((f) => f.endsWith('.bundle.json'))) {
    const bundle = JSON.parse(readFileSync(join(ext, f), 'utf8'));
    reveals.push(hexToBytes(bundle.reveal.hex));
  }
  const scripts: Uint8Array[] = [];
  for (const raw of reveals) {
    for (const input of parseTx(raw).inputs) {
      const tapscript = extractTapscript(input.witness);
      if (tapscript) scripts.push(tapscript.script);
    }
  }
  return scripts;
}

function checkScriptProperties(script: Uint8Array): void {
  let envs;
  expect(() => {
    envs = parseEnvelopesFromScript(script);
  }, `parser threw on ${bytesToHex(script.slice(0, 64))}…`).not.toThrow();
  expect(snapshot(parseEnvelopesFromScript(script))).toBe(snapshot(envs!)); // deterministic
  for (const env of envs!) {
    expect(typeof env.pushnum).toBe('boolean');
    expect(typeof env.stutter).toBe('boolean');
    const insc = interpretEnvelope({ ...env, input: 0, offsetInInput: 0, index: 0 });
    expect(insc.unboundByEvenField).toBe(insc.flags.unrecognizedEvenField);
  }
}

describe('envelope parser fuzz (seeded, reproducible)', () => {
  it('is total and deterministic on random byte scripts', () => {
    const rng = mulberry32(SEED);
    checkScriptProperties(new Uint8Array(0));
    for (let i = 0; i < 400; i++) checkScriptProperties(randBytes(rng, 512));
  });

  it('is total and deterministic on envelope-token soup (and actually finds envelopes)', () => {
    const rng = mulberry32(SEED ^ 0x1);
    let found = 0;
    for (let i = 0; i < 400; i++) {
      const script = tokenSoup(rng);
      checkScriptProperties(script);
      found += parseEnvelopesFromScript(script).length;
    }
    // tripwire: the generator must exercise the accepting paths, not just reject
    expect(found).toBeGreaterThan(20);
  });

  it('is total and deterministic on mutations of real mainnet tapscripts', () => {
    const rng = mulberry32(SEED ^ 0x2);
    const scripts = realTapscripts();
    expect(scripts.length).toBeGreaterThanOrEqual(8);
    for (const script of scripts) {
      checkScriptProperties(script); // unmutated sanity
      for (let i = 0; i < 40; i++) checkScriptProperties(mutateBytes(script, rng));
    }
  });

  it('interpretEnvelope is total on random payloads and honors the body rule', () => {
    const rng = mulberry32(SEED ^ 0x3);
    for (let i = 0; i < 600; i++) {
      const payload: Uint8Array[] = [];
      const n = randInt(rng, 13);
      for (let j = 0; j < n; j++) {
        const kind = randInt(rng, 10);
        if (kind < 3) payload.push(new Uint8Array(0));
        else if (kind < 6) payload.push(new Uint8Array([randInt(rng, 256)]));
        else payload.push(randBytes(rng, 40));
      }

      const { fields, bodyChunks, incompleteField } = splitPayload(payload);
      let insc;
      expect(() => {
        insc = interpretEnvelope({
          input: 0,
          offsetInInput: 0,
          index: 0,
          payload,
          pushnum: false,
          stutter: false,
        });
      }).not.toThrow();

      // body rule: first even-indexed empty push separates fields from body
      let sep = -1;
      for (let j = 0; j < payload.length; j += 2) {
        if (payload[j].length === 0) {
          sep = j;
          break;
        }
      }
      if (sep === -1) {
        expect(bodyChunks).toBeUndefined();
        expect(insc!.body).toBeUndefined();
      } else {
        const expectedLen = payload.slice(sep + 1).reduce((a, c) => a + c.length, 0);
        expect(insc!.body!.length).toBe(expectedLen);
        expect(incompleteField).toBe(false);
      }
      expect(fields.length).toBeLessThanOrEqual(Math.floor(payload.length / 2));
      expect(incompleteField && bodyChunks !== undefined).toBe(false); // mutually exclusive
      for (const parent of insc!.parents) expect(parent).toMatch(/^[0-9a-f]{64}i\d+$/);
      if (insc!.pointer !== undefined) expect(typeof insc!.pointer).toBe('bigint');
    }
  });

  it('tx-level numbering stays dense and ordered across mutated reveal txs', () => {
    const rng = mulberry32(SEED ^ 0x4);
    const reveals: Uint8Array[] = [
      hexToBytes(readFileSync(join(FIXTURES, 'insc0/reveal.hex'), 'utf8').trim()),
    ];
    const ext = join(FIXTURES, 'extended');
    for (const f of readdirSync(ext).filter((f) => f.endsWith('.bundle.json'))) {
      reveals.push(hexToBytes(JSON.parse(readFileSync(join(ext, f), 'utf8')).reveal.hex));
    }

    let parsedOk = 0;
    for (const raw of reveals) {
      for (let i = 0; i < 30; i++) {
        const mutated = i === 0 ? raw : mutateBytes(raw, rng);
        let tx;
        try {
          tx = parseTx(mutated);
        } catch {
          continue; // tx layer may rightly reject mutated bytes
        }
        parsedOk++;
        let envs: ReturnType<typeof parseEnvelopesFromTx> | undefined;
        expect(() => {
          envs = parseEnvelopesFromTx(tx);
          inscriptionsFromTx(tx);
        }).not.toThrow();
        envs!.forEach((env, k) => {
          expect(env.index).toBe(k); // dense global numbering
          if (k > 0) expect(env.input).toBeGreaterThanOrEqual(envs![k - 1].input);
        });
        // per-input offsets are dense from 0
        const byInput = new Map<number, number[]>();
        for (const env of envs!) {
          const list = byInput.get(env.input) ?? [];
          list.push(env.offsetInInput);
          byInput.set(env.input, list);
        }
        for (const offsets of byInput.values()) {
          expect(offsets).toEqual(offsets.map((_, k) => k));
        }
      }
    }
    expect(parsedOk).toBeGreaterThan(8); // tripwire: some mutants must survive parseTx
  });
});
