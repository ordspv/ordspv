/**
 * What the CLI prints beside a result, and how it classifies a refusal.
 *
 * The sentences themselves live in `@ordspv/core` (notes.ts) so every surface
 * says the same thing in the same words, and the class-to-code mapping lives
 * in the taxonomy table (`taxonomy.ts` here, facts in `@ordspv/fetch`), so a
 * refusal class without a row fails to compile. What lives in this module is
 * the rendering: which sentences a given result carries, and how a table row
 * becomes one report object that both output channels read. Both `verify` and
 * `resolve` call these, so the two commands cannot drift.
 */

import { L2_EXECUTED_LEAF_RESIDUAL, L2_NUMBERING_RESIDUAL } from '@ordspv/core';
import { CustodyError, SatIdentityError } from '@ordspv/fetch';
import {
  CATEGORY_EXIT_CODES,
  REFUSAL_TABLE,
  WRAPPER_TABLE,
  type RefusalCategory,
  type RefusalContext,
} from './taxonomy.js';

export type { RefusalContext } from './taxonomy.js';

/**
 * The residual sentences a content-path result carries. Below L3 the binding
 * proves commitment and not execution, and a multi-input reveal additionally
 * leaves the envelope numbering unproven, which is the one thing a gateway can
 * rewrite with no help from the inscriber.
 */
export function contentResiduals(
  level: string,
  l2?: { singleInputReveal: boolean },
): string[] {
  if (level === 'L3') return [];
  const out = [L2_EXECUTED_LEAF_RESIDUAL];
  if (l2 && !l2.singleInputReveal) out.push(L2_NUMBERING_RESIDUAL);
  return out;
}

/**
 * How a command reports a refusal that is not a forgery. One object serves
 * both output channels: the human channel prints `message` and exits `code`,
 * and the JSON channel is the typed projection `refusalJson` makes of the
 * same fields, so the two channels cannot disagree about the code, the class
 * name, or the note.
 */
export interface RefusalReport {
  /** the whole line, prefix included, as `fail()` takes it */
  message: string;
  /** process exit code */
  code: number;
  /** the error class's own name, which is what the JSON channel discriminates on */
  name: string;
  /** the remedy sentence on its own, for the JSON channel */
  note: string;
  /** the error's own message, no prefix and no note, which the JSON channel prints */
  detail: string;
}

/**
 * The sentence a refusal short of every configured backend carries. A build
 * that no backend answered with a bundle reports the refusal it does have, and
 * the reader has to be told what stood behind it. One configured backend is
 * that case too: a single server agreeing with itself is one server's word.
 */
const PARTIAL_ANSWER =
  `A refusal is the chain's answer only when two or more configured backends all ` +
  `reach it, which did not happen here; the message says what each one did, and ` +
  `--esplora names others.`;

/**
 * The prefix a category renders in each context. Only the offline UNPROVEN
 * form carries the word offline, because that is the one case where the same
 * fact might still be provable live.
 */
function refusalPrefix(category: RefusalCategory, context: RefusalContext, command: string): string {
  if (context === 'live') return `${command} ${category}: `;
  return category === 'UNPROVEN' ? 'bundle UNPROVEN offline: ' : `bundle ${category}: `;
}

/**
 * Classify what a verification or a live build threw, by reading the taxonomy
 * table. A row's category decides the prefix and the exit code together, the
 * row's note is the remedy sentence for the reporting context, and the
 * wrapper errors go through the second table keyed on their code string.
 *
 * The reporting context decides which category a row asserts, since a class a
 * verifier raises about a bound document can mean something else when a build
 * loop raises it about a witness nothing has bound. How far a live refusal
 * reaches decides between that category and `nonUnanimousCategory`: a build
 * loop marks the refusal it rethrows with `unanimous`, and a refusal that only
 * the backends that answered stand behind carries the partial-answer sentence.
 * A missing marker, which is every refusal a verifier raises, reports the
 * context's own category.
 *
 * Returns undefined for everything else, the wrapper VERIFY_FAILED code
 * included: a document that failed verification is the caller's own invalid
 * path at exit 1, which each command prefixes for itself.
 */
export function refusalReport(
  e: unknown,
  context: RefusalContext,
  command = '',
): RefusalReport | undefined {
  // how far a refusal reached is a build-loop fact, so the weaker reading
  // applies in the live context alone: `sharedDomainRefusal` writes the marker
  // and a refusal a verifier raised never carries one
  const partial = context === 'live' && (e as { unanimous?: boolean }).unanimous === false;
  const unanimous = !partial;
  let category: RefusalCategory | undefined;
  let note: string | undefined;
  for (const row of Object.values(REFUSAL_TABLE)) {
    if (e instanceof row.ctor) {
      // the context decides which category the class asserts, since the same
      // class can refuse a document in one phase and one server's word in
      // another
      category = partial ? row.nonUnanimousCategory : row.category[context];
      note =
        partial && row.nonUnanimousNote !== undefined ? row.nonUnanimousNote : row.note[context];
      break;
    }
  }
  if (category === undefined || note === undefined) {
    if (!(e instanceof CustodyError || e instanceof SatIdentityError)) return undefined;
    const row = WRAPPER_TABLE[e.code];
    if (row.category === 'INVALID') return undefined;
    category = row.category;
    note = row.note;
  }
  const detail = (e as Error).message;
  const full = unanimous ? note : `${note} ${PARTIAL_ANSWER}`;
  return {
    message: `${refusalPrefix(category, context, command)}${detail}. ${full}`,
    code: CATEGORY_EXIT_CODES[category],
    name: (e as Error).name,
    note: full,
    detail,
  };
}

/**
 * What the JSON channel prints: a typed projection of the same report the
 * human channel renders, so a field here must name a `RefusalReport` field or
 * fail to compile, and the two channels cannot disagree. A failure with no
 * mapping carries the same shape, so a caller parses one thing, and it
 * reports the class's own name rather than the literal `Error`: the name
 * costs nothing and is strictly more than a caller had before.
 */
interface RefusalJsonBody {
  ok: false;
  error: RefusalReport['name'];
  message: RefusalReport['detail'];
  note: RefusalReport['note'] | undefined;
}

/** The one-line JSON a `--json` caller reads on a refusal. */
export function refusalJson(e: unknown, report: RefusalReport | undefined): string {
  const body: RefusalJsonBody = report
    ? { ok: false, error: report.name, message: report.detail, note: report.note }
    : { ok: false, error: (e as Error).name, message: (e as Error).message, note: undefined };
  return JSON.stringify(body);
}
