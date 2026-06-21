# AGENTS.md

Open-Inspect is a background coding agent system that spawns sandboxed dev environments to work on
GitHub repositories. Single-tenant design. Stack: Cloudflare Workers (TypeScript), Modal (Python),
Next.js (React), Terraform.

## Architecture

Three tiers connected by WebSockets:

1. **Web Client** (Next.js on Vercel or Cloudflare Workers via OpenNext) — UI with GitHub OAuth,
   session dashboard, real-time streaming
2. **Control Plane** (Cloudflare Workers + Durable Objects) — session lifecycle, WebSocket hub,
   GitHub/auth integration. Each session is a Durable Object with SQLite storage. Uses D1 for
   session index, repo metadata, and encrypted repo secrets.
3. **Data Plane** (Modal, Python) — sandboxed environments running coding agents. Manages sandbox
   creation, warm pools, snapshots.

**Bot integrations** — all Cloudflare Workers using Hono:

- `slack-bot` — Slack messages → coding sessions
- `github-bot` — PR review assignments and @mention commands
- `linear-bot` — Linear agent webhooks → coding sessions

**Data flow**: User prompt → web client → control plane DO (WebSocket) → Modal sandbox → streaming
events back through the same WebSocket chain.

### Package Dependency Graph

```
@open-inspect/shared  ←  control-plane, web, slack-bot, github-bot, linear-bot
```

**Build `@open-inspect/shared` first** whenever you change shared types. Other packages import from
it at build time.

## Package Overview

| Package         | Lang / Framework                   | Purpose                                                     |
| --------------- | ---------------------------------- | ----------------------------------------------------------- |
| `shared`        | TypeScript                         | Shared types, auth utilities, model definitions             |
| `control-plane` | TypeScript / CF Workers + DO       | Session management, WebSocket streaming, GitHub integration |
| `web`           | TypeScript / Next.js 16 + React 19 | User-facing dashboard, OAuth, real-time UI                  |
| `slack-bot`     | TypeScript / CF Workers + Hono     | Slack event handler, session creation                       |
| `github-bot`    | TypeScript / CF Workers + Hono     | PR review and @mention webhook handler                      |
| `linear-bot`    | TypeScript / CF Workers + Hono     | Linear agent webhook handler                                |
| `modal-infra`   | Python 3.12 / Modal + FastAPI      | Sandbox lifecycle, WebSocket bridge to control plane        |

## Common Commands

```bash
# Install & build
npm install
npm run build                                    # all packages
npm run build -w @open-inspect/shared            # shared only (build first!)

# Lint & format
npm run lint:fix                                 # ESLint + Prettier fix
npm run format                                   # Prettier only
npm run typecheck                                # tsc across all TS packages

# Tests — TypeScript (Vitest)
npm test -w @open-inspect/control-plane          # unit tests (node env)
npm run test:integration -w @open-inspect/control-plane  # integration (workerd/Miniflare + real D1)
npm test -w @open-inspect/web
npm test -w @open-inspect/github-bot
npm test -w @open-inspect/slack-bot
npm test -w @open-inspect/linear-bot

# Tests — Python (pytest)
cd packages/modal-infra && pytest tests/ -v

# Python linting
cd packages/modal-infra && ruff check --fix && ruff format
```

## Testing

All TypeScript packages use **Vitest**; Python uses **pytest** + pytest-asyncio.

### Test file locations

- **control-plane unit**: co-located as `src/**/*.test.ts` — run in Node environment
- **control-plane integration**: separate `test/integration/*.test.ts` — run in workerd via
  `@cloudflare/vitest-pool-workers` with real D1 bindings
- **web, slack-bot, linear-bot**: co-located `src/**/*.test.ts`
- **github-bot**: separate `test/*.test.ts`
- **modal-infra**: `tests/test_*.py`

### Control-plane integration tests

These run inside a real `workerd` runtime with Miniflare, using the `cloudflareTest()` plugin from
`@cloudflare/vitest-pool-workers`. Important:

- Integration tests share one D1 instance — use `cleanD1Tables()` or equivalent cleanup in
  `beforeEach`/`afterEach` to avoid cross-test pollution
- D1 migrations from `terraform/d1/migrations/` are applied automatically via
  `test/integration/apply-migrations.ts`
- Helpers in `test/integration/helpers.ts`: `initSession()`, `queryDO()`, `seedEvents()`

## Coding Conventions

### Durations and timeouts

- **Use seconds for Python, milliseconds for TypeScript.** These match each ecosystem's conventions
  (Modal `timeout=` takes seconds; control-plane uses `_MS` suffixes throughout).
- **Encode the unit in the name.** Python: `timeout_seconds`. TypeScript: `timeoutMs`,
  `INACTIVITY_TIMEOUT_MS`. Never use a bare `timeout`.
- **Define each default value exactly once.** Extract to a named constant and import everywhere.
- **Don't restate literal values in comments.** Write `Defaults to DEFAULT_SANDBOX_TIMEOUT_SECONDS`,
  not `Default: 7200`.

### Extending existing patterns

- When threading an existing field through new code paths, evaluate whether the existing design
  (naming, types, units) is correct — don't blindly propagate it. Fix bad names or units in the same
  change rather than spreading the problem.

### Commit messages

Use conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`, `test:`. Keep the subject
under 72 characters. Use the PR body for details, not the commit message.

## Key Gotchas

- **Build order**: always build `@open-inspect/shared` before packages that depend on it.
- **PKCS#8 keys**: Cloudflare Workers require PKCS#8 format for GitHub App private keys — convert
  with `openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt`.
- **Durable Object bindings**: new DO bindings require a two-phase Terraform deploy — first with
  `enable_durable_object_bindings = false`, then `true`.
- **No `wrangler.toml`**: control-plane config is generated by Terraform, not checked in.
- **Modal deployment**: never deploy `src/app.py` directly — use `modal deploy deploy.py` or
  `modal deploy -m src`. The `app.py` file doesn't import function modules.
- **Modal image rebuild**: update `CACHE_BUSTER` in `src/images/base.py` to force a rebuild of the
  apt/pip/global-deps layers. **Exception:** edits to `packages/sandbox-runtime/` source (e.g.
  `bridge.py`) do NOT need a `CACHE_BUSTER` bump — the runtime is baked in via
  `.add_local_dir(SANDBOX_RUNTIME_DIR, ...)` at the end of `base.py`, which Modal content-hashes, so
  a source change invalidates that layer on its own. (Bumping `CACHE_BUSTER` for a pure source edit
  just wastes an upstream-layer rebuild.)
- **Web platform choice**: set `web_platform = "cloudflare"` in Terraform variables to deploy the
  web app to Cloudflare Workers via OpenNext instead of Vercel. When using Cloudflare, Vercel
  credentials are not required (dummy defaults are used). `NEXT_PUBLIC_WS_URL` must be available at
  build time since Next.js inlines `NEXT_PUBLIC_*` vars into the client bundle.
- **Image attachments — full data path**: artifact type `image`. **Upload:** web
  `POST /api/sessions/[id]/upload` uses a raw `fetch` (NOT `controlPlaneFetch`, which forces
  `Content-Type: application/json` and clobbers the multipart boundary) → control-plane
  `handleImageUpload` → R2 (`ArtifactRow.url` = R2 object key, `metadata` = JSON holding
  `mimeType`). **Send:** the `sendPrompt` WebSocket frame carries an `attachments[]` array
  (`{type,name,url}`). **Agent delivery requires inlining BYTES, not the URL:** control-plane
  `resolveAttachmentsForSandbox` (`session/message-queue.ts`, called from `processMessageQueue`)
  loads the R2 object and sets base64 `content` + `mimeType` on the dispatched `PromptCommand`;
  `bridge.py`'s `_build_prompt_request_body` then turns each base64 image into an OpenCode file part
  (`{type:"file", mime, filename, url:"data:<mime>;base64,…"}`). **Render/persist:** the
  `user_message` `SandboxEvent` carries `attachments` so the web timeline renders thumbnails and
  they survive reload. A URL on the WS frame alone does NOT reach the model — the bytes must be
  inlined into the prompt command.
- **Targeted apply when you can't deploy Modal**: editing `packages/sandbox-runtime/` bumps
  `module.modal_app.null_resource.modal_deploy`'s `source_hash`, so a plain `terraform apply` will
  try to redeploy Modal (needs `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET`). To ship ONLY web +
  control-plane:
  `terraform apply -target=null_resource.control_plane_build -target=module.control_plane_worker -target='null_resource.web_app_cloudflare_build[0]' -target='null_resource.web_app_cloudflare_deploy[0]'`.
  Deploy Modal separately with `terraform apply -target=module.modal_app`.
- **Multi-installation GitHub App support**: `GITHUB_APP_INSTALLATION_IDS` (comma-separated) allows
  the repo picker to show repos from multiple GitHub orgs/accounts. Falls back to the singular
  `GITHUB_APP_INSTALLATION_ID` for backward compat. `github-provider.ts` holds
  `appConfigs: GitHubAppConfig[]`; `listRepositories()` merges + dedupes across all installations;
  per-repo ops resolve the correct installation via `resolveConfigForRepo()`. The token cache key is
  per-installation (`${appId}:${installationId}`), so no collision. After changing the installation
  IDs, purge the `REPOS_CACHE` KV key `repos:list:v2` (5-min fresh / 1-hr stale TTL) or wait up to 1
  hour for the picker to refresh. The GitHub App must be Public to install on other accounts (set
  back to Private after).

## CI/CD

Pushing to `main` auto-deploys changed services:

- **Terraform** → control plane + D1 migrations + web app if `web_platform = "cloudflare"`
  (triggers: `terraform/`, `packages/*/`)
- **Vercel** → web app when `web_platform = "vercel"` (triggers: `packages/web/`,
  `packages/shared/`)
- **Modal** → data plane (triggers: `packages/modal-infra/`, deployed via Terraform apply)

CI runs lint, typecheck, and tests for all TypeScript and Python packages on every push and PR.

## Further Reading

- [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md) — deploy your own instance
- [docs/HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md) — detailed architecture and session lifecycle
- [CONTRIBUTING.md](CONTRIBUTING.md) — contribution guidelines
- [packages/control-plane/README.md](packages/control-plane/README.md) — API reference, WebSocket
  protocol, D1 schema, security model
- [packages/modal-infra/README.md](packages/modal-infra/README.md) — sandbox internals, Modal
  deployment, endpoint URLs
