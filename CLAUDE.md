# CLAUDE.md

Agent instructions for working with this codebase.

> **Before changing anything, read the relevant parts of [`docs/architecture.md`](docs/architecture.md).**
> It is the master guide (big picture, complete file map, request flow, data layer, auth,
> environment variables). It is about 100 KB, so read "The big picture" and "Subsystem map"
> (top ~85 lines) first, then only the file-map subsection and topic sections for the area
> you are touching. The routing table at the end of this file names the doc that owns each area.

## Agent Guidelines

- **No Git Pushes** - Never run `git push` or push to any remote unless the user explicitly instructs it in their request.
- **Local commits only at the end of a chat** - `git add` and `git commit` run without a prompt, so never commit mid-task. Commit once, as the last step when the chat's work is finished.
- **No Deployments** - Never deploy or run deployment commands unless explicitly instructed.
- **No Unsolicited Actions** - Do exactly what the user asks. No unsolicited refactors, extra features, or edits outside the request's scope.
- **No Browser Actions Unless Asked** - Never open browsers/browser tools unless explicitly requested. Test commands are part of the normal project checks: run `npm test` or `npm run build` when a change touches code covered by those checks or when the user asks for verification.
- **Act immediately on simple requests** - Make clear, specific changes directly without preamble or planning steps. Save analysis for genuinely complex or ambiguous tasks.

## Website work is isolated (mandatory)

- Website/Traks work uses only the local `website/` tree, its own checks/build, and direct
  Wrangler deployment to the separate `plembfin-website` Cloudflare Pages project. It must
  never use GitHub, modify `main`, run application CI, run the root Plembfin build, or touch
  the `plembfin` application project, unless the user explicitly requests **"Force to main"**.
- Read the website deployment docs and skill before acting. Website update requests follow
  [`docs/websiteupdate.md`](docs/websiteupdate.md): discover the verification baseline recorded
  by the website, review and document all changes after it, and visually check affected pages
  locally. Publishing setup follows [`docs/website-deployment.md`](docs/website-deployment.md).
  Never push or deploy the website without an explicit user request.

## Local testing context

When local-server or connected-browser testing is explicitly requested, read
`.claude/local-environment.md` first if it exists (machine-specific URLs and signed-in browser
sessions; gitignored, so absent on fresh clones).

## Token efficiency

Cost is driven by context size multiplied by the number of calls: every call re-sends the whole
conversation. Keep both small without cutting any verification.

**Session hygiene** (the agent cannot open sessions itself, so it says so to the user):

- **One task per session.** When a task is finished, and especially when the user asks "what's
  next", recommend a fresh session instead of carrying the history forward, and give a one-line
  handoff to paste into it: the plan path plus the current step (for example
  `Continue plan/unified-up-next-sync.md, manual matrix step 2`).
- **Checkpoint long runs.** Before starting a multi-phase job ("do it", "start phase N", `/goal`),
  write the current progress and next step into the owning plan file, then recommend running
  each phase in a fresh session that starts from that file.
- **Context budget.** A local hook (`.claude/hooks/context-budget.mjs`) reports the context size
  past 150k and 250k, at each prompt and once per level mid-task. Past 150k, "what's next" gets the next item plus a handoff line, not the
  item itself. Past 250k, finish only the current item, write the handoff into the plan, and
  recommend a fresh session. The audit that prompted this found 91% of input tokens were spent
  above 200k context (`plan/agent-token-efficiency.md`).
- **Stale sessions.** When a large session resumes after an hour or more away, its cache has
  expired and the whole context is paid for again; recommend starting fresh from the plan file.

**Working style:**

- **Explore efficiently.** Run independent searches and reads in parallel in one message. Use
  Grep with small context, or Read with `offset`/`limit`, instead of `sed -n` ranges, whole-file
  dumps, or unbounded `git diff` output. Do not re-read a file already in context unless it
  changed. Delegate broad multi-file searches to an Explore subagent so only its conclusion
  enters the main context.
- **Edit with the Edit tool**, not ad-hoc Python/shell rewrite scripts.
- **Avoid permission prompts.** Each Bash call that is not allowlisted stops the user for approval.
  - Create and change files with Write/Edit, never `cat > file`, heredoc redirects, `sed -i`,
    `cp` backups, or inline `node`/`python` rewrites.
  - Put probe scripts and temporary files in the session scratchpad, not the repo root, so no
    `rm` cleanup is needed. Prefer `curl -s http://localhost:5055/...` or `node -e` over a new
    script file when a one-off query is enough. Run scratchpad scripts as
    `node "<absolute scratchpad path>/x.mjs" args` (the form a local allowlist can match); never
    through a shell variable (`Q=...; node $Q`) or after `cd`, which prompt every time.
  - Do not chain an allowlisted command (`npm test`, `node --test`, `npm run server:restart`,
    `curl` to localhost) with one that needs approval; one unapproved part prompts for the whole
    line. Run the part that needs approval as its own call, or find an allowlisted form.
  - Temporarily mutating source to prove a test fails is fine, but do it with Edit and revert
    with Edit.
- **Browser checks: text first, screenshots last.** Prefer `curl` against the API, page text
  (`get_page_text`), the accessibility tree (`read_page`), or a JavaScript probe. Take screenshots
  only when the check is genuinely visual, at reduced scale, and never inside large batches. Use
  one browser stack per session. Run multi-step browser verification in a subagent that returns
  only a pass/fail table with evidence, so screenshots and page dumps never enter the main
  context. Cap `preview_logs` at about 200 lines and use its `search` filter.
- **Large files: search, never read whole.** A hook denies whole-file `Read` of text files over
  60 KB (plan `-results`/`-reference` companions, big route modules); Grep, then Read with
  offset/limit. Shell reads (`sed -n`, `cat`, `head`) and inline Python get a warning.
- **Server restarts are one call:** `npm run server:restart` (stop, start, wait for `/api/ping`,
  one line out). Do not hand-roll stop/start/sleep/probe loops.
- **Poll sparingly.** Every wake-up re-sends the full context; wait on a notification or a
  single well-timed check rather than repeated short sleeps.

**Plan files stay lean.** Each active plan in `plan/` stays under about 15 KB and holds only
status, decisions, and next steps. Measurements, test runs, and implementation logs go in
`plan/<name>-results.md`; bulky design/specification detail goes in `plan/<name>-reference.md`
(or `plan/archive/` once completed). Open those companions only when the step at hand needs
them. Record new evidence in the results file, and update the main plan's status line.

## Branching model: `develop` → `alpha` → `main`

Day-to-day work lands on `develop`, never directly on `alpha` or `main`; those move only through
"Force to alpha" and "Force to main", and nothing is pushed back into `develop` afterwards
(`docs/decisions.md` entry 18). Changelog content and versions are computed locally by the push
command that produces them, never by CI (`docs/decisions.md` entry 6). Versioning, changelog
scripts, and promotion detail are in [`docs/development.md`](docs/development.md); procedures
live in the skills below.

## Release commands: use the matching skill

These phrases trigger a named procedure. **Invoke the skill (or workflow file) and follow it
exactly. Never improvise or reconstruct these procedures from memory.**

| The user says | Invoke |
| --- | --- |
| "Push to git", "Push all to git", "push all the git" (any case) | `push-to-git` |
| "Force to alpha" (exactly) | `force-to-alpha` |
| "Force to main" (exactly) | `force-to-main` |
| "Push website live" (case-insensitive) | `push-website-live` (website-only publish of local `website/` to `plembfin-website` via Wrangler; no GitHub push, no root build, no application CI) |
| "Start the website" (case-insensitive) | `start-website` (local Astro preview on `http://localhost:4321/`; never publishes or runs the root build) |
| "Start the server" (case-insensitive) | Start or reuse the Plembfin application server (see below) |
| "Check requests" (case-insensitive) | `.claude/check-requests.md` |

Rules that hold regardless of which skill is running:

- A trigger phrase never means `git push` by itself; the push is one late step inside the
  workflow, after every gate has passed. Never deploy or push to any remote unless the user
  explicitly asked in that request.
- "Start the server": `npm run server:restart -- --if-down` (reuses a running server) on
  `http://localhost:5055`; `npm run server:restart` forces a restart. It needs outbound network
  access for providers; see `docs/development.md` "Windows provider-backed server launches".
- "Check requests" is local-only and read-only: inspect the registered Plex, Emby, and Jellyfin
  request pages in connected Chrome, compare status/votes/comments with the ignored local
  snapshot, and draft (never post) replies a maintainer needs. If a provider asks for login,
  stop at that provider and tell the user which session needs attention.
- Never bypass a hook with `--no-verify`, and never bypass the changelog rebuild.
- The `.githooks/post-commit`, `post-merge`, and `post-rewrite` hooks regenerate the ignored
  `plan/updates.md` ledger from committed history since `origin/main`. Refresh it with
  `npm run updates:refresh` before Push to git or Force to main and use its changelog bullets
  and website targets as the review inventory. It does not replace the committed changelog
  manifests or the human website gate.
- Before Push to git, Force to alpha, or Force to main, check GHCR Cleanup is not mid-run
  (`gh run list --workflow ghcr-cleanup.yml --limit 1`); each skill repeats this first.
- "Force to alpha" and "Force to main" force-push shared branches. Show what will land, get
  explicit chat approval of the previewed changelog before staging, then stop every local server
  and start the build being published for the user to check before the push. "Force to main"
  also runs the mandatory website update gate and stops if it produces a website change (that
  change must travel through "Force to alpha" first).
- Neither force command pushes `develop`. If a procedure tells you to, it is out of date.

## Documentation and backlog sync

[`plan/todo.md`](plan/todo.md) is the single backlog. Active plans live in `plan/`; completed
plans move to [`plan/archive/`](plan/archive/) and leave the TODO. There is no root `TODO.md`
(retired 15 September 2026).

When implementing or finishing planned work, update its entry in the same change. If
user-visible behavior changes, also update the relevant `docs/` page and README section. Before
closing a plan, verify code and docs both describe current behavior.

### MANDATORY: keep the TODO current, and never overstate status

**Before ending any turn that changed code, and before starting a new phase of work, update
[`plan/todo.md`](plan/todo.md) and the owning plan's status line with the real status.** Not
optional, not waiting to be asked. Work with no plan goes under "Unscheduled backlog"; if it is
substantial, write the plan.

- **Distinguish "implemented", "unit-tested", and "verified".** Compiling is not tested; tests
  that stub the network are not verified against the real service. Only make true claims.
- **A plan is `Completed` only once its own verification section has actually been run.** Until
  then it is `Implemented and unit-tested; not yet Completed`, with outstanding checks listed
  individually as unticked boxes.
- **Archive completed plans immediately**: in the change that closes the TODO item, move the plan
  into `plan/archive/` and fix relative links crossing the archive boundary. Never archive plans
  with unverified or deferred checks; incomplete, deferred, blocked, and merely implemented plans
  stay outside the archive.
- **List what is NOT verified explicitly, with the failure mode.** "Emby `DatePlayed` unconfirmed
  - a wrong format degrades silently to watched-dated-today while still reporting success" is
  useful; "some testing remains" is not.
- **Record scoping calls made during implementation** that the user has not reviewed.
- **Never mark a downstream plan unblocked** until the upstream plan reaches `Completed`.

A task is finished when it is verified, not when it is written.

### Decision records

[`docs/decisions.md`](docs/decisions.md) preserves the reasoning behind deliberate calls. Add a
numbered entry only when all three hold: a plausible alternative was rejected, the reason is not
visible from the code, and undoing it would cost real time, data, or user trust. Not for ordinary
implementation choices, things already in a feature doc, or release bookkeeping. Append in date
order, never renumber, and mark reversed decisions superseded with a pointer instead of deleting.
Before changing behavior that looks unnecessarily cautious (a dropped sync signal, an extra
confirmation, a seemingly redundant guard), check `docs/decisions.md` first.

## Commands

`npm start` (UI + API + scheduler on `http://localhost:5055`), `npm run dev` (auto-reload),
`npm test` (`node:test` suite), `npm run build` (syntax check, tests, JSON validation,
outbound-fetch guard, one-shot boot). No linter. Details, first-boot credentials, and the
sandboxed-agent launch and Git-check rules are in [`docs/development.md`](docs/development.md).
An outbound-fetch `EACCES` from an agent-launched server is an execution-environment failure,
not an application result: restart it with network access before diagnosing.

## Module discipline (frontend and backend)

Size limits: `public/app.js` is orchestrator only, under **3,000 lines**.
`public/modules/*.js` and `server/src/routes/*.js`: soft limit **1,200**, hard limit **1,500**
lines; split by feature area before adding to a file past the soft limit.
`server/src/index.js` is the route table only, under **500 lines** (currently 190).

### Grandfathered files

Files already over their limit are listed in `docs/development.md` "Module size limits"; the
limits apply in full to every other file.

- **Do not grow them.** New code for these areas goes into a new or existing sibling module.
- **Do not split one on your own initiative.** Being over the limit is not a task. Split only
  when the requested work already touches that file, and only after proposing the extraction
  and getting the user's explicit go-ahead. These files own a lot of behavior; a careless split
  breaks more than it tidies.
- **When a split is approved, do it properly.** Move whole feature units or handler groups, not
  line ranges; keep named exports working or update every importer; check nothing else imported
  what moved. Frontend: add the `modulepreload` link in `index.html` (or register a route module
  in `route-modules.js`) and update the module table in `docs/frontend.md`. Backend: update the `dispatch()` entries in `server/src/index.js` and the API area table.

`server/src/routes/sync.js` deserves particular care: it owns webhook ingestion, manual watch and
unwatch, playback progress, sync job/history APIs, cron and force sync, preview plans, and now
playing, and several incident-driven rules in [`docs/decisions.md`](docs/decisions.md) constrain it.

### Where new frontend code goes

Before adding frontend code, look up the owning module in the feature-area table in
[`docs/frontend.md`](docs/frontend.md) ("Where new frontend code goes") and place the code in the
most specific module listed there. Create a new module only when the area fits none of them and
would exceed 150 lines; follow that doc's "Adding a new module" steps (core-graph modules get a
`modulepreload` link, route modules are registered in `route-modules.js` instead) and add the new
module to the table.

**Dependency rules:** modules may import from `state.js`, `utils.js`, `images.js`, `auth.js`,
`logs.js`, `settings.js`, `settings-ui.js`. `sync.js` may be imported by `dashboard.js` and
`media-detail.js`, not the reverse. No module imports from `app.js`. No circular dependencies;
shared logic for A↔B belongs in a third module.

### Where new route code goes

Add the route entry in `dispatch()` in `server/src/index.js` and put the handler in the owning
`server/src/routes/*.js` module. Keep helpers in `server/src/utils/` only when more than one
route module needs them. No imports back into `server/src/index.js`; route modules may import
utilities and data-layer modules directly. The owning module for each API area is in the
`server/src/routes/` table of `docs/architecture.md` (scheduler tick and Plex notification
listener: `server/src/scheduler.js`).

## Architecture: read the docs, do not rely on this file

| Touching | Read |
| --- | --- |
| Anything, first time in a session | [`docs/architecture.md`](docs/architecture.md) (relevant sections, see top of this file) |
| Why a guard or a cautious-looking behavior exists | [`docs/decisions.md`](docs/decisions.md) |
| A watch that looks wrong, or an episode that will not match | [`docs/troubleshooting.md`](docs/troubleshooting.md) |
| Webhook parsing, phases, auth | [`docs/webhooks.md`](docs/webhooks.md) |
| Scheduler, catch-up polling, manual dispatch queue | [`docs/scheduled-sync.md`](docs/scheduled-sync.md) |
| Plex / Emby / Jellyfin clients | [`docs/plex.md`](docs/plex.md), [`docs/emby.md`](docs/emby.md), [`docs/jellyfin.md`](docs/jellyfin.md) |
| TMDB / TVDB / Fanart / OMDb | [`docs/metadata.md`](docs/metadata.md) |
| Posters, backdrops, the image cache | [`docs/posters-artwork.md`](docs/posters-artwork.md) |
| SQLite tables, columns, migrations | [`docs/sqlite-schema.md`](docs/sqlite-schema.md) |
| SPA routing, state, module layout | [`docs/frontend.md`](docs/frontend.md) |
| Login, sessions, API key, webhook secret | [`docs/auth.md`](docs/auth.md) |
| Backups and restore | [`docs/backups.md`](docs/backups.md) |
| Build checks, git hooks, CI, Docker, releases | [`docs/development.md`](docs/development.md) |

Worth knowing before opening any of them:

- **One process, one SQLite file.** The default `ROLE=all` process serves the UI, `/api/*`, and
  the per-minute scheduler against `data/plembfin.db`. No cloud function, external database, or
  separate production environment.
- **`dispatch()` in `server/src/index.js` is the whole route table.** Handlers live in the owning
  `server/src/routes/*.js` module, never in `index.js`.
- **Derived caches are memoized against a shared data version.** `bumpDataVersion()` in
  `server/src/db.js` makes every process reload; forgetting it is why a change can look like it
  did not take effect.
