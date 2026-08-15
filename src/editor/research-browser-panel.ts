/**
 * Research browser panel (desktop-only).
 *
 * Docks INTO one pane of the multi-pane workspace — never a fixed
 * overlay over the whole window, since a single-pane doc has no
 * screen real estate to spare and would just get half-covered. Only
 * opens when there's an ACTUAL visible split — 2+ occupied panes, not
 * merely the workspace mode toggled on — since with one pane there's
 * nothing to pick between and docking there would just replace the
 * one document the user has open. With 2+ candidates the user picks
 * which pane it takes over. The chosen pane's own content is visually
 * replaced (toolbar + native `WebContentsView`, both sized to that
 * pane's `getBoundingClientRect()`, tracked live via `ResizeObserver` so
 * window resizes and splitter drags keep it aligned) — closing the
 * panel just removes the overlay; nothing structural changes in the
 * pane underneath.
 *
 * Tabs: each tab is backed by main's own `WebContentsView` (see
 * `apps/desktop/src/main.ts`'s `BrowserTab`), so switching tabs keeps
 * every tab's history/scroll position — only the active one is
 * attached to the window. This module just mirrors main's tab list
 * (`refreshTabs`) and renders the strip; it holds no navigation state
 * of its own.
 *
 * The native view itself sits BELOW this module's DOM toolbar strip
 * (`RESEARCH_BROWSER_TOOLBAR_HEIGHT`, kept in sync between the two) —
 * a WebContentsView always paints over same-window DOM content it
 * overlaps, so the toolbar has to occupy space the native view
 * doesn't cover.
 *
 * Selection actions:
 *   - "Insert as Cite" runs the SAME pipeline `ai/cite-creator.ts`
 *     uses for an in-doc selection (`callLlm` + `DEFAULT_AI_CITE_PROMPT`
 *     + `parseCiteResponse` + `buildCiteTransaction`), but against text
 *     captured from the embedded page instead of the editor, inserted
 *     at the focused pane's cursor (a zero-width `[pos, pos]` region).
 *   - "Insert as Text" is the plain fallback: `buildExternalInsertTransaction`
 *     with `role: 'cite'`, no AI round-trip — mirrors the Fast Debate
 *     Paste insert primitive.
 */

import type { EditorView } from 'prosemirror-view';
import { getElectronHost } from './host/index.js';
import { researchBrowserEnabled } from './research-browser-gate.js';
import {
  closeResearchBrowserPane,
  multiPaneShellActive,
  openResearchBrowserPane,
  researchBrowserSlotCandidates,
  setResearchBrowserChipTitle,
  type SlotId,
} from './multi-pane-shell.js';
import { onAnyOverlayChange } from './overlay-stack.js';
import { getSpeechDocResolver } from './speech-doc-registry.js';
import { buildExternalInsertTransaction } from './external-insert.js';
import {
  DEFAULT_AI_CITE_PROMPT,
  applyCiteToSelection,
  parseCiteResponse,
  resolveCitePrompt,
} from './ai/cite-creator.js';
import { callLlm, LlmError, activeApiKey } from './ai/llm.js';
import { claimRegion } from './ai/edit-coordinator.js';
import { settings } from './settings.js';
import { showToast } from './toast.js';

/** Fixed title stamped over the docked pane's chip while the research
 *  browser occupies it — the pane isn't the underlying document
 *  anymore (visually), so its chip shouldn't claim to be one. */
const CHIP_TITLE = 'CardMirror Browser';

export interface ResearchBrowserPanelOpts {
  /** The pane currently in focus, or null when no doc is open/focused
   *  (home screen, settings dialog, …) — same resolver every other
   *  window-level "act on the focused doc" feature uses. */
  getFocusedView: () => EditorView | null;
  /** Ribbon toggle button (research-browser-toggle-btn in index.html)
   *  — its `aria-pressed` state is kept in sync with visibility.
   *  Optional so tests / hosts without ribbon markup still work. */
  toggleButton?: HTMLButtonElement | null;
}

interface BrowserTabInfo {
  id: string;
  title: string;
  url: string;
}

/** The one instance index.ts creates (there's only ever one per
 *  window). Exposed for callers with no natural way to thread the
 *  instance through — e.g. `link-context-menu-plugin.ts`'s "Open in
 *  CardMirror Browser" — mirroring the `getElectronHost()` /
 *  `getSpeechDocResolver()` singleton-accessor pattern already used
 *  elsewhere in this codebase. */
let activePanel: ResearchBrowserPanel | null = null;
export function getResearchBrowserPanel(): ResearchBrowserPanel | null {
  return activePanel;
}

export class ResearchBrowserPanel {
  private readonly el: HTMLDivElement;
  private readonly tabStripEl: HTMLDivElement;
  private readonly addressInput: HTMLInputElement;
  private readonly backBtn: HTMLButtonElement;
  private readonly forwardBtn: HTMLButtonElement;
  private readonly insertCiteBtn: HTMLButtonElement;
  private readonly insertTextBtn: HTMLButtonElement;
  private readonly pickerEl: HTMLDivElement;
  private readonly host = getElectronHost();
  private visible = false;
  private unsubscribeNavState: (() => void) | null = null;
  private dockedEl: HTMLElement | null = null;
  private dockedSlotId: SlotId | null = null;
  private resizeObserver: ResizeObserver | null = null;
  /** True while a dialog/modal is on top and the native view is
   *  hidden for it — see the class doc comment. Distinct from
   *  `visible`: the panel is still logically open, just paused. */
  private pausedForOverlay = false;
  /** Local mirror of main's per-window tab list — kept in sync by
   *  `refreshTabs()` (full re-fetch, used on open/new/close/switch)
   *  and by the nav-state stream (title/url of whichever tab just
   *  navigated, without a round-trip). */
  private tabs: BrowserTabInfo[] = [];
  private activeTabId: string | null = null;

  constructor(private readonly opts: ResearchBrowserPanelOpts) {
    activePanel = this;
    // Electron's WebContentsView always paints over ALL same-window DOM
    // content — including modals — regardless of CSS z-index. Pause it
    // (remove the native view; the DOM toolbar/picker are unaffected)
    // whenever ANY dialog opens, and resume when the stack drains, so a
    // "keep unsaved changes?" prompt etc. isn't rendered invisibly behind it.
    onAnyOverlayChange((anyOpen) => {
      if (!this.visible) return;
      if (anyOpen) {
        this.pausedForOverlay = true;
        void this.host?.browserToggle(false);
      } else if (this.pausedForOverlay) {
        this.pausedForOverlay = false;
        void this.host?.browserToggle(true);
        this.syncBounds();
      }
    });
    this.el = document.createElement('div');
    this.el.className = 'research-browser-toolbar';
    this.el.style.display = 'none';

    this.backBtn = document.createElement('button');
    this.backBtn.type = 'button';
    this.backBtn.textContent = '←';
    this.backBtn.title = 'Back';
    this.backBtn.addEventListener('click', () => void this.host?.browserBack());

    this.forwardBtn = document.createElement('button');
    this.forwardBtn.type = 'button';
    this.forwardBtn.textContent = '→';
    this.forwardBtn.title = 'Forward';
    this.forwardBtn.addEventListener('click', () => void this.host?.browserForward());

    const reloadBtn = document.createElement('button');
    reloadBtn.type = 'button';
    reloadBtn.textContent = '⟳';
    reloadBtn.title = 'Reload';
    reloadBtn.addEventListener('click', () => void this.host?.browserReload());

    this.addressInput = document.createElement('input');
    this.addressInput.type = 'text';
    this.addressInput.placeholder = 'Search or enter a URL';
    this.addressInput.className = 'research-browser-address';
    this.addressInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.navigate(this.addressInput.value.trim());
    });

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = '✕';
    closeBtn.title = 'Close research browser';
    closeBtn.addEventListener('click', () => this.close());

    this.insertCiteBtn = document.createElement('button');
    this.insertCiteBtn.type = 'button';
    this.insertCiteBtn.textContent = 'Insert as Cite';
    this.insertCiteBtn.title = 'AI-format the selected text into a card citation';
    this.insertCiteBtn.addEventListener('click', () => void this.insertAsCite());

    this.insertTextBtn = document.createElement('button');
    this.insertTextBtn.type = 'button';
    this.insertTextBtn.textContent = 'Insert as Text';
    this.insertTextBtn.title = 'Insert the selected text as-is';
    this.insertTextBtn.addEventListener('click', () => void this.insertAsText());

    this.tabStripEl = document.createElement('div');
    this.tabStripEl.className = 'research-browser-tab-strip';

    const navRow = document.createElement('div');
    navRow.className = 'research-browser-nav-row';
    navRow.append(this.backBtn, this.forwardBtn, reloadBtn, this.addressInput, closeBtn);

    const actionRow = document.createElement('div');
    actionRow.className = 'research-browser-action-row';
    actionRow.append(this.insertCiteBtn, this.insertTextBtn);

    this.el.append(this.tabStripEl, navRow, actionRow);

    this.pickerEl = document.createElement('div');
    this.pickerEl.className = 'research-browser-picker';
    this.pickerEl.style.display = 'none';
  }

  mount(parent: HTMLElement): void {
    parent.appendChild(this.el);
    parent.appendChild(this.pickerEl);
  }

  isVisible(): boolean {
    return this.visible;
  }

  /** Open a new tab — the `researchBrowserNewTab` command. No-op
   *  (with a toast) while the panel itself is closed; there's no
   *  pane to put it in. */
  createTabCommand(): void {
    if (!this.visible) {
      showToast('Open the research browser first.');
      return;
    }
    void this.newTab();
  }

  /** Close the ACTIVE tab — the `researchBrowserCloseTab` command.
   *  Mirrors clicking that tab's × (closing the last tab spawns a
   *  fresh blank one rather than emptying the browser). */
  closeTabCommand(): void {
    if (!this.visible || !this.activeTabId) return;
    void this.closeTab(this.activeTabId);
  }

  /** Cycle the active tab — `researchBrowserNextTab` /
   *  `researchBrowserPrevTab`. Wraps around; no-op with 0-1 tabs. */
  cycleTabCommand(direction: 1 | -1): void {
    if (!this.visible || this.tabs.length < 2) return;
    const idx = this.tabs.findIndex((t) => t.id === this.activeTabId);
    if (idx === -1) return;
    const next = this.tabs[(idx + direction + this.tabs.length) % this.tabs.length]!;
    void this.switchTab(next.id);
  }

  toggle(): void {
    if (this.visible) {
      this.close();
      return;
    }
    this.openFlow();
  }

  /** "Open in CardMirror Browser" from the link right-click menu
   *  (`link-context-menu-plugin.ts`). If the browser's already open,
   *  the link becomes a NEW tab (existing tabs are left alone) — if
   *  not, opens it fresh straight to `href` (same auto-pane / picker
   *  flow as `toggle()`, so an all-panes-full workspace still asks
   *  which pane to use, per the same pane-availability logic). */
  openLink(href: string): void {
    if (!researchBrowserEnabled() || !this.host) return;
    if (this.visible) {
      void this.newTabThenNavigate(href);
      return;
    }
    this.openFlow(href);
  }

  /** Shared "get the panel on screen" flow behind both `toggle()` and
   *  `openLink()` — the only difference is what the freshly-opened
   *  tab loads. Prefers an EMPTY pane — auto-expanding the split (one
   *  doc open → opens in pane 2; two docs open → pane 3) exactly like
   *  opening another doc there would, including the layout mode's
   *  compact-thirds vs wide-with-peek rendering. Falls back to
   *  picking one of the already-occupied panes to take over only
   *  once every pane has a real doc loaded. */
  private openFlow(initialUrl?: string): void {
    if (!researchBrowserEnabled() || !this.host) return;
    if (!multiPaneShellActive()) {
      showToast('Turn on the multi-pane workspace (split view) to use the research browser.');
      return;
    }
    const opened = openResearchBrowserPane();
    if (opened) {
      this.openInPane(opened.id, opened.el, initialUrl);
      return;
    }
    const candidates = researchBrowserSlotCandidates();
    if (candidates.length === 0) {
      showToast('Open a document in a pane first.');
      return;
    }
    if (candidates.length === 1) {
      this.openInPane(candidates[0]!.id, candidates[0]!.el, initialUrl);
      return;
    }
    this.showPicker(candidates, initialUrl);
  }

  private showPicker(
    candidates: Array<{ id: SlotId; label: string; el: HTMLElement }>,
    initialUrl?: string,
  ): void {
    this.pickerEl.replaceChildren();
    const heading = document.createElement('div');
    heading.className = 'research-browser-picker-heading';
    heading.textContent = 'Open research browser in…';
    this.pickerEl.appendChild(heading);
    for (const c of candidates) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = c.label;
      btn.addEventListener('click', () => {
        this.hidePicker();
        this.openInPane(c.id, c.el, initialUrl);
      });
      this.pickerEl.appendChild(btn);
    }
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'research-browser-picker-cancel';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => this.hidePicker());
    this.pickerEl.appendChild(cancel);
    this.pickerEl.style.display = '';
  }

  private hidePicker(): void {
    this.pickerEl.style.display = 'none';
  }

  private openInPane(id: SlotId, el: HTMLElement, initialUrl?: string): void {
    if (!this.host) return;
    this.dockedEl = el;
    this.dockedSlotId = id;
    setResearchBrowserChipTitle(id, CHIP_TITLE);
    this.visible = true;
    this.el.style.display = '';
    this.opts.toggleButton?.setAttribute('aria-pressed', 'true');
    void this.host.browserToggle(true);
    if (!this.unsubscribeNavState) {
      this.unsubscribeNavState = this.host.onBrowserNavState((state) => {
        const tab = this.tabs.find((t) => t.id === state.tabId);
        if (tab) {
          tab.title = state.title;
          tab.url = state.url;
          this.renderTabStrip();
        }
        if (state.tabId === this.activeTabId) {
          this.addressInput.value = state.url;
          this.backBtn.disabled = !state.canGoBack;
          this.forwardBtn.disabled = !state.canGoForward;
        }
      });
    }
    this.resizeObserver = new ResizeObserver(() => this.syncBounds());
    this.resizeObserver.observe(el);
    this.syncBounds();
    void this.refreshTabs();
    // Supersedes the fresh tab's default home-page load — no separate
    // "new tab with URL" IPC needed, `browserNavigate` already targets
    // whichever tab is active, which is this one.
    if (initialUrl) void this.host.browserNavigate(initialUrl);
  }

  /** Open a new tab and immediately point it at `href` — used when
   *  the browser is already open and a link should land as a new
   *  tab rather than disturbing whatever's in the current one. */
  private async newTabThenNavigate(href: string): Promise<void> {
    if (!this.host) return;
    await this.host.browserTabNew();
    await this.refreshTabs();
    this.syncBounds();
    void this.host.browserNavigate(href);
  }

  /** Re-fetch the full tab list from main (the authoritative source —
   *  local state only mirrors it) and re-render the strip. Used
   *  whenever tabs are added/closed/switched, where main may have
   *  made decisions the caller doesn't fully know (e.g. auto-spawning
   *  a fresh tab when the last one closes, or picking which neighbor
   *  becomes active). */
  private async refreshTabs(): Promise<void> {
    if (!this.host) return;
    const list = await this.host.browserTabList();
    this.tabs = list.map(({ id, title, url }) => ({ id, title, url }));
    const active = list.find((t) => t.active);
    this.activeTabId = active?.id ?? this.tabs[0]?.id ?? null;
    this.addressInput.value = active?.url ?? '';
    this.renderTabStrip();
  }

  private renderTabStrip(): void {
    this.tabStripEl.replaceChildren();
    for (const tab of this.tabs) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'research-browser-tab';
      chip.classList.toggle('research-browser-tab-active', tab.id === this.activeTabId);
      chip.title = tab.url || tab.title;
      const label = document.createElement('span');
      label.className = 'research-browser-tab-label';
      label.textContent = tab.title || 'New Tab';
      chip.appendChild(label);
      chip.addEventListener('click', () => void this.switchTab(tab.id));
      if (this.tabs.length > 1) {
        const closeTabBtn = document.createElement('span');
        closeTabBtn.className = 'research-browser-tab-close';
        closeTabBtn.textContent = '✕';
        closeTabBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          void this.closeTab(tab.id);
        });
        chip.appendChild(closeTabBtn);
      }
      this.tabStripEl.appendChild(chip);
    }
    const newTabBtn = document.createElement('button');
    newTabBtn.type = 'button';
    newTabBtn.className = 'research-browser-tab-new';
    newTabBtn.title = 'New tab';
    newTabBtn.textContent = '+';
    newTabBtn.addEventListener('click', () => void this.newTab());
    this.tabStripEl.appendChild(newTabBtn);
  }

  private async newTab(): Promise<void> {
    if (!this.host) return;
    await this.host.browserTabNew();
    await this.refreshTabs();
    this.syncBounds();
  }

  private async switchTab(tabId: string): Promise<void> {
    if (!this.host || tabId === this.activeTabId) return;
    await this.host.browserTabSwitch(tabId);
    await this.refreshTabs();
    this.syncBounds();
  }

  private async closeTab(tabId: string): Promise<void> {
    if (!this.host) return;
    await this.host.browserTabClose(tabId);
    await this.refreshTabs();
    this.syncBounds();
  }

  private syncBounds(): void {
    const el = this.dockedEl;
    if (!el || !this.visible) return;
    if (!el.isConnected || el.hidden) {
      this.close();
      return;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      this.close();
      return;
    }
    this.el.style.left = `${rect.left}px`;
    this.el.style.top = `${rect.top}px`;
    this.el.style.width = `${rect.width}px`;
    void this.host?.browserSetBounds({
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    });
  }

  private close(): void {
    this.visible = false;
    this.pausedForOverlay = false;
    this.dockedEl = null;
    this.el.style.display = 'none';
    this.opts.toggleButton?.setAttribute('aria-pressed', 'false');
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.hidePicker();
    void this.host?.browserToggle(false);
    if (this.dockedSlotId) setResearchBrowserChipTitle(this.dockedSlotId, null);
    this.dockedSlotId = null;
    // No-op when the browser instead took over an already-occupied
    // pane (nothing was reserved).
    closeResearchBrowserPane();
  }

  private navigate(target: string): void {
    if (!target) return;
    void this.host?.browserNavigate(target);
  }

  private async captureSelection(): Promise<{ text: string; title: string; url: string } | null> {
    if (!this.host) return null;
    const result = await this.host.browserGetSelection();
    if (!result.text.trim()) {
      showToast('Select some text in the research browser first.');
      return null;
    }
    return result;
  }

  /** Unlike "Insert as Cite" (which builds a card in whatever pane
   *  you're actively working — the browser might be right next to a
   *  totally unrelated doc), plain-text drops are meant to land in
   *  the speech doc: the flow use case is skimming a source and
   *  dropping raw lines into the doc you're actually reading from,
   *  regardless of which pane happens to be focused. */
  private async insertAsText(): Promise<void> {
    const view = getSpeechDocResolver().getSpeechView();
    if (!view) {
      showToast('No speech document is set — mark one first (Speech → Mark as Speech Document).');
      return;
    }
    const captured = await this.captureSelection();
    if (!captured) return;
    const text = captured.url ? `${captured.text.trim()} ${captured.url}` : captured.text.trim();
    const tr = buildExternalInsertTransaction(view.state, {
      text,
      role: 'cite',
      newParagraph: true,
    });
    if (tr) view.dispatch(tr);
  }

  private async insertAsCite(): Promise<void> {
    if (!settings.get('aiFeaturesEnabled')) {
      showToast('AI features are disabled — enable them in Settings.');
      return;
    }
    const apiKey = activeApiKey();
    if (!apiKey) {
      showToast('Set an API key in Settings to use AI features.');
      return;
    }
    const view = this.opts.getFocusedView();
    if (!view) {
      showToast('Open a document to insert into first.');
      return;
    }
    const captured = await this.captureSelection();
    if (!captured) return;
    const raw = captured.url ? `${captured.text.trim()}\n${captured.url}` : captured.text.trim();

    const cursor = view.state.selection.from;
    const lease = claimRegion(view, { from: cursor, to: cursor }, { label: 'research-browser-cite' });
    if (!lease) {
      showToast('Another AI edit is working there — click in the document and try again.');
      return;
    }

    this.insertCiteBtn.disabled = true;
    const previousLabel = this.insertCiteBtn.textContent;
    this.insertCiteBtn.textContent = 'Formatting…';
    try {
      const promptTemplate = settings.get('aiCitePrompt').trim() || DEFAULT_AI_CITE_PROMPT;
      const reply = await callLlm({
        apiKey,
        system: resolveCitePrompt(promptTemplate),
        messages: [{ role: 'user', content: raw }],
      });
      const parsed = parseCiteResponse(reply.text);
      const region = lease.region();
      if (!region) {
        showToast('Cite: the insert point is no longer in the document.');
        return;
      }
      applyCiteToSelection(view, region.from, region.to, parsed, (tr) => lease.apply(tr));
    } catch (e) {
      if (e instanceof LlmError) {
        showToast(`Cite: ${e.message}`);
      } else {
        showToast(`Cite: ${e instanceof Error ? e.message : String(e)}`);
      }
    } finally {
      lease.release();
      this.insertCiteBtn.disabled = false;
      this.insertCiteBtn.textContent = previousLabel;
    }
  }
}
