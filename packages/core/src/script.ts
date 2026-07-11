/**
 * Minimal Bitcoin script instruction iterator — just enough to walk tapscripts
 * and extract data pushes for inscription envelope parsing.
 */

export const OP_0 = 0x00; // aka OP_FALSE, pushes empty
export const OP_PUSHDATA1 = 0x4c;
export const OP_PUSHDATA2 = 0x4d;
export const OP_PUSHDATA4 = 0x4e;
export const OP_1NEGATE = 0x4f;
export const OP_1 = 0x51;
export const OP_16 = 0x60;
export const OP_IF = 0x63;
export const OP_ENDIF = 0x68;

export interface ScriptOp {
  /** opcode byte */
  opcode: number;
  /** present for data pushes (including OP_0 => empty bytes) */
  data?: Uint8Array;
  /** byte offset of this instruction in the script */
  offset: number;
}

/**
 * Iterate script instructions. Returns ops until the end of the script.
 * Mirrors rust-bitcoin's non-minimal `Script::instructions()` (the iterator
 * ord's envelope parser uses): a truncated push is an error (throws here),
 * non-minimal push encodings are accepted, and every non-push byte — valid,
 * reserved, or invalid opcode alike — is yielded as an opcode instruction.
 */
export function parseScript(script: Uint8Array): ScriptOp[] {
  const ops: ScriptOp[] = [];
  let i = 0;
  while (i < script.length) {
    const offset = i;
    const opcode = script[i++];
    if (opcode === OP_0) {
      ops.push({ opcode, data: new Uint8Array(0), offset });
    } else if (opcode >= 0x01 && opcode <= 0x4b) {
      ops.push({ opcode, data: take(script, i, opcode), offset });
      i += opcode;
    } else if (opcode === OP_PUSHDATA1) {
      const len = at(script, i);
      i += 1;
      ops.push({ opcode, data: take(script, i, len), offset });
      i += len;
    } else if (opcode === OP_PUSHDATA2) {
      const len = at(script, i) | (at(script, i + 1) << 8);
      i += 2;
      ops.push({ opcode, data: take(script, i, len), offset });
      i += len;
    } else if (opcode === OP_PUSHDATA4) {
      const len =
        at(script, i) | (at(script, i + 1) << 8) | (at(script, i + 2) << 16) | (at(script, i + 3) << 24);
      if (len < 0) throw new Error('push length overflow');
      i += 4;
      ops.push({ opcode, data: take(script, i, len), offset });
      i += len;
    } else {
      // non-push opcode (includes OP_1..OP_16, OP_1NEGATE — ord treats these
      // as opcodes, not data pushes, inside envelopes)
      ops.push({ opcode, offset });
    }
  }
  return ops;
}

function at(script: Uint8Array, i: number): number {
  if (i >= script.length) throw new Error('script truncated');
  return script[i];
}

function take(script: Uint8Array, i: number, len: number): Uint8Array {
  if (i + len > script.length) throw new Error('script push overruns end');
  return script.slice(i, i + len);
}
