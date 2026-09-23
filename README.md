# ChatGPT Long Thread Optimizer

Manifest V3 Chrome extension for long `chatgpt.com` and `chat.openai.com` conversations.

The extension UI follows Chrome's language setting through the built-in `chrome.i18n` API. Japanese browser locales use the Japanese catalog; other locales fall back to English. The localized popup, settings page, Lite Reader, page status, extension name, and description are packaged under `_locales/` and require no extra permission or network request.

Safe mode is CSS-native: a marker on the conversation root lets `content-visibility: auto` apply to current and future turns without a per-turn registry or scroll, resize, or intersection observer. A temporary discovery observer waits for the conversation root, then the child-list observer marks long Markdown replies once they reach 24 direct children and detects root or URL replacement. Marked replies receive smaller rendering boundaries without a live `:has()` selector. Balanced and Aggressive modes use a moving active window and update only turns crossing its boundaries. Tail appends update the registry in constant time and initialize only the new turns.

Hibernate is an opt-in experiment. It records a turn's measured height, hides its direct children from rendering with `display: none`, and pauses remote HTTP(S) images/audio/video while the turn is cold. The media URLs are restored when the turn becomes active; `blob:` and `data:` sources are left alone. Search, accessibility, citations, and ChatGPT controls may behave differently in this mode. Earlier builds called it Memory Saver; that setting migrates to Hibernate.

### Mode comparison

| Mode | What it does | Relative rendering savings | Compatibility |
| --- | --- | --- | --- |
| **Safe** | Uses CSS `content-visibility: auto` for every conversation turn, including turns added later. The browser decides what can be skipped. | Baseline; reduces off-screen layout and paint work without maintaining a JavaScript active window. | Lowest risk. ChatGPT's turn DOM and controls remain intact. |
| **Balanced** | Keeps a wider active window around the viewport (`activeWindow` + 20 turns); turns outside it use `content-visibility: hidden`. | More turns stay ready, so savings are more conservative. | Low risk; DOM and React state stay mounted. |
| **Aggressive** | Uses the configured `activeWindow` around the viewport and hides turns outside it. | Renders fewer turns than Balanced when the same window setting is used. | More scrolling and reactivation; distant content can take longer to become ready. DOM and React state still stay mounted. |
| **Hibernate** | Uses the configured window, then freezes cold turn heights, hides their direct children with `display: none`, and pauses eligible remote media until activation. | Strongest rendering and media-loading reductions among the attached-page modes; actual memory savings depend on the conversation and browser. | Experimental. Page search, accessibility, citations, and ChatGPT controls can behave differently. DOM and React state still stay mounted. |

Lite Reader and Hard Memory Saver are separate opt-in workflows, not optimizer modes. Lite Reader saves a compressed snapshot and discards the ChatGPT tab; its snapshot only includes turns currently rendered by ChatGPT. Hard Memory Saver archives a recognized conversation response before trimming older messages passed to the page. Both have limitations described below, and neither guarantees a 200 MB process-memory limit.

Lite Reader stores a local, read-only snapshot in gzip-compressed chunks. It uses OPFS when available and falls back to IndexedDB. Only about 40 message cards are in the Reader DOM at once; compressed chunks are decompressed as you scroll or search. Media remains a click-to-load placeholder. **Archive visible turns & free memory** confirms the save, opens Lite Reader, then calls `chrome.tabs.discard()` on the source tab. A DOM snapshot contains only turns currently rendered by ChatGPT; older turns may be virtualized, so check the Reader's message count before relying on it. Returning to the source tab reloads ChatGPT. The archive preserves readable text and media URLs, not React state, active controls, or unsent drafts; an active response, text draft, or attachment blocks the action.

Network Discovery and Hard Memory Saver are separate opt-in experiments. Discovery records same-origin `fetch` metadata (normalized path, method, content type, status, and response size) without saving request or response bodies, query strings, or conversation IDs. After reloading ChatGPT, select the conversation JSON response in Options, enable Hard Memory Saver, and reload again. The document-start MAIN-world hook only considers that selected response. It requires a recognized `messages[]`/`current_node` shape and a successful compressed archive save before it trims older messages. Unknown schemas, failed writes, or missing current-node references pass through unchanged. This changes the active ChatGPT message history and can affect branches or page controls; it remains disabled by default and is not a 200 MB guarantee.

Safe, Balanced, Aggressive, and Hibernate keep the React-owned message nodes mounted. CSS containment and Hibernate reduce rendering or media-decoding work, but do not release the full ChatGPT DOM/React heap. Lite Reader frees the ChatGPT renderer only when its source tab is discarded. Hard Memory Saver can reduce the message state passed to the page when its response matches the discovered schema, but other application state remains. No mode guarantees a particular total process-memory limit.

## Development

```sh
npm install
npm test
npm run typecheck
npm run build
```

Load `dist/` from `chrome://extensions` with **Developer mode → Load unpacked**. The content script only runs on the two ChatGPT hostnames in `manifest.json`.

## Architecture

- `detector.ts` owns resilient selectors, cheap root discovery, and a fail-open path when ChatGPT changes its markup.
- `registry.ts` stores DOM-ordered elements in an array and uses weak maps for membership and index lookup. Appended turns take the constant-time path; insertion and removal reindex the affected suffix. Optimizer reconciliation distinguishes tail appends from reorders/removals.
- `observers.ts` keeps Safe mode on root removal/navigation observation only. Window modes use the ChatGPT scroll container for the load boundary, observe only the visible turns for resize, and use `contentvisibilityautostatechange` when available with geometry detection as fallback.
- `optimizer.ts` applies the CSS-native Safe marker or computes active windows, updating only changed ranges. Window-mode stats use transition counters instead of rescanning turns; Safe mode counts turns only when stats are requested.
- `scheduler.ts` prefers prioritized `scheduler.postTask()` and `scheduler.yield()` with idle/frame fallbacks, and groups listener lifetime under abort signals.
- `src/popup` provides the compact kill switch, live stats, archive action, and recent archive list; `src/options` provides full configuration and Network Discovery controls.
- `src/background` compresses and stores archive chunks, manages dynamic document-start registration, opens the Reader, and discards/restores source tabs.
- `src/reader` is a vanilla TypeScript virtualized archive viewer with in-app search and click-to-load media placeholders.

The fixture tests exercise 300, 600, and 1000-turn conversations. They are detector/registry smoke benchmarks, not a claim about device-level memory reduction. Use the CDP helper for comparable JS heap/DOM counts before and after each mode. Renderer RSS still includes browser and page state that these counters do not report.
