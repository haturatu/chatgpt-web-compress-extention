# ChatGPT Long Thread Optimizer

Manifest V3 Chrome extension for long `chatgpt.com` and `chat.openai.com` conversations.

The default Safe mode marks detected conversation turns with `content-visibility: auto` and `contain-intrinsic-size: auto 420px`. Long Markdown replies also get smaller `content-visibility: auto` boundaries around their direct blocks, so a single very large response does not keep all off-screen blocks rendering. Balanced and Aggressive modes use `content-visibility: hidden` outside a moving active window. The extension never detaches, replaces, or sets `display: none` on ChatGPT-owned conversation nodes, which keeps React actions such as copy, edit, regenerate, citations, and code-block controls intact.

## Development

```sh
npm install
npm test
npm run typecheck
npm run build
```

Load `dist/` from `chrome://extensions` with **Developer mode → Load unpacked**. The content script only runs on the two ChatGPT hostnames in `manifest.json`.

## Architecture

- `detector.ts` owns resilient selectors and strict fail-open root validation.
- `registry.ts` tracks turns by DOM identity and keeps indexes in DOM order.
- `observers.ts` limits mutation observation to the conversation root and combines Mutation, Intersection, Resize, inner-scroll-container, and SPA lifecycle signals.
- `optimizer.ts` owns containment, active-window calculation, latest-turn pinning, streaming grace, and scroll anchoring against ChatGPT's active scroll container.
- `scheduler.ts` coalesces DOM work into animation frames and cleanup into idle callbacks.
- `src/popup` provides the compact kill switch and live stats; `src/options` provides full configuration.

The fixture tests exercise 300, 600, and 1000-turn conversations. They are detector/registry smoke benchmarks, not a claim about a user's device-level memory reduction.
