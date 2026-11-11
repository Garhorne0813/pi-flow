# UI provenance and redistribution

Pi-Flow directly vendors presentation code from DeepSeek Harness, MIT licensed,
pinned at `e8f7b93a344964de3dca1ace9e72b6e4d6de87cb`. The exact source paths,
SHA-256 hashes and modification status are in `dsh/provenance.json`. Copied files
remain byte-identical to that commit; the upstream license is preserved in
`LICENSES/deepseek-harness-MIT.txt` and included in the built frontend at
`third-party-notices.txt`.

Copied and used at runtime:
- Theme: `base.css`, `design-platform.css`, `gradient-shadow-text.css`,
  `scrollbar.css`, `shiki.css`, including its light/dark palette, typography and elevation.
- Primitives: `Button`, `Pill`, `UserMessageBubble` and their CSS modules.
- Presentation sheets: `MarkdownText`, `CodeCard`, `SidebarRoot`, `HeroShell`,
  `InputBar` CSS modules. Their host elements use Pi-Flow data and actions.

`web/src/style.css` supplies Pi-Flow layout glue to the copied tokens and
surfaces. `web/src/ui/CodeFence.tsx` is a local safe-text/highlight adapter that
uses the upstream CodeCard CSS; it is not a copy of DSH's highlighter. Markdown
continues using react-markdown with raw HTML disabled, GFM and safe URL handling.
Syntax highlighting is lazy loaded. Source text never becomes raw user HTML.

Audited upstream LICENSE, THIRD_PARTY_NOTICES.md and BRAND_GUIDELINES.md before
copying. No DeepSeek logos, wordmarks, whale illustrations, brand fonts, or other
brand assets are copied. Product identity stays Pi-Flow. These leaf components
only import React, clsx and local CSS. No DSH protocol, Cordis, session controller,
RPC, host framework or ZCode code is bundled. Token identifiers retained from
the source do not imply official endorsement.

Runtime additions: clsx 2.1.1 (MIT), remark-gfm 4.0.1 (MIT), highlight.js 11.11.1
(BSD-3-Clause). Their licenses are preserved under LICENSES. All dependencies
remain pinned in package-lock.json. Existing React, Vite, Query, Router, Zod,
oidc-client-ts and react-markdown licenses are retained in their npm packages.
Future upstream updates require a new manifest and a presentation/API regression
review; run `node scripts/check-chat-dependencies.mjs` to verify the copy hashes
and reject forbidden protocol packages.
