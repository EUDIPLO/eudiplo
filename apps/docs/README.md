# EUDIPLO documentation

Docusaurus site published at [docs.eudiplo.dev](https://docs.eudiplo.dev). Pages live in `docs/`, the sidebar in `sidebars.ts`.

How to write and structure pages, the generated references and the deployment are described in [Contributing: Documentation](docs/contributing/documentation.md).

```bash
pnpm --filter @eudiplo/config-format build    # once; needed by the generators
pnpm --filter @eudiplo/docs run prebuild       # generate docs/_generated (env vars, CLI, schemas)
pnpm --filter @eudiplo/docs start              # dev server on http://127.0.0.1:3003
pnpm --filter @eudiplo/docs lint               # markdownlint
pnpm --filter @eudiplo/docs test               # sidebar orphan check + generator tests
pnpm --filter @eudiplo/docs typecheck          # site (run prebuild first)
pnpm --filter @eudiplo/docs typecheck:scripts  # generator scripts
pnpm --filter @eudiplo/docs build              # prebuild + production build (broken links and anchors fail)
```
