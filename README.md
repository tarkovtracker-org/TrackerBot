<div align="center">

<table border="0"><tr>
<td valign="middle"><img src="https://tarkovtracker.org/img/logos/tarkovtrackerlogo-light.webp" alt="TarkovTracker logo" width="120" /></td>
<td valign="middle"><h1>TrackerBot</h1></td>
</tr></table>

The Discord companion for the [TarkovTracker.org](https://tarkovtracker.org) community: slash commands, reaction roles, welcome automation, ticket creation, and a public bug-intake portal that forwards reports straight to GitHub.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-24_LTS-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![discord.js](https://img.shields.io/badge/discord.js-v14-5865F2?logo=discord&logoColor=white)](https://discord.js.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/tarkovtracker-org/trackerbot/pulls)
</div>

## Overview

TrackerBot runs two services side by side:

| Service | Entry point | Responsibility |
| --- | --- | --- |
| **Discord bot** | `bot.js` | Slash commands, reaction roles, welcome automation, and ticket creation. |
| **Bug intake web server** | `webserver.js` | Serves the public issue forms and forwards submissions to GitHub. |

### Reporting limits and errors

Both report forms currently create issues in `REPO_DEV`, configured as
`tarkovtracker-org/TarkovTracker`. The data overlay repository is private, so
`REPO_DATA_REPORT` is no longer required and any existing value is ignored.
Data reports retain their category-prefixed title, category, reference and details.
Both forms link to the public TarkovTracker issue list for delivery checks and
explicitly warn that Discord handles, reference links and report details are public.

`POST /data` and `POST /issue` share one reporting policy for each client IP
(with the existing IPv6 `/56` grouping). The allowance is **20 delivered reports
in a rolling 12 hours**, with **at least 10 minutes between deliveries**. A
delivery exactly 12 hours old leaves the allowance; a new report is admitted
exactly at the 10-minute boundary. IPv4-mapped addresses use the same key as IPv4,
including dotted and hexadecimal IPv6 representations. Switching forms does not
reset either limit. Users sharing an IP or IPv6 prefix share these limits.

The server reserves a slot before awaiting GitHub, so concurrent requests cannot
both pass. Confirmed GitHub issue creation (`201`) consumes the allowance and
starts the cooldown at delivery completion. Validation, origin/parser errors,
honeypot submissions and proven delivery rejections do not count as delivered
reports. A separate shared **five-attempt rolling minute** budget runs before
body parsing and includes rejected/invalid requests. Denials return the longest
active attempt/window/cooldown wait rather than an earlier partial reset.

Timeouts, connection resets, unexpected provider responses and GitHub `5xx`
responses are **unconfirmed delivery**, not proof that no issue was created.
They conservatively reserve allowance and cooldown. A hash of the same report is
held against automatic repetition for 12 hours, bounded by the same retention
window; this is not a durable idempotency guarantee. Check the published issue
list or contact support before repeating it. Different reports may be sent after
the ordinary cooldown if allowance remains. No automatic GitHub retry occurs.

Both forms preserve their entered fields on failure, disable double submission,
and display safe typed server errors. Unknown network/proxy/success responses
keep the draft and stop automatic repetition in that page. The displayed wait is
advisory; every new request is checked by the server. Length limits are visible
and enforced without silently truncating evidence: title 200, Discord handle 64,
category 64, reference 500, details 8,000 characters; request bodies are capped at
32 KiB. Successful submission resets the form. Drafts remain in the open page,
not persistent browser storage; copy them before reloading.

Errors use `{ error: { code, message }, retryAfterSeconds?, resetAt? }`.
Admission errors use HTTP `429` (`report_cooldown`, `report_window_limit`,
`attempt_limit`, `report_in_progress`), capacity uses `503`, and uncertain repeat
delivery uses `409`. Wait errors include numeric `Retry-After` seconds and an ISO
`resetAt`. Validation/parser/origin errors use `400`/`413`/`415`/`403`. Proven provider
rejections/connectivity failures use `502`/`503`; unconfirmed delivery uses `504`.
Provider throttling honors full `Retry-After` and exhausted-primary
`x-ratelimit-reset` waits, taking the longer when both apply. A shared process-local
provider hold prevents every client on both routes, including staged uploads, from
calling GitHub again before that reset. Local denials include any longer provider
wait, while known uncertain-report denials keep their check-before-repeating warning.
Secondary throttles without timing headers use GitHub's minimum one-minute guidance.
Neither server nor browser truncates a valid provider wait. Known client parser failures,
including parameter overflow, excessive nesting and unsupported formats, return
retryable typed `4xx` errors; they are not uncertain GitHub delivery.
See [GitHub rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#exceeding-the-rate-limit)
and [body-parser errors](https://expressjs.com/en/resources/middleware/body-parser/#errors).
Provider bodies, tokens, IPs
and report descriptions are never included in error output or delivery logs.

**Rollout limitation: these controls are process-local memory, not durable or
shared across workers/hosts.** A restart clears allowances, cooldowns,
uncertain-report holds and the shared provider throttle. There is no existing
persistent limiter store or hosting manifest in this repository. State is capped
at 10,000 clients and stale entries are removed; at capacity, expiry cleanup runs
at most once per second. New clients
receive a safe busy response when the remaining entries still hold active limits;
active attempt budgets are not evicted to make room. Otherwise rotating keys could
bypass the five-attempt allowance. Sustained traffic from 10,000 distinct active
client keys can still exhaust this bounded table; operator-side abuse protection
and the trusted-proxy boundary remain necessary. Strict enforcement across restarts
or multiple processes needs an operator-approved persistent/shared store after
hosting is established.
This change adds no infrastructure or production settings and is not evidence
that the deployed topology is ready for strict enforcement.

`trust proxy = 1` remains unchanged. Before rollout, operators must verify that
the origin is reachable only through the intended trusted proxy and that it
overwrites client forwarding headers, and confirm the actual process topology.
Otherwise clients may spoof the limiter key or unrelated users may share one.
Do not fix that by trusting arbitrary forwarded headers. The deployed form origin
must also match the existing `ALLOWED_ORIGINS` setting. Credential, proxy-trust and
production configuration changes require separate approval.

Use a **patched, supported Node.js 24 LTS** release in production. Node 18/20 are
end-of-life. The package engine floor is API compatibility, not security support.
See [maintenance and runtime policy](docs/MAINTENANCE.md).

## Features

- Optional persistent help-desk dropdown with product routing, privacy-separated account/moderation tickets, and close/reopen controls
- Legacy ticket creation flow with private support channels
- Reaction-role assignment, welcome messages and auto-roles for new members
- Website-first sharing (`/tt url`, `/tt resources`) and private command help
- Previewed bot announcements/replies (`/message`), without accidental mention pings
- Confirmed bounded purges, private audit archives, and channel resets
- Honeypot anti-spam channel that auto-bans anyone who posts in it
- Public web forms that open GitHub issues for bug and data reports

## Getting started

### 1. Install dependencies

```bash
npm ci
npm run build
```

This project has no bundle or generated build output. `npm run build` syntax-checks
all JavaScript files without starting either service. CI runs the same command,
the tests, and `npm run audit:prod` on Linux and Windows; production dependency
advisories fail CI. Weekly scheduled CI and Dependabot updates keep new findings
visible even without code changes. Dependencies and external actions are exactly
pinned; ordinary updates have a seven-day cooldown, while security updates stay on.

### 2. Configure environment variables

Copy `.env.example` to `.env` and fill in every value:

- **Discord bot basics:** `DISCORD_TOKEN`, `ADMIN_ROLE_ID` (comma-separated Discord role IDs granting `/message`, `/channel` and `/nuke`)
- **GitHub issue routing:** `GITHUB_TOKEN`, `REPO_DEV=tarkovtracker-org/TarkovTracker` for both forms. Legacy `REPO_DATA_REPORT` is ignored.
- **Channel IDs for automated posts:** `WELCOME_CHANNEL_ID`; optional `HONEYPOT_CHANNEL_ID` (a hidden channel — anyone who posts in it is banned on sight, with a kick fallback; messages older than 16h are swept hourly)
- **Ticket destination:** optional `TICKET_CATEGORY_ID` selects the category for newly created private tickets, independently of the channel containing the ticket button. See [Ticket placement](#ticket-placement).
- **Role IDs:** `AUTO_ROLE_ID_1`–`AUTO_ROLE_ID_4` (auto-roles for new members); optional `ALLOWED_COMMAND_ROLE_IDS` restricts resource sharing only (unset/blank allows members who can post); `PANEL_ADMIN_ROLE_ID` is retired and ignored
- **Web server:** `PORT`, `ALLOWED_ORIGINS` (comma-separated origins, exact match)

> The deployed `GITHUB_TOKEN` needs issue-write access to `tarkovtracker-org/TarkovTracker`. Prefer a fine-grained PAT with **Issues: write** on that repository only. Redirecting data reports removes the private-overlay dependency, but does not grant permissions to a token that cannot create website issues.

### Production rollout checklist

- Use `npm ci`, `npm run build`, and `npm start` in the hosting configuration.
  `npm start` launches one bot and one web process per invocation; its launcher is
  a runtime dependency, so `npm ci --omit=dev` is also supported. Verify the actual
  replica count and deployment overlap rather than inferring it from the command.
- Set `REPO_DEV=tarkovtracker-org/TarkovTracker`. Verify the deployed token's
  issue-write access without sharing credentials. Both report routes use that destination.
- Correct the operator's origin-list typos (`https//` is not `https://`). A valid
  list for the reported domains is:
  `https://tarkovtracker.org,https://www.tarkovtracker.org,https://trackerbot.nivmizz7.dev,https://www.trackerbot.nivmizz7.dev`.
  A preview hostname must be added separately if its forms are tested. Do not
  disable origin checking just to make a preview pass.
- Verify that Node is not directly Internet-accessible, that the trusted proxy
  overwrites forwarding headers, and that distinct visitors retain distinct limiter keys.
  Leave `trust proxy = 1` unchanged until the real proxy path is established.
- Confirm a single serving web process, including during deployments, and explicitly
  accept that restarts clear limits, uncertain-delivery holds and provider throttles.
  If strict limits across replicas or restarts are required, approve a shared/persistent
  store before rollout.
- A successful `/health` response only proves the HTTP process is running, not
  GitHub delivery or correct proxy isolation. Coolify configuration and production
  credentials cannot be verified from repository tests.

### 3. Run the services locally

Start everything at once:

```bash
npm start
```

This launches the bot and issue intake web server in parallel. Logs for each service are prefixed with `bot` or `web`.

Or run a single service:

```bash
npm run start:bot   # Discord bot
npm run start:web   # Public issue forms (http://localhost:3000)
```

- Bot login success is logged as soon as Discord authenticates the token.
- `webserver.js` serves `http://localhost:3000` (issue portal), plus `http://localhost:3000/issue` and `http://localhost:3000/data` (forms).

## Help desk

The optional help desk provides three public-help routes and two private ticket
queues (account/progress and harassment/unwanted DMs). `/support check` validates
configuration privately; `/support panel` previews publishing a panel in the
current channel, or updates an existing panel with `message_id`. Nothing is
posted automatically on startup. Permanent contact/product/bug links work without
the bot. Members see the intended ticket audience before opening a channel.

New tickets retain their history when closed. Requesters or members of the configured
queue staff roles can close; only members of those roles can reopen. Buttons survive restarts;
`/ticket close` and `/ticket reopen` also work if the opening message was not
delivered. No transcript export, automatic deletion, or onboarding edits are added.
Discord administrators inherently retain access; do not promise anonymity from them.

All nine optional `SUPPORT_*` settings in `.env.example` are required together.
With none configured, existing ticket buttons keep their previous behavior. With
any configured, old `create_ticket` buttons route to the new account-support
privacy disclosure; invalid/partial settings fail closed rather than using legacy
staff access. Existing ticket permissions are not migrated. Locks are process-local;
confirm a single bot instance, including deployment overlap, before rollout.

See [help-desk setup, privacy, smoke tests, and rollback](docs/SUPPORT.md).

## Ticket placement

Set `TICKET_CATEGORY_ID` to a **category ID in the same server**, not the ID of the
text channel containing the Create Ticket button. Enable Discord Developer Mode,
right-click the desired category, and choose **Copy Channel ID**. Set the variable
in the bot host's environment and restart/redeploy the bot. Category names and
positions can then change without breaking ticket creation.

Existing installations need no new variable: unset or whitespace-only values use
the existing `🆘 --- Support ---` category (case-insensitive, ignoring surrounding
whitespace). An explicit ID that is missing, belongs to another server, or points
to a non-category channel fails closed; it never silently falls back elsewhere.
Users are directed to staff instead of being told to create a category themselves.
The bot fetches the server's current channels before routing and checking for an
existing ticket in that category, rather than relying on an incomplete cache.

For a minimal server, keep one public ticket-entry channel under **Support** and
place private ticket channels in that same category; a separate Tickets category
is not required. By default, ticket permission overwrites remain explicit: the requester,
bot, and existing `Discord Admin` role receive access; `@everyone` is denied.
Server administrators retain Discord's inherent access. The bot still needs its
existing channel-management permissions; no new server permissions are granted to the bot.

For stable staff access, set optional comma-separated `TICKET_STAFF_ROLE_IDS`.
Each explicit role must exist in the same server and cannot be `@everyone`;
invalid explicit lists (including blank comma-separated items) fail closed.
Explicit ticket overwrites add only View Channel, Send Messages and Read Message
History, not management permission bits. Existing role/member permissions still
apply; these overwrites do not restrict existing powers. Choose dedicated basic
support roles if limited staff powers are required. Unset/blank preserves the existing name-based
`Discord Admin` fallback and its old management overwrite; no existing ticket
permissions are rewritten. Discord administrators retain inherent access.

Overlapping clicks from the same member cannot create two simultaneous tickets
in this bot process. Ticket creation and notification-role toggles acknowledge
privately before API calls. Failed opening/confirmation notices never claim that
an already-created ticket was not created; check the actual channel before
repeating an unconfirmed action. Locks are not shared across multiple workers.

Changing the destination only affects new tickets and duplicate checks there; it
does not move, reopen, or delete existing tickets. Review outstanding tickets
before changing destinations.

Keep durable setup guides, FAQs, credits/team information and known-issue details
on the website, linked from a short Discord entry message. Use Discord for
conversation, public help, feedback and private sensitive support—not duplicate
reference channels. This is organizational guidance only; the bot does not
reorganize the server or alter existing category permissions.

## Slash commands

| Command | Description |
| --- | --- |
| `/tt url [private] [reply_to]` | Share the website with a clean embed and link button. |
| `/tt resources [private] [reply_to]` | Share maintained website guides and community tools. |
| `/tt help` | Private command guide, available to every member. |
| `/support check` | Admin-only private validation of help-desk configuration and bot permissions. |
| `/support panel [message_id]` | Admin-only preview to publish/update a help-desk panel in this channel. |
| `/ticket close` / `/ticket reopen` | Retain a managed ticket's history; reopening requires membership in its configured queue staff roles. |
| `/message content [title] [reply_to] [preview]` | Admin-only announcement/reply; defaults to a private Send/Cancel preview. Optional title sends a styled embed; otherwise plain text. |
| `/channel purge count` | Confirm deletion of **up to 1–1000** recent messages, not an unbounded channel wipe. Discord skips messages over 14 days old. |
| `/channel archive` | Confirm staff-only text-channel archiving for audit, retaining history. |
| `/nuke` | Confirm a text-channel reset: clone settings/overwrites, then permanently delete the original and its history. IDs change; linked features may break. |

### Command access and safe sharing

All commands explicitly use **guild installation and guild context**, not the
legacy/deprecated DM toggle. Administrative commands default to Discord
administrators only in the command picker. If your configured `ADMIN_ROLE_ID`
roles do not have Discord Administrator, grant them access in **Server Settings →
Integrations → TrackerBot → Commands**. Runtime checks still require a configured
admin role even when a Discord UI override grants visibility. Administrative
commands no longer require an unrelated hardcoded member role as well, and role
names never authorize these commands. `@everyone` is always rejected as an admin
role even if its ID is misconfigured. The old `PANEL_ADMIN_ROLE_ID` is unused.

Resource sharing is public by default. **Public** shares require the invoking
member to be able to post in that channel/thread. `private:true` remains available
in read-only channels and only shows the resource to the caller. Sharing can
optionally be restricted through `ALLOWED_COMMAND_ROLE_IDS`. Use specific roles;
`@everyone` is not a valid allowlist match. Leave it unset to allow any member
who can post.
`reply_to` accepts a message ID or a `https://discord.com/channels/...` link **from
the same server and channel**. A public message reply uses a private acknowledgement;
it never silently redirects to another channel or falls back to an unrelated post.
Private sharing cannot also target a public message. Replies and announcements
suppress all mention notifications, including the replied-to author.

`/message` previews show the actual plain-text or styled payload and expire after
one minute; Cancel/expiry sends nothing. Reply targets are validated before offering
a preview and refreshed before sending; missing targets never fall back to a post. Use
`preview:false` explicitly to skip the preview. Admin authority is refreshed before
sending and again after a preview confirmation. Delivery errors never claim success;
check the channel before repeating an unconfirmed send. For example:

```text
/tt url
/tt resources
/tt resources reply_to:<paste a message link>
/message content:Please check the resources page. title:Helpful resources
/channel purge count:25
```

Optional HTTPS link overrides: `TT_SITE_URL` defaults to
`https://tarkovtracker.org/`; `TT_RESOURCES_URL` defaults to `/resources` on the
configured site's origin. Blank values keep defaults. Invalid URLs, non-HTTPS
schemes, embedded credentials and URLs over Discord's 512-character link-button
limit fail closed rather than publishing unsafe links.
No FAQ/status content is copied from the website into the bot.

### Private audit archives

Set optional `ARCHIVE_CATEGORY_ID` to a category in the same guild. Unset/blank
uses the existing **Archive** category (case-insensitive, trimmed); invalid
explicit IDs never fall back. `/channel archive` is deliberately **not a delete**:
it confirms the action, preflights the bot's View Channel, Send Messages, Read
Message History, Manage Channels **and Manage Roles** permissions, then atomically
moves the text channel while replacing
its overwrites with `@everyone` denied View Channel and only the configured admin
roles and bot allowed access. Discord administrators inherently retain access.
It never inherits a possibly public category's grants. Reviewers can inspect the
history before separately deciding to delete it. Threads are not individually
modified; existing thread memberships are not revoked.

Record original permissions **before archiving** if restoration may be needed.
The confirmation warns that the bot does not save previous overwrites. Discord
audit logs are only a limited aid, not a reliable permission backup or restoration
method. One in-flight moderation action per channel is allowed in this bot
process, including its confirmation. Multi-worker hosting requires a shared lock.
Missing roles/categories, revoked authority and failed preflight refreshes do not
trigger a fallback move. Treat an archive API error as an **unconfirmed outcome**:
the channel edit may have applied even if its response was lost. Inspect the
channel and its permission overwrites before retrying.

### Migration from the old catalog

On the next deployed bot startup, the existing global bulk-registration replaces
the old catalog. `/faq1` and `/utd` are removed: hardcoded stability/patch notices
age poorly and belong on the website. `/put-member-role` is removed: it was a
one-off mass mutation, not routine support; join auto-roles remain unchanged.
`/wipe` becomes bounded `/channel purge count`, and `/archive` becomes explicit
`/channel archive`. `/nuke` and `/message` remain recognizable. Stale invocations
receive a private pointer to `/tt help` and never run the removed actions.

This source change does not execute command registration, change production
settings, move channels or send live announcements during tests. `/nuke` refreshes
source settings after confirmation and refuses channels with flags that the
installed SDK cannot safely clone (for example, newer spoiler opt-in flags). Deploy/restart
when approved, review Integrations permissions, then perform non-destructive
smoke tests first. Official API references:
[application commands](https://docs.discord.com/developers/interactions/application-commands),
[interaction replies](https://discord.js.org/docs/packages/discord.js/14.26.4/ChatInputCommandInteraction:Class).

## Notification-role configuration

Existing button custom IDs remain recognized; availability depends on the role
safety checks below. Optional stable ID overrides survive role renames: `REACTION_ROLE_SITE_ID`, `REACTION_ROLE_MONITOR_ID`,
`REACTION_ROLE_POLLS_ID`, `REACTION_ROLE_NEWS_ID`, `REACTION_ROLE_NOTIFS_ID`.
Unset/blank values use the legacy names `site`, `monitor`, `polls`, `news`, `notifs`
(case-insensitive, trimmed). Invalid explicit IDs never silently fall back.

Use dedicated notification roles with **no administrative/moderation powers**.
Only ordinary view/send/history/reaction/embed/attachment/voice communication
capabilities and application-command use are permitted by the safety mask;
unknown future permission flags fail closed. Managed roles, `@everyone`, roles
above the bot, configured `ADMIN_ROLE_ID` roles, configured ticket staff roles,
and the legacy `Discord Admin` role cannot be self-assigned or removed through
these buttons. The bot must already have Manage Roles and the right hierarchy;
this code never grants itself server permissions.

Before upgrading, review legacy notification roles for unsupported flags such as
`CreatePublicThreads` and `ChangeNickname`. Members cannot assign **or remove** a
noncompliant role through its button. After reviewing the effects, remove
unsupported flags from a dedicated notification role or configure a separate
compliant role; never weaken the safety mask or remove necessary staff powers to
make a button work. Existing memberships are not automatically migrated or
removed. Staff must handle legacy opt-outs manually when retiring an old role.

Review each selected role's channel overwrites as well as its guild permissions
before configuring it: a role can expose private channels even with zero base
permission flags. Source-level checks cannot certify your live role/channel
policy. Membership and role definitions are fetched before toggling, and rapid
same-member toggles are serialized in this one bot process. A failed confirmation
notice does not imply the role update failed. No existing panel is reposted and
no live role/category permissions are edited by these tests.


## Project structure

```text
trackerbot/
├── bot.js              # Discord bot entry point
├── webserver.js        # Public bug/data intake server
├── src/
│   ├── client/         # Discord client setup
│   ├── commands/       # Slash command registration
│   ├── config/         # Env validation and constants
│   ├── handlers/       # Interaction and member event handlers
│   ├── interactions/   # Slash and button handlers
│   └── utils/          # Shared helpers (e.g. card embeds)
└── web/                # Static issue/data report forms
```

## Contributing

Issues and pull requests are welcome. Please open an issue to discuss substantial changes before submitting a PR.

## License

Released under the [MIT License](LICENSE).
