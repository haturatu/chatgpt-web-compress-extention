# ChatGPT Long Thread Optimizer

Manifest V3 Chrome extension for long `chatgpt.com` and `chat.openai.com` conversations.

Safe mode is CSS-native: a marker on the conversation root lets `content-visibility: auto` apply to current and future turns without a turn registry or scroll, resize, or intersection observer. Its child-list observer marks long Markdown replies once they reach 24 direct children and detects root or URL replacement; it does not discover turns. Marked replies receive smaller rendering boundaries without a live `:has()` selector. Balanced and Aggressive modes use a moving active window and update only turns crossing its boundaries.

Memory Saver is an opt-in experiment. It records a turn's measured height, then hides that turn's direct children from rendering with `display: none` while retaining the React-owned nodes. This can interfere with page search, accessibility, citations, and ChatGPT controls; use Safe, Balanced, or Aggressive if any behavior changes. All modes keep ChatGPT's DOM and React state mounted, so none releases the main message DOM heap. The normal modes do not detach, replace, or set `display: none` on conversation nodes.

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
- `registry.ts` stores DOM-ordered elements in an array and uses weak maps for membership and index lookup. Appended turns take the constant-time path; insertion and removal reindex the affected suffix.
- `observers.ts` keeps Safe mode on root removal/navigation observation only. Window modes use the ChatGPT scroll container for the load boundary, observe only the visible turns for resize, and use `contentvisibilityautostatechange` when available with geometry detection as fallback.
- `optimizer.ts` applies the CSS-native Safe marker or computes active windows, updating only changed ranges. Window-mode stats use transition counters instead of rescanning turns; Safe mode counts turns only when stats are requested.
- `scheduler.ts` prefers prioritized `scheduler.postTask()` and `scheduler.yield()` with idle/frame fallbacks, and groups listener lifetime under abort signals.
- `src/popup` provides the compact kill switch and live stats; `src/options` provides full configuration.

The fixture tests exercise 300, 600, and 1000-turn conversations. They are detector/registry smoke benchmarks, not a claim about a user's device-level memory reduction. Browser-native containment reduces rendering work, while the experimental Memory Saver also removes off-window descendants from the render tree; neither feature frees ChatGPT's retained DOM or React state.
