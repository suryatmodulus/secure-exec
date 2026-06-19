# Plan: Extract `@rivet-dev/docs-theme`

Shared Starlight docs framework for all Rivet OSS projects. secure-exec is the first consumer.

## Decisions (locked)

- **Package name:** `@rivet-dev/docs-theme`
- **Repo:** `rivet-dev/docs-theme` (dedicated public repo, `package.json` at root)
- **License:** MIT
- **Visibility:** Public — git-URL installs need no auth in any consumer's CI
- **Distribution:** git-URL dependency pinned to a tag; **no npm publishing**
  - `"@rivet-dev/docs-theme": "github:rivet-dev/docs-theme#v1.0.0"`
  - Releases = `git tag vX.Y.Z && git push --tags`
- **Brand:** one fixed Rivet-porcelain brand. Palette/fonts/expressiveCode are hardcoded constants, not tokens. No per-project accent.
- **Logo:** the Rivet icon is the global brand mark and ships **inside** the package. Header lockup = `[shared Rivet icon] | [per-project product wordmark]`.
- **Shape:** an Astro integration that **wraps Starlight entirely**. Consumers never configure Starlight directly — they pass a `SiteConfig` and supply content.
- **No build/install scripts:** ship source (`.astro` / `.css` / `.ts` / `.woff2`). Astro/Vite compile at the consumer's build time. No `prepare`/`postinstall`. Do **not** add a TS build step.
- **Stars widget:** **de-Reacted** — `GitHubStars` is rewritten as a plain Astro component with a small inline `fetch` script, so the package forces **no** React peer dep on consumers. *(Interpreting "that's fine" as: drop React. Flag if you meant keep it.)*
- **Sidebar icons:** read from page frontmatter (`sidebar.icon`), route-agnostic. The hardcoded 65-entry route→icon MAP is removed.
- **Analytics:** PostHog host is hardcoded (`ph.rivet.gg`); per-project key comes from config; omittable.

## Dev workflow (3 phases)

1. **Monorepo first** — build the package locally inside this repo at `website/docs-theme/`, consumed by `website/` via a `file:` link. Iterate until secure-exec docs render identically. (Temporary staging; removed from secure-exec once the external repo is live.)
2. **New repo + example site** — create public `rivet-dev/docs-theme` (MIT), move the package to the root, add an **example Starlight site inside the repo**, and verify the theme works **e2e standalone** in that repo before touching secure-exec.
3. **secure-exec external** — tag `v0.1.0`, point `website/` at the `github:rivet-dev/docs-theme#v0.1.0` URL, remove the local staging copy, verify external consumption.

## The seam — per-project `docs.config.mjs` (the only non-content surface)

```ts
{
  product: 'Secure Exec',                 // wordmark text beside shared Rivet logo
  productLogo?: './src/assets/logo.svg',  // optional SVG wordmark instead of text
  repo: 'rivet-dev/secure-exec',          // derives social github, edit links, GitHub stars
  topNav, tabs, cta,                      // header nav
  social: { discord: '…' },               // github derived from repo
  sidebar: [ … ],                         // per-site: maps THIS project's pages
  landingCards?: [ … ],                   // optional docs-landing grid
  analytics?: { posthogKey: '…' },        // PostHog host is fixed; key optional
  // escape hatches for diverse OSS consumers:
  starlight?, css?, components?,          // merge extra config / extra css / override a component
}
```

## File disposition

### Package (`@rivet-dev/docs-theme`)
- `src/styles/theme.css` ← `starlight-custom.css` (743 lines, unchanged)
- `fonts/Manrope-Variable-latin.woff2`, `fonts/JetBrainsMono-Variable-latin.woff2`
- Rivet icon SVG (shared global mark)
- `src/expressive-code.ts` ← lifted from `astro.config.mjs`
- `src/components/`: `Header.astro`, `ThemeSelect.astro`, `PageTitle.astro`, `Sidebar.astro`, `SidebarSublist.astro`, `EditLink.astro`, `DocsLanding.astro`, `GitHubStars.astro` (de-Reacted)
- `src/index.ts` (wrapping integration), `src/config.ts` (builds StarlightUserConfig), `src/site-config.ts` (`SiteConfig` type + virtual module)
- `LICENSE` (MIT), `README.md` (SiteConfig contract)

### Stays in each consumer app
- `src/content/docs/**` (markdown, now with `sidebar.icon` frontmatter)
- `docs.config.mjs` (~30 lines)
- Entire landing page: `src/pages/index.astro`, `src/layouts/Layout.astro`, `src/styles/global.css`, `tailwind.config.mjs`, landing React components
- Optional product wordmark SVG; PostHog key (passed via config)

---

## Phase 1 — DONE (built in `website/docs-theme/`, monorepo). Deviations noted below.

### Build the package
- [x] Scaffold `website/docs-theme/`, `name: "@rivet-dev/docs-theme"`, MIT `LICENSE`
- [x] `package.json`: `exports` (`.`, `./styles/theme.css`, `./components/*`, `./assets/*`), `files: ["src","fonts","assets","LICENSE","README.md"]`, **peerDependencies** `astro` + `@astrojs/starlight` (NO react), NO build scripts
- [x] Move `starlight-custom.css` → `src/styles/theme.css`; `@font-face` URLs repointed to `../../fonts/*` (Vite bundles + hashes them — verified emitted with content hashes, referenced from the hashed CSS)
- [x] Both `.woff2` moved into `fonts/`; bundled via relative `url()` in theme.css (no public-dir copy step needed)
- [x] Rivet icon moved into `assets/rivet-icon.svg` **and inlined** into `Header.astro` (avoids any asset-path coupling)
- [x] Lifted `expressiveCode` → `src/expressive-code.mjs`
- [x] `SiteConfig` type in `src/site-config.d.ts` + virtual module `virtual:rivet-docs/config` (`src/virtual.d.ts` declares it)
- [x] `src/index.mjs`: `docsTheme(starlight, config)` → `[starlight(buildStarlightConfig(config)), docsThemeIntegration(config)]`; companion integration registers the Vite virtual-module plugin
- [x] `src/config.mjs`: maps `SiteConfig` → Starlight config (component paths via `import.meta.url`, social/editLink from `repo`, sidebar, PostHog head w/ fixed `ph.rivet.gg` host)
- [x] Extracted the FA icon catalog to `src/icons.mjs` (shared by sidebar + landing)

### Parameterize components
- [x] `Header.astro`: product/topNav/cta/social/repo from virtual config; Rivet icon inlined; text-or-image product wordmark
- [x] `GitHubStars.astro`: **React → Astro**, inline `fetch` + sessionStorage; `repo` prop — no React peer dep
- [x] `PageTitle.astro`: moved as-is (already generic — ChatGPT/Claude URLs are constants, view-source uses `location.href`)
- [x] `SidebarSublist.astro`: **route→icon MAP removed**; reads `entry.attrs['data-icon']`
- [x] `DocsLanding.astro`: styling stays; hero + cards from `config.landing`
- [x] `ThemeSelect.astro`, `Sidebar.astro`, `EditLink.astro`: moved as-is
- [x] Grep for `secure-exec` in package → zero (one ThemeSelect comment de-branded)

### Escape hatches
- [x] `config.css` appended after `theme.css`; `config.starlight` merged; `config.components` override component slots

### Prove in monorepo
- [x] `website/` consumes the package (see deviation #3); `website/docs.config.mjs` added
- [x] `astro.config.mjs` now `integrations: [react(), tailwind(...), ...docsTheme(starlight, siteConfig), sitemap()]`
- [x] Sidebar icons carried via `attrs['data-icon']` (see deviation #2)
- [x] `pnpm --dir website build` → **33 pages, clean rebuild from scratch**; verified header lockup, sidebar `data-icon`s, landing cards, hashed fonts, porcelain tokens, EC `#0a0a0a` all present in output

### Deviations from the original plan (all deliberate)
1. **`docsTheme(starlight, siteConfig)` takes the `starlight` factory as an arg.** Starlight ships TypeScript source (`exports: "./index.ts"`); importing it from inside a node_modules package makes Node's native loader try (and refuse) to strip types during config load. Importing `starlight` in the consumer's Vite-transformed `astro.config` and passing it in sidesteps this while still hiding all Starlight *configuration* behind the package.
2. **Sidebar icons via sidebar-config `attrs['data-icon']`, not page frontmatter.** The package reads `entry.attrs['data-icon']`, which is fed identically by either `sidebar.attrs` in page frontmatter **or** `attrs` on a manual sidebar item. secure-exec uses the manual-item form (icons live next to the nav entries in `docs.config.mjs`) — one file, guaranteed to flow through, no editing 27 markdown files. The package supports both; consumers choose.
3. **Linked via pnpm `workspace:*` (added `website/docs-theme` to `pnpm-workspace.yaml`), not `file:`.** pnpm *copies* `file:` dir deps into the store at install time, so source edits don't reflect without reinstalling. `workspace:*` is a live symlink — correct for iterative dev. Switches to the `github:` URL in Phase 3 regardless.
4. **`GitHubStars.tsx` STAYS in the consumer** — it's used by the landing `Navigation.tsx`, not only the docs header. Phase 3's deletion list must NOT remove it (the docs header now uses the package's own `GitHubStars.astro`).

### Cleanup deferred to Phase 3 (now-dead in the consumer, left in place per plan)
`website/src/components/starlight/*`, `website/src/components/DocsLanding.astro`, `website/src/styles/starlight-custom.css`, `website/public/fonts/*` are no longer used by the docs but remain until the external repo is live.

## Phase 2 checklist — New repo + example site (e2e standalone)

- [ ] Create public `rivet-dev/docs-theme` with MIT `LICENSE` + `README.md` (SiteConfig contract)
- [ ] Move the package from `website/docs-theme/` to the new repo root
- [ ] Add `example/` — a minimal Starlight site inside the repo consuming the package via local link
- [ ] `pnpm --dir example build` → example renders correctly (header lockup, fonts, code blocks, sidebar icons, stars widget)
- [ ] Verify a component-override escape hatch in the example
- [ ] Tag `v0.1.0`, push tags

## Phase 3 checklist — secure-exec external consumption

- [ ] `website/package.json`: depend on `github:rivet-dev/docs-theme#v0.1.0`
- [ ] Delete the local `website/docs-theme/` staging copy + migrated files (`starlight-custom.css`, `src/components/starlight/*`, `GitHubStars.tsx`, `DocsLanding.astro`, `public/fonts/*`)
- [ ] Keep landing page + `global.css` + `tailwind.config.mjs` untouched
- [ ] Fresh-clone CI install works with **no git auth** (public repo)
- [ ] `pnpm --dir website build` → still pixel-identical

---

## Review checklist (before tagging v1.0.0)

- [ ] secure-exec docs render pixel-identical to pre-extraction (palette, fonts, sidebar, TOC, callouts, code blocks, header lockup, light-only)
- [ ] Light-only enforced (no theme-toggle flash)
- [ ] Dark code blocks correct (github-dark-default, cream hairline, JetBrains Mono, orange active tab)
- [ ] Fonts load from the package path, no FOUT/404
- [ ] Stars widget fetches + caches with no React in the consumer
- [ ] Edit links + social derive correctly from `repo`
- [ ] Consumer override (extra css / replaced component) wins over theme defaults
- [ ] Zero `secure-exec` references remain in the package
- [ ] No `prepare`/build runs on `pnpm install` of the git dependency
- [ ] MIT `LICENSE` present in the package and in published `files`
- [ ] Pin works: changing `#vX.Y.Z` updates the consumer; lockfile records the commit

## Rollout to other OSS projects (after v1.0.0)

- [ ] Document `SiteConfig` + virtual-module contract in the README
- [ ] Per project: add the git dep, write `docs.config.mjs`, add `sidebar.icon` frontmatter, delete local theme files
- [ ] Establish a changelog + semver tags (the config is now a shared contract)
