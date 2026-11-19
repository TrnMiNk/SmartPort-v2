# SmartPort UI

Static HTML/CSS/JS, no build step. Imported from `kttling2005/SmartPort` (commit `8b065c8`, see `docs/frontend/import-notes.md`). Login, logout and the session guard use the real API (UC-001, UC-002). All other page content is still sample data from the Figma design.

## Run locally

```
# 1. API (from API/): SP_DB_NAME=<dedicated database> SP_CORS_ORIGIN=http://localhost:5500 SP_COOKIE_SECURE=false npm start
# 2. Frontend (from Front/):
npm start          # http://localhost:5500  (static server, loopback only)
```

Open `http://localhost:5500/` (use `localhost`, not `127.0.0.1`, so the origin matches the API's `SP_CORS_ORIGIN`). `SP_COOKIE_SECURE=false` is for local HTTP only.

The API address is in `js/config.js` (default `http://localhost:3000`). It holds no secrets. `SP_API_BASE_URL` makes the dev server generate `config.js` for another API, used by the browser tests.

## Structure

```
index.html            redirects to login.html
login.html            sign-in (js/pages/login.js)
overview.html operations.html vessels.html cargo.html yard.html
services.html equipment.html gis.html admin.html      protected pages, one per dashboard
css/app.css           design tokens (light and dark), shell, components
js/config.js          API base URL
js/api.js             the only place that calls the network (SP_API)
js/auth.js            login, logout, session guard (SP_AUTH)
js/layout.js          shared dashboard layout; SP.mount(key) waits for the session check
js/theme.js icons.js ui.js
js/pages/*.js         content and behavior per page
scripts/serve.js      dependency-free static server
test/unit  test/e2e   tests
```

## Live pages

- **Vessels & berths** (`vessels.html`): the vessel registry (create, edit, deactivate, detail with change history) and the arrival notices list and form use the API (UC-010, UC-011, UC-013). The KPIs, berth timeline and scheduling alerts on the same page are **sample data** until berth scheduling is built, and are labelled so. For a development database, run `npm run seed` and `npm run seed:demo` in `API/` so the forms have vessel types, ports and agents.
- Other pages (cargo, yard, services, equipment, gis, admin) are still sample data; the menu shows each page only to roles that the SRS permission matrix allows.

## Authentication behavior

- Every dashboard page calls `SP.mount(key)`, which asks the API who is signed in (`GET /api/v1/auth/me`). No session: redirect to `login.html`. Expired session: redirect with a notice. Server unreachable: an error with Retry (no false redirect).
- The session is an HttpOnly cookie. The frontend never reads or stores a token or password.
- Roles are shown for information. The API enforces authorization on every request.
- Sign out revokes the session on the server. If the server cannot be reached, the page stays and says so.

## Tests

```
npm test                                                   # unit tests, no server needed
SP_E2E_DB=<disposable migrated and seeded DB> npm run test:e2e   # real browser, real API, real SQL Server
```

The e2e test needs Chrome or Edge (set `SP_BROWSER` if it is not in a standard path) and starts its own API on port 3101 and frontend on port 5601.

## Add a page
1. Add `[key, 'Label', 'icon']` to `NAV` in `js/layout.js`.
2. Copy a dashboard HTML file (for example `yard.html`) to `<key>.html`; set the title and the last script to `js/pages/<key>.js`. Keep the `config.js`, `api.js` and `auth.js` script tags.
3. In `js/pages/<key>.js` define `V.<key>=()=>\`...html...\``, optionally `BIND.<key>=()=>{...}`, then call `SP.mount('<key>')`.
