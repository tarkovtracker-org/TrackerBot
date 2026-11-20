# AGENTS.md

Guidance for AI agents working in this repository.

## Project

TrackerBot — Discord.js v14 companion bot for TarkovTracker.org. Two services run side by side:

- `bot.js` — Discord bot (slash commands, reaction roles, welcome automation, ticketing)
- `webserver.js` — Express server serving public bug/data intake forms that open GitHub issues

ESM throughout (`"type": "module"` in `package.json`). Requires Node.js 24+. Use a patched supported Node 24 LTS release in production.

## Architecture

```
bot.js                  # Entry point: ensureEnvVars -> createClient -> register handlers -> login
webserver.js            # Express issue intake server
src/
  client/               # Discord client setup (intents, partials)
  commands/             # Slash command registration + command definitions
  config/               # env.js (required-var validation), constants.js (role/config derivation)
  handlers/             # Event-driven handlers registered via registerXxxHandlers(client)
  interactions/         # Slash + button interaction logic
  utils/                # Shared helpers (embeds)
web/                    # Static issue/data report forms
test/                   # Node --test files
```

### Conventions

- Handlers export a `registerXxxHandlers(client)` (or `setupXxx(client)`) function that attaches event listeners; wired up in `bot.js`.
- Env vars are validated centrally in `src/config/env.js` via `requiredEnvVars` + `getRequiredEnv`/`ensureEnvVars`. New required vars must be added there AND to `.env.example` AND documented in `README.md`.
- Optional features should read their env var defensively (not in `requiredEnvVars`) so existing deployments and the test suite don't break.
- Constants derived from env (role sets, configs) live in `src/config/constants.js`.
- Error handling: catch at handler boundaries, log via `console.error`/`console.warn`, never crash the process.

## Verification

Run before considering work complete:

```bash
npm test                    # Node --test (env validation tests)
node --check bot.js && node --check webserver.js   # syntax check entry points
# CI also runs a full `find . -name "*.js" -not -path "./node_modules/*" | node --check` sweep
```

CI (`.github/workflows/ci.yml`) runs: `npm ci` -> syntax check all JS -> `npm test`.

## Git / PR

- Conventional commit style (`feat:`, `fix:`, `chore:`, `refactor:`).
- Branch naming: `<type>/<short-desc>` (e.g. `feat/honeypot`, `chore/add-agents-md`).
- PRs target `main`. Use `gh` for all GitHub operations.

### Owner-authorized merges

TrackerBot's normal merge path requires independent approval. GitHub PR authors
cannot approve their own PRs. TrackerBot's independent-review ruleset lists
`DysektAI` for pull-request-only bypass. Verify the active rulesets and the
authenticated account before relying on that exception. Repository admin access
alone does not establish bypass eligibility.

Use the exception only when the owner authorizes it for that PR. First verify
the current head is up to date, both required CI jobs pass, review threads are
resolved, and no human reviewer has a hold. Then use
`gh pr merge <number> --admin --squash --match-head-commit <verified-head-sha>`.
The separate required-CI ruleset has no bypass actors. If the exception is
unavailable, get an independent approval through the normal review path.
