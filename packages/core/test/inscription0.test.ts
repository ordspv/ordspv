import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  bytesEqual,
  bytesToHex,
  checkProofOfWork,
  displayToInternal,
  hexToBytes,
  inscriptionsFromTx,
  parseHeader,
  parseTx,
  sha256,
  verifyMerkleBranch,
  verifyScriptPathCommitment,
  extractTapscript,
} from '../src/index.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/insc0');

function fixtureHex(name: string): Uint8Array {
  return hexToBytes(readFileSync(join(FIXTURES, name), 'utf8').trim());
}
const expected = JSON.parse(readFileSync(join(FIXTURES, 'expected.json'), 'utf8'));
const merkleProof = JSON.parse(readFileSync(join(FIXTURES, 'merkle-proof.json'), 'utf8'));

/**
 * End-to-end checks against inscription 0 — the genesis inscription — using
 * real mainnet bytes vendored in fixtures/. Every fixture is verified
 * cryptographically here, so fixture corruption cannot pass silently.
 */
describe('inscription 0 (real mainnet data)', () => {
  const reveal = parseTx(fixtureHex('reveal.hex'));
  const commit = parseTx(fixtureHex('commit.hex'));
  const header = parseHeader(fixtureHex('header-767430.hex'));

  it('reveal tx hashes to the inscription txid', () => {
    expect(reveal.txid).toBe(expected.revealTxid);
    expect(reveal.hasWitness).toBe(true);
    expect(reveal.inputs.length).toBe(1);
  });

  it('commit tx hashes to the outpoint the reveal spends', () => {
    expect(commit.txid).toBe(expected.commitTxid);
    expect(reveal.inputs[0].prevTxid).toBe(commit.txid);
    expect(reveal.inputs[0].vout).toBe(0);
  });

  it('block header hashes to the known block hash and satisfies PoW', () => {
    expect(header.hash).toBe(expected.blockHash);
    expect(header.time).toBe(expected.blockTime);
    expect(checkProofOfWork(header)).toBe(true);
  });

  it('esplora merkle proof links the reveal txid to the header merkle root', () => {
    // esplora serves display-order hashes; convert to internal order to fold
    const branch = (merkleProof.merkle as string[]).map(displayToInternal);
    const { root } = verifyMerkleBranch(reveal.txidLE, branch, merkleProof.pos);
    expect(bytesEqual(root, header.merkleRootLE)).toBe(true);
  });

  it('tampered txid fails the merkle proof', () => {
    const branch = (merkleProof.merkle as string[]).map(displayToInternal);
    const badLeaf = reveal.txidLE.slice();
    badLeaf[0] ^= 0xff;
    const { root } = verifyMerkleBranch(badLeaf, branch, merkleProof.pos);
    expect(bytesEqual(root, header.merkleRootLE)).toBe(false);
  });

  it('BIP-341: tapscript is committed by the commit output key', () => {
    const tapscript = extractTapscript(reveal.inputs[0].witness);
    expect(tapscript).toBeDefined();
    const spk = commit.outputs[reveal.inputs[0].vout].scriptPubKey;
    const check = verifyScriptPathCommitment({
      script: tapscript!.script,
      controlBlock: tapscript!.controlBlock,
      scriptPubKey: spk,
    });
    expect(check.outputKey.length).toBe(32);
  });

  it('BIP-341: a tampered script fails the commitment', () => {
    const tapscript = extractTapscript(reveal.inputs[0].witness)!;
    const badScript = tapscript.script.slice();
    badScript[badScript.length - 1] ^= 0x01;
    const spk = commit.outputs[reveal.inputs[0].vout].scriptPubKey;
    expect(() =>
      verifyScriptPathCommitment({
        script: badScript,
        controlBlock: tapscript.controlBlock,
        scriptPubKey: spk,
      }),
    ).toThrow(/mismatch/);
  });

  it('envelope parses to inscription 0: image/png, 793 bytes', () => {
    const inscriptions = inscriptionsFromTx(reveal);
    expect(inscriptions.length).toBe(1);
    const insc = inscriptions[0];
    expect(insc.index).toBe(0);
    expect(insc.contentType).toBe(expected.contentType);
    expect(insc.body?.length).toBe(expected.contentLength);
    // PNG magic + IEND trailer
    expect(bytesToHex(insc.body!.slice(0, 8))).toBe('89504e470d0a1a0a');
    expect(bytesToHex(insc.body!.slice(-8))).toBe('49454e44ae426082');
    expect(insc.delegate).toBeUndefined();
    expect(insc.parents).toEqual([]);
    expect(insc.pointer).toBeUndefined();
    expect(insc.flags.unrecognizedEvenField).toBe(false);
    expect(insc.flags.duplicateField).toBe(false);
  });

  it('records the content hash for cross-checking against live gateways', () => {
    const [insc] = inscriptionsFromTx(reveal);
    const hash = bytesToHex(sha256(insc.body!));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // stash for humans reading test output
    // eslint-disable-next-line no-console
    console.info(`inscription 0 content sha256: ${hash}`);
  });
});
