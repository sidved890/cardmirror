/**
 * External-insert primitive — backs the `POST /insert` endpoint
 * defined in `reference-docs/fdp-integration-f2-fix-note.md` / the
 * Fast Debate Paste integration spec (§4.2).
 *
 * Wire-contract goal: reproduce the observable result of the
 * keystroke bridge's "Return + F2 paste plain text" sequence (for
 * `newParagraph: true`) or "F2 paste plain text inline" (for
 * `newParagraph: false`), in ONE transaction so a single Cmd-Z
 * removes the whole insert.
 *
 *   - `newParagraph: true` — split `text` on `\r\n` / `\n` / `\r`,
 *     build a closed-start / open-end Slice of body paragraphs
 *     (`card_body` when the cursor lives inside a `card` /
 *     `analytic_unit`, `paragraph` at doc level), and
 *     `tr.replaceSelection(slice)`. The slice's closed start makes
 *     the first inserted body a fresh sibling rather than text
 *     merged into the cursor's textblock; the open end merges the
 *     last body's content with whatever was after the cursor in
 *     the original textblock — which is exactly the shape
 *     "Return + F2" produces (and the same shape F2's own
 *     `tryPasteAsCardBodies` fix lands inside the schema's content
 *     expression for `card` / `analytic_unit`, so a pasted line
 *     can NEVER be elevated to a tag).
 *
 *   - `newParagraph: false` — `tr.insertText(text)` at the current
 *     selection. Plain inline characters, no marks, no new block.
 *
 *   - a HEADING role (`pocket` / `hat` / `block` / `tag` /
 *     `analytic`) — one heading node per line, snapped to the
 *     outline slot a drag would drop it at. See below.
 *
 * No equation-marker handling (§4.4) in v1 — the spec lets v1
 * insert the placeholder as plain body text.
 */

import { Fragment, Slice, type Node as PMNode } from 'prosemirror-model';
import { type EditorState, type Transaction } from 'prosemirror-state';
import { newHeadingId } from '../schema/ids.js';
import { nearestValidInsertPos } from './insert-position.js';

/**
 * What the sender wants the text to become. `pocket` / `hat` / `block` /
 * `tag` / `analytic` are the outline's heading levels (`./headings.ts`);
 * `body` / `card` / `cite` all land as body paragraphs, and `inline` as
 * bare characters.
 */
export type ExternalInsertRole =
  | 'pocket'
  | 'hat'
  | 'block'
  | 'tag'
  | 'analytic'
  | 'body'
  | 'card'
  | 'cite'
  | 'inline';

export interface ExternalInsertOpts {
  text: string;
  /** Omitted means `card` — body paragraphs, the pre-role behavior. */
  role?: ExternalInsertRole;
  newParagraph: boolean;
}

/**
 * The container a heading level needs around it to be schema-legal at the
 * doc root. Pocket / hat / block stand alone; `tag` is only ever a card's
 * first child and `analytic` only ever an analytic_unit's, which is why
 * sending one of those inserts a whole (single-heading) card or unit.
 */
const HEADING_CONTAINER: Record<string, 'card' | 'analytic_unit' | undefined> = {
  pocket: undefined,
  hat: undefined,
  block: undefined,
  tag: 'card',
  analytic: 'analytic_unit',
};

function isHeadingRole(role: ExternalInsertRole): boolean {
  // hasOwn, not `in`: the role comes off the wire, and `in` would answer
  // true for every Object.prototype key.
  return Object.hasOwn(HEADING_CONTAINER, role);
}

/** One heading node (in its required container) per line, or null when the
 *  schema doesn't carry the types — same defensive rail as the body path. */
function buildHeadingNodes(
  state: EditorState,
  role: ExternalInsertRole,
  lines: string[],
): PMNode[] | null {
  const headingType = state.schema.nodes[role];
  if (!headingType) return null;
  const containerName = HEADING_CONTAINER[role];
  const containerType = containerName ? state.schema.nodes[containerName] : undefined;
  if (containerName && !containerType) return null;
  return lines.map((line) => {
    // Heading nodes carry a stable id (schema/ids.ts); one built without it
    // is invisible to the nav pane, so stamp it here rather than relying on
    // the load-time repair walk.
    const heading = headingType.create(
      { id: newHeadingId() },
      line ? state.schema.text(line) : null,
    );
    return containerType ? containerType.create(null, heading) : heading;
  });
}

/** Build the insertion transaction for an external `/insert` call.
 *  Returns `null` only when the schema doesn't carry the body type
 *  we need — never happens in our schema; the null is a defensive
 *  rail for callers in other host contexts. */
export function buildExternalInsertTransaction(
  state: EditorState,
  opts: ExternalInsertOpts,
): Transaction | null {
  const { text, newParagraph } = opts;
  const role = opts.role ?? 'card';

  if (isHeadingRole(role)) {
    // A heading is never inline, so the role outranks `newParagraph`.
    const nodes = buildHeadingNodes(state, role, text.split(/\r\n|\r|\n/));
    if (!nodes) return null;
    const content = Fragment.fromArray(nodes);
    // Dropping a doc-level object at a raw caret inside a card makes PM split
    // the card and leave a phantom blank-tag sibling behind; snap to the
    // outline slot a drag would use instead (mirrors the receive-pill insert).
    const at = nearestValidInsertPos(state.doc, state.selection.head, content);
    return state.tr.insert(at, content);
  }

  if (!newParagraph) {
    // Inline mode: drop the text into the current selection as
    // plain characters. `insertText` clears the active mark set
    // implicitly on the inserted run; `setStoredMarks([])` then
    // prevents stored marks from leaking into the next keystroke
    // the user types.
    const tr = state.tr.insertText(text);
    tr.setStoredMarks([]);
    return tr;
  }

  // `card` / `cite` mode: build sibling body paragraphs from the
  // newline-separated pieces and insert them at the cursor.
  const lines = text.split(/\r\n|\r|\n/);
  const $from = state.selection.$from;

  // Pick the body type by walking up from the cursor until we
  // hit a `card` / `analytic_unit` — `card_body` belongs there.
  // No such ancestor → cursor is at doc level; use the generic
  // `paragraph` instead. (Both have `inline*` content, so the
  // slice's open end semantics are identical between the two.)
  let bodyTypeName: 'card_body' | 'paragraph' = 'paragraph';
  for (let d = $from.depth; d > 0; d--) {
    const t = $from.node(d).type.name;
    if (t === 'card' || t === 'analytic_unit') {
      bodyTypeName = 'card_body';
      break;
    }
  }
  const bodyType = state.schema.nodes[bodyTypeName];
  if (!bodyType) return null;

  const bodies = lines.map((line) =>
    bodyType.create(null, line ? state.schema.text(line) : null),
  );
  // Closed start so the first inserted body is a fresh sibling at
  // the cursor (mirrors the keystroke bridge's "press Return
  // first"); open end so the last body's content merges into
  // whatever was after the cursor in the original textblock
  // (mirrors what F2 paste does after the Return).
  const slice = new Slice(Fragment.fromArray(bodies), 0, 1);
  const tr = state.tr.replaceSelection(slice);
  tr.setStoredMarks([]);
  return tr;
}

/** One run of text carrying a fixed set of formatting flags — the
 *  shape `research-browser-panel.ts`'s "Send to Speech Doc" gets back
 *  from the embedded page (see `host:browser-get-formatted-selection`
 *  in `apps/desktop/src/main.ts`). A bare `{ break: true }` marks a
 *  paragraph boundary in the source (a `<p>`/`<div>`/`<br>`/`<li>`),
 *  splitting the run list into separate body paragraphs below. */
export type FormattedRun = { text: string; bold?: boolean; underline?: boolean; highlight?: boolean };
export type FormattedSegment = FormattedRun | { break: true };

/** Same body-paragraph insert shape as the plain-text `card`/`cite`
 *  path above (closed-start/open-end slice at the cursor, `card_body`
 *  vs `paragraph` picked the same way), but building each run's text
 *  node with real marks instead of bare characters — bold → the
 *  `bold` mark, underline → `underline_mark` (body text is never
 *  structural, so `underline_direct` doesn't apply here — see the
 *  mark's doc comment in `schema/marks.ts`), highlight → `highlight`
 *  with the default yellow. */
export function buildFormattedInsertTransaction(
  state: EditorState,
  segments: FormattedSegment[],
): Transaction | null {
  const $from = state.selection.$from;
  let bodyTypeName: 'card_body' | 'paragraph' = 'paragraph';
  for (let d = $from.depth; d > 0; d--) {
    const t = $from.node(d).type.name;
    if (t === 'card' || t === 'analytic_unit') {
      bodyTypeName = 'card_body';
      break;
    }
  }
  const bodyType = state.schema.nodes[bodyTypeName];
  if (!bodyType) return null;
  const boldType = state.schema.marks['bold'];
  const underlineType = state.schema.marks['underline_mark'];
  const highlightType = state.schema.marks['highlight'];

  const lines: FormattedRun[][] = [[]];
  for (const seg of segments) {
    if ('break' in seg) {
      if (lines[lines.length - 1]!.length > 0) lines.push([]);
      continue;
    }
    if (!seg.text) continue;
    lines[lines.length - 1]!.push(seg);
  }
  while (lines.length > 1 && lines[lines.length - 1]!.length === 0) lines.pop();
  if (lines.every((l) => l.length === 0)) return null;

  const bodies = lines.map((runs) => {
    if (runs.length === 0) return bodyType.create(null, null);
    const textNodes = runs.map((r) => {
      const marks = [];
      if (r.bold && boldType) marks.push(boldType.create());
      if (r.underline && underlineType) marks.push(underlineType.create());
      if (r.highlight && highlightType) marks.push(highlightType.create({ color: 'yellow' }));
      return state.schema.text(r.text, marks);
    });
    return bodyType.create(null, textNodes);
  });
  const slice = new Slice(Fragment.fromArray(bodies), 0, 1);
  const tr = state.tr.replaceSelection(slice);
  tr.setStoredMarks([]);
  return tr;
}
