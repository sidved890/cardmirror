/**
 * Right-click context menu for links: Open Link, Open in CardMirror
 * Browser (desktop only), Copy Link Address, and — for a REAL `link`
 * mark only — Edit Link…, Remove Link. Open Link routes through
 * `ElectronHost.openExternal` on desktop so URLs open in the OS
 * browser rather than a new BrowserWindow; the web build uses
 * `window.open` with `noopener,noreferrer`. "Open in CardMirror
 * Browser" routes through `ResearchBrowserPanel.openLink` — a new
 * tab if the panel's already open, else the same auto-pane/picker
 * flow `toggle()` uses. Edit/Remove operate on the full contiguous
 * run carrying the clicked mark.
 *
 * Two ways to hit a link: a real `link` mark (`findLinkAt`), or bare
 * URL TEXT with no mark at all (`findPlainUrlAt`) — most pasted URLs
 * in this app are never actually linkified (no autolink-on-paste),
 * so the common case is a `https://…` run that's just plain text
 * with no `<a>` in the DOM. The plain-text path skips Edit/Remove
 * (there's no mark to touch) but still offers Open Link / Open in
 * CardMirror Browser / Copy Link Address.
 *
 * Non-link right-clicks fall through (the image context menu wins
 * for image elements; everything else keeps the browser default).
 * Styling reuses `.pmd-nav-context-menu` to match the nav-pane and
 * image context menus.
 */

import { Plugin } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import type { Mark } from 'prosemirror-model';
import { schema } from '../schema/index.js';
import { promptForText } from './text-prompt.js';
import { showToast } from './toast.js';
import { writeClipboardText } from './clipboard-write.js';
import { getElectronHost } from './host/index.js';
import { researchBrowserEnabled } from './research-browser-gate.js';
import { getResearchBrowserPanel } from './research-browser-panel.js';

export const linkContextMenuPlugin: Plugin = new Plugin({
  props: {
    handleDOMEvents: {
      contextmenu(view, event) {
        const target = event.target as HTMLElement | null;
        if (!target || !view.dom.contains(target)) return false;

        const hit = findLinkAt(view, event.clientX, event.clientY) ??
          findPlainUrlAt(view, event.clientX, event.clientY);
        if (!hit) return false;

        event.preventDefault();
        showLinkContextMenu(event.clientX, event.clientY, view, hit);
        return true;
      },
    },
  },
});

interface LinkHit {
  href: string;
  /** Start position of the contiguous run carrying this URL. */
  from: number;
  /** End position of the same run. */
  to: number;
  /** Present for a real `link` mark hit; absent for a bare-text URL
   *  hit — Edit Link…/Remove Link only show when this is set, since
   *  there's no mark to edit or remove otherwise. */
  mark?: Mark;
}

/** Locate the link mark at a viewport (x, y) coordinate. Walks
 *  the doc from the resolved position outward to find the
 *  contiguous range of the same `link` mark instance — replace /
 *  remove operate on that whole range. Returns null if the
 *  resolved position has no link mark. */
function findLinkAt(view: EditorView, x: number, y: number): LinkHit | null {
  const coords = view.posAtCoords({ left: x, top: y });
  if (!coords) return null;
  const linkType = schema.marks['link'];
  if (!linkType) return null;
  // `posAtCoords` returns the DOM-level inside position. The mark
  // we want is on the node AT or BEFORE that position; check both
  // and prefer the one that actually carries a link.
  const doc = view.state.doc;
  const $pos = doc.resolve(Math.max(0, Math.min(coords.pos, doc.content.size)));
  const beforeMarks = $pos.nodeBefore?.marks ?? [];
  const afterMarks = $pos.nodeAfter?.marks ?? [];
  const linkBefore = beforeMarks.find((m) => m.type === linkType);
  const linkAfter = afterMarks.find((m) => m.type === linkType);
  const mark = linkAfter ?? linkBefore;
  if (!mark) return null;
  const href = String(mark.attrs['href'] ?? '');
  if (!href) return null;

  // Walk outward from the cursor position to find the full run
  // sharing this exact link-mark instance. Marks compare equal
  // (`mark.eq(other)`) when type + attrs match, so multiple
  // adjacent runs with the same href are treated as one link.
  const startSearch = linkAfter ? $pos.pos : $pos.pos - ($pos.nodeBefore?.nodeSize ?? 0);
  let from = startSearch;
  let to = startSearch;
  doc.descendants((node, pos) => {
    if (!node.isInline) return true;
    const has = node.marks.some((m) => m.eq(mark));
    if (!has) return false;
    const end = pos + node.nodeSize;
    if (pos <= startSearch && end >= startSearch) {
      from = pos;
      to = end;
    } else if (pos === to) {
      to = end;
    } else if (end === from) {
      from = pos;
    }
    return false;
  });
  // Final pass to extend `from` / `to` across consecutive runs
  // sharing the mark (the single-pass descendants above misses
  // long chains because each iteration only checks against the
  // anchor, not against running bounds).
  for (let p = from - 1; p > 0; p--) {
    const n = doc.nodeAt(p);
    if (!n || !n.isInline) break;
    if (!n.marks.some((m) => m.eq(mark))) break;
    from = p;
  }
  for (let p = to; p < doc.content.size; p++) {
    const n = doc.nodeAt(p);
    if (!n || !n.isInline) break;
    if (!n.marks.some((m) => m.eq(mark))) break;
    to = p + n.nodeSize;
  }
  return { href, from, to, mark };
}

/** Matches the same `https?://…` shape `resolveNavigationTarget`
 *  (main.ts) treats as a URL — a run of non-whitespace, non-quote,
 *  non-bracket characters right after the scheme, so trailing
 *  punctuation like a sentence's closing period or a wrapping `)`
 *  doesn't get swallowed into the link. */
const PLAIN_URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

/** Locate a bare `https://…` URL run in plain TEXT at a viewport
 *  (x, y) coordinate — no `link` mark required. Scans the enclosing
 *  textblock's full text for URL-shaped substrings and returns the
 *  one the click position falls inside, or null. This is the common
 *  case: nothing in this app auto-linkifies pasted URLs, so most
 *  "links" users right-click are just plain text that happens to
 *  read as a URL. */
function findPlainUrlAt(view: EditorView, x: number, y: number): LinkHit | null {
  const coords = view.posAtCoords({ left: x, top: y });
  if (!coords) return null;
  const doc = view.state.doc;
  const $pos = doc.resolve(Math.max(0, Math.min(coords.pos, doc.content.size)));
  const block = $pos.parent;
  if (!block.isTextblock) return null;
  const blockStart = $pos.start();
  const offsetInBlock = coords.pos - blockStart;
  const text = block.textContent;
  PLAIN_URL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PLAIN_URL_RE.exec(text))) {
    const start = match.index;
    const end = start + match[0].length;
    if (offsetInBlock >= start && offsetInBlock <= end) {
      return { href: match[0], from: blockStart + start, to: blockStart + end };
    }
  }
  return null;
}

interface MenuItem {
  label: string;
  disabled?: boolean;
  title?: string;
  action: () => void;
}

let openMenuEl: HTMLElement | null = null;

function showLinkContextMenu(
  x: number,
  y: number,
  view: EditorView,
  hit: LinkHit,
): void {
  closeLinkContextMenu();

  const items: MenuItem[] = [
    {
      label: 'Open Link',
      action: () => openLinkExternally(hit.href),
    },
    ...(researchBrowserEnabled()
      ? [
          {
            label: 'Open in CardMirror Browser',
            action: () => getResearchBrowserPanel()?.openLink(hit.href),
          },
        ]
      : []),
    {
      label: 'Copy Link Address',
      action: () => copyToClipboard(hit.href),
    },
    // Nothing to edit/remove for a bare-text URL hit — there's no mark.
    ...(hit.mark
      ? [
          {
            label: 'Edit Link…',
            action: () => void editLink(view, hit),
          },
          {
            label: 'Remove Link',
            action: () => removeLink(view, hit),
          },
        ]
      : []),
  ];

  const menu = document.createElement('div');
  menu.className = 'pmd-nav-context-menu';
  for (const item of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pmd-nav-context-item';
    btn.textContent = item.label;
    if (item.disabled) {
      btn.disabled = true;
      btn.classList.add('pmd-nav-context-item-disabled');
    }
    if (item.title) btn.title = item.title;
    btn.addEventListener('click', () => {
      if (item.disabled) return;
      closeLinkContextMenu();
      item.action();
    });
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  const maxX = window.innerWidth - rect.width - 4;
  const maxY = window.innerHeight - rect.height - 4;
  menu.style.left = `${Math.min(x, Math.max(0, maxX))}px`;
  menu.style.top = `${Math.min(y, Math.max(0, maxY))}px`;

  openMenuEl = menu;
  setTimeout(() => {
    window.addEventListener('mousedown', maybeCloseLinkContextMenu, { capture: true });
    window.addEventListener('keydown', maybeCloseLinkContextMenu, { capture: true });
  });
}

function closeLinkContextMenu(): void {
  if (!openMenuEl) return;
  openMenuEl.remove();
  openMenuEl = null;
  window.removeEventListener('mousedown', maybeCloseLinkContextMenu, { capture: true });
  window.removeEventListener('keydown', maybeCloseLinkContextMenu, { capture: true });
}

function maybeCloseLinkContextMenu(e: MouseEvent | KeyboardEvent): void {
  if (e instanceof KeyboardEvent) {
    if (e.key === 'Escape') closeLinkContextMenu();
    return;
  }
  if (!openMenuEl) return;
  if (!openMenuEl.contains(e.target as Node)) closeLinkContextMenu();
}

function openLinkExternally(href: string): void {
  const electron = getElectronHost();
  if (electron) {
    void electron.openExternal(href).catch((err) => {
      console.warn('openExternal failed:', err);
      showToast('Could not open link.');
    });
    return;
  }
  // Web fallback. noopener+noreferrer prevents the opened page
  // from running scripts back against ours.
  try {
    window.open(href, '_blank', 'noopener,noreferrer');
  } catch (err) {
    console.warn('window.open failed:', err);
    showToast('Could not open link.');
  }
}

function copyToClipboard(text: string): void {
  // Shared host-first / retrying path (clipboard-write.ts); it owns
  // the execCommand fallback too.
  void writeClipboardText(text).then((ok) =>
    showToast(ok ? 'Link copied.' : 'Copy failed.'),
  );
}

async function editLink(view: EditorView, hit: LinkHit): Promise<void> {
  const next = await promptForText({
    message: 'Edit link URL',
    initial: hit.href,
    placeholder: 'https://…',
    okLabel: 'Save',
  });
  if (next === null) return;
  const trimmed = next.trim();
  const linkType = schema.marks['link'];
  if (!linkType) return;
  // Empty input = remove the link mark.
  if (trimmed === '') {
    removeLink(view, hit);
    return;
  }
  if (trimmed === hit.href) return;
  const tr = view.state.tr
    .removeMark(hit.from, hit.to, linkType)
    .addMark(hit.from, hit.to, linkType.create({ href: trimmed }));
  view.dispatch(tr);
}

function removeLink(view: EditorView, hit: LinkHit): void {
  const linkType = schema.marks['link'];
  if (!linkType) return;
  view.dispatch(view.state.tr.removeMark(hit.from, hit.to, linkType));
}
