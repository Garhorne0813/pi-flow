# UI provenance

No DSH, ZCode, or AI Elements source files or assets are copied in this change.
All components and protocol adapters are original Pi-Flow code (Apache-2.0).
Markdown uses the upstream `react-markdown` package (MIT), with HTML rendering
and unsafe URL protocols disabled by its defaults. React/React DOM, Vite,
TanStack Query, React Router, Zod, oidc-client-ts and Vitest are MIT licensed;
TypeScript is Apache-2.0. Exact versions and transitive dependencies are in
`web/package-lock.json`; npm packages retain their own LICENSE files.

Reference candidates from the RFC (not incorporated):
- deepseek-ai/deepseek-harness at e8f7b93a344964de3dca1ace9e72b6e4d6de87cb,
  ui-primitives (MIT)
- zai-org/ZCode at b95ebaffeab641907b38652f45c1502bd762972d,
  ai-elements/conversation (Apache-2.0, additional upstream attribution needed)

The initial standalone renderer spike uses react-markdown directly to keep the
import closure small and avoid unreviewed runtime or slot dependencies. Future
copied files must record repository, path, immutable SHA, modifications and
original copyright/license here before inclusion.
