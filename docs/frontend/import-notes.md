# Frontend import notes (`Front/`)

Date: 2026-11-18. Scope: import only. No screen was redesigned and no API was integrated.

## 1. Provenance

| Item | Value |
|---|---|
| Source | `https://github.com/kttling2005/SmartPort.git` |
| Commit imported | `8b065c89cabcfcd9455750013264fede0902d89e` ("Update README with run command instructions") |
| Branch | default branch (`HEAD`) |
| Method | `git clone` into `Front/` (it did not exist, so nothing was overwritten) |
| Legacy repositories | `../SmartPort` and `../SmartPort-FE` were not read or changed during the import |

## 2. Git strategy

- `SmartPort-v2` is one repository. The clone's own `.git` folder was **moved out** of `Front/` (not deleted) to avoid an embedded repository. A copy of that metadata exists outside the project (session scratchpad, temporary). Upstream history is recoverable at any time by cloning the URL above and checking out the commit above.
- `Front/` files are now tracked by the parent repository, like `API/` and `docs/`. This allows one commit to change `API/`, `Front/` and `docs/` together, which matches the milestone-based history rule (`CLAUDE.md` §10).
- No submodule: the frontend will be changed heavily (real API integration, screen improvements), so tracking upstream would only create conflicts.
- Consequence: pulling upstream changes is manual. Record any future upstream sync here.
- Nothing is committed yet. The parent repository still shows `Front/` as untracked.

## 3. Directory structure

```
Front/
├── .gitignore           (empty upstream file)
├── README.md            upstream README (run with `npx serve .`)
├── index.html           redirects to login.html
├── login.html           sign-in page (no dashboard shell)
├── overview.html  operations.html  vessels.html  cargo.html  yard.html
├── services.html  equipment.html  gis.html  admin.html     one file per dashboard page
├── css/
│   └── app.css          design tokens (light and dark), shell, components (256 lines)
└── js/
    ├── theme.js         applies saved or OS theme before first paint
    ├── icons.js         icon paths and ic()
    ├── ui.js            shared helpers: KPI cards, tables, tabs, panels
    ├── layout.js        sidebar, top bar, SP.mount(key)
    └── pages/           admin, cargo, equipment, gis, login, operations,
                         overview, services, vessels, yard (10 files)
```

28 files in total: 11 HTML, 1 CSS, 4 shared JS, 10 page JS, README, `.gitignore`.

## 4. Dependencies and entry points

- **Entry point:** `index.html` redirects to `login.html`. Every dashboard page loads `css/app.css` and `js/theme.js`, `icons.js`, `ui.js`, `layout.js`, then its own `js/pages/<key>.js`. `login.html` omits `layout.js`.
- **Build step:** none. No `package.json`, no bundler, no npm dependencies.
- **Run:** serve the folder with any static server (upstream README: `npx serve .`). `npx` downloads a package on first use; this was not run.
- **External resources:** only Google Fonts (`Inter`, `JetBrains Mono`) loaded by each HTML page. The page needs internet for those fonts, or falls back to system fonts.
- **Storage:** `localStorage` key `sp-theme` only (theme preference).
- **Data and network:** pages render sample data from the Figma design. There is no `fetch`, no API client and no authentication code.

## 5. Verification (executed)

| Check | Result |
|---|---|
| `Front/` absent before the import | passed (no overwrite) |
| Expected HTML, CSS, JS present (28 files, listed above) | passed |
| Every `src` and `href` for `.js` and `.css` in the HTML resolves to a file | passed (0 missing) |
| `node --check` on all 14 JS files (syntax only, nothing executed) | passed (0 errors) |
| No `.git` left inside `Front/` | passed |
| Parent repository sees the 28 files | passed |
| Browser rendering, screenshots, functional tests | **not executed** |

## 6. Difference from the local legacy frontend (important)

`../SmartPort-FE` has the same commit `8b065c8` but its working tree holds files that are **not in the GitHub repository**, so they are not in `Front/`: `js/api.js`, `js/auth.js`, `js/config.js`, `js/realtime.js`, `package.json`, `scripts/` (static server), `test/` (about 18 test files) and pages such as `arrival-notice.js`, `berth-planning.js`, `queue-operations.js`, `voyage-berthing.js`, `voyage-departure.js`, `vessel-create.js`, `vessel-lifecycle.js`, `document-lifecycle.js`, `eta-*.js`. They were seen in the working tree only; they are uncommitted there.

Consequences:
- `Front/` is the original static design with sample data. It contains no real API integration for M1 or M2.
- The earlier statement that the GitHub FE is "identical" to the local FE (`docs/api/contracts.md` §6, roadmap §E) applies to the Git commit only, not to the working tree.
- The M1 and M2 pages and the tests are a possible reuse source, but they are not imported. Importing them needs the user's approval and a manual copy, because the `protect-legacy` hook blocks commands that touch the legacy repository.
