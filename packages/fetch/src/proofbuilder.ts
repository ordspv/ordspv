import {
  buildMerkleBranch,
  bytesToHex,
  hexToBytes,
  inscriptionsFromTx,
  parseBlock,
  parseTx,
  ZERO32,
  type InscriptionId,
  type ProofBundleJson,
} from '@ordspv/core';
import type { EsploraBlockInfo, EsploraMerkleProof, EsploraTxStatus } from './backends.js';

/**
 * Anything that can serve the proof ingredients. EsploraBackend satisfies this
 * structurally; so does the proof-sidecar's Bitcoin Core RPC backend. The
 * bundle builder is data-source agnostic.
 */
export interface ProofBackend {
  getTxStatus(txid: string): Promise<EsploraTxStatus>;
  getTxHex(txid: string): Promise<string>;
  getMerkleProof(txid: string): Promise<EsploraMerkleProof>;
  getHeaderHex(blockHash: string): Promise<string>;
  getBlockInfo(blockHash: string): Promise<EsploraBlockInfo>;
  getBlockRaw(blockHash: string): Promise<Uint8Array>;
}

/**
 * Assemble a proof bundle for an inscription from any proof backend.
 * Everything fetched here is UNTRUSTED input; the caller verifies the bundle
 * with `verifyProofBundle` afterwards; nothing here is trusted for soundness,
 * only availability. The JSON-served answers the bundle carries in checked
 * positions (the height and the block hash, and on L2 the txCount, the
 * position and the branch) are validated here as well: a backend serving
 * values the verifier would refuse fails its own attempt, under a message
 * naming the answer, so every rotating caller records the cause and asks the
 * next backend instead of dying at verification with the defect blamed on
 * the bundle. The header and every transaction come from text endpoints,
 * strings by transport, and their contents stay verification's job.
 *
 * L2 cost: 4 small requests (reveal hex, merkle proof, header, block info)
 *          + 1 for the commit tx.
 * L3 cost: 2 requests, one of which is the full raw block (~1-2 MB typical),
 *          from which both merkle branches and the coinbase are derived.
 */
export async function buildProofBundle(
  esplora: ProofBackend,
  id: InscriptionId,
  level: 'L2' | 'L3',
): Promise<ProofBundleJson> {
  const status = await esplora.getTxStatus(id.txid);
  if (!status.confirmed || !status.block_hash || status.block_height === undefined) {
    throw new Error(`reveal tx ${id.txid} is not confirmed`);
  }
  // the transport is a cast, not a validation, so a served value the
  // verifier would refuse must fail the build here, where rotation can act
  if (!Number.isInteger(status.block_height) || status.block_height < 0) {
    throw new Error(
      `reveal tx ${id.txid} status has no valid block height ` +
        `(got ${JSON.stringify(status.block_height)})`,
    );
  }
  if (typeof status.block_hash !== 'string') {
    throw new Error(
      `reveal tx ${id.txid} status has no valid block hash ` +
        `(got ${JSON.stringify(status.block_hash)})`,
    );
  }
  const blockHash = status.block_hash;
  const height = status.block_height;

  if (level === 'L2') {
    const [revealHex, proof, headerHex, blockInfo] = await Promise.all([
      esplora.getTxHex(id.txid),
      esplora.getMerkleProof(id.txid),
      esplora.getHeaderHex(blockHash),
      esplora.getBlockInfo(blockHash),
    ]);
    if (!Number.isInteger(blockInfo.tx_count) || blockInfo.tx_count < 1) {
      throw new Error(
        `block ${blockHash} info has no valid transaction count ` +
          `(got ${JSON.stringify(blockInfo.tx_count)})`,
      );
    }
    if (!Number.isInteger(proof.pos) || proof.pos < 0) {
      throw new Error(
        `merkle proof for ${id.txid} has no valid position (got ${JSON.stringify(proof.pos)})`,
      );
    }
    if (!Array.isArray(proof.merkle)) {
      throw new Error(
        `merkle proof for ${id.txid} has no valid branch (got ${JSON.stringify(proof.merkle)})`,
      );
    }
    const reveal = parseTx(hexToBytes(revealHex.trim()));
    const inscription = inscriptionsFromTx(reveal).find((i) => i.index === id.index);
    if (!inscription) {
      throw new Error(`no envelope at index ${id.index} in ${id.txid}`);
    }
    const input = reveal.inputs[inscription.input];
    const commitHex = await esplora.getTxHex(input.prevTxid);
    return {
      version: 1,
      inscriptionId: `${id.txid}i${id.index}`,
      level: 'L2',
      block: { height, hash: blockHash, header: headerHex.trim(), txCount: blockInfo.tx_count },
      reveal: { hex: revealHex.trim(), pos: proof.pos, txidBranch: proof.merkle },
      commit: { hex: commitHex.trim() },
    };
  }

  // L3: single raw-block fetch supplies header, coinbase, and both trees
  const raw = await esplora.getBlockRaw(blockHash);
  const block = parseBlock(raw);
  const pos = block.txs.findIndex((t) => t.txid === id.txid);
  if (pos === -1) throw new Error(`tx ${id.txid} not found in block ${blockHash}`);
  if (pos === 0) throw new Error('reveal tx cannot be the coinbase');

  const txids = block.txs.map((t) => t.txidLE);
  const wtxids = block.txs.map((t, i) => (i === 0 ? ZERO32 : t.wtxidLE));

  const toDisplay = (b: Uint8Array) => bytesToHex(b.slice().reverse());

  return {
    version: 1,
    inscriptionId: `${id.txid}i${id.index}`,
    level: 'L3',
    block: {
      height,
      hash: block.header.hash,
      header: bytesToHex(block.header.raw),
      txCount: block.txs.length,
    },
    reveal: {
      hex: bytesToHex(block.txs[pos].raw),
      pos,
      txidBranch: buildMerkleBranch(txids, pos).map(toDisplay),
    },
    witness: {
      coinbaseHex: bytesToHex(block.txs[0].raw),
      coinbaseTxidBranch: buildMerkleBranch(txids, 0).map(toDisplay),
      wtxidBranch: buildMerkleBranch(wtxids, pos).map(toDisplay),
    },
  };
}
