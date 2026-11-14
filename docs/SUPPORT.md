# Help-desk rollout

This is an opt-in bot feature, not a server migration. It does not edit onboarding,
create setup categories/roles, deploy itself, remove old entry channels, or alter
existing tickets on startup. Production settings and permissions require operator
approval. Test with a bot in an approved staging guild first; do not use personal
account tokens for smoke tests.

## Configuration

Set all nine optional values together in the bot host's environment:

| Variable | Meaning |
| --- | --- |
| `SUPPORT_TRACKER_CHANNEL_ID` | Existing TarkovTracker public-help text channel |
| `SUPPORT_SCANNER_CHANNEL_ID` | Existing RatScanner public-help text channel |
| `SUPPORT_MONITOR_CHANNEL_ID` | Existing TarkovMonitor integration-help text channel |
| `SUPPORT_ACCOUNT_CATEGORY_ID` | Category for private account/progress tickets |
| `SUPPORT_ACCOUNT_STAFF_ROLE_IDS` | Comma-separated account-support role IDs |
| `SUPPORT_MODERATION_CATEGORY_ID` | Separate category for private moderation tickets |
| `SUPPORT_MODERATION_STAFF_ROLE_IDS` | Comma-separated moderation role IDs |
| `SUPPORT_CONTACT_URL` | HTTPS link to an approved private support contact |
| `SUPPORT_ESCALATION_URL` | HTTPS link to an independent private escalation contact |

Use IDs from the same guild. Staff lists must be nonempty, non-overlapping, and
contain existing non-managed roles, never `@everyone`. Empty comma-separated items
are rejected. Choose dedicated basic roles without administrative powers. A member
may hold both staff roles; non-overlapping IDs do not prove separate personnel.
Review memberships, including the independent escalation contact, before launch.
Contact links are deliberately public; never put credentials in them. The bot
validates URL shape, not the identity, availability, or independence of contacts.

The three help destinations must be ordinary server text channels. Ensure intended
member roles can view them. Product dropdown routing rechecks the requesting
member's current View Channel permission before returning a link; the public panel
always contains its configured links, so do not configure confidential destinations.

The bot needs View Channel, Send Messages, Read Message History, Embed Links,
Attach Files, Manage Channels and Manage Roles in both ticket categories. It needs
View Channel, Send Messages, Read Message History and Embed Links in the panel
channel. Assign only the permissions/hierarchy it actually needs, not Administrator.
New tickets use explicit overwrites: `@everyone` denied View Channel; requester
and that queue's staff get ordinary conversation/file permissions; the bot gets
conversation plus channel/overwrite management. Category overwrites are not copied.
Notification-role buttons reject both new staff-role lists as self-service roles.

**Discord administrators always retain access.** Existing management privileges can
also permit administrative changes; overwrites are not an isolation boundary from
server administrators. Do not promise anonymous reporting against them. The privacy
prompt names the queue's staff roles and links the alternate contact before a
separate confirmation opens a ticket. A confirmation from an older staff/category
or escalation-contact configuration is rejected and requires a new privacy prompt.
Collect report details only inside the
private ticket, not in the public help channel or a public GitHub issue.

## Publish or update

1. Deploy the reviewed SHA with supported Node, `npm ci`, `npm run build`, and the
   existing startup command. Confirm **one bot process**, including during deploys.
   Startup registers the new command catalog globally but does not post a panel.
2. Grant the configured `ADMIN_ROLE_ID` roles access to `/support` in Discord's
   Integrations settings if they lack Administrator. Runtime checks force-fetch
   current membership before checking/publishing and again after confirmation.
3. Run `/support check`. It validates current channels, roles, contact URL shape,
   and bot permissions. It does not certify production hosting, member visibility,
   role membership, or that people will answer the contact links.
4. Run `/support panel` in the intended read-only help-desk channel. Inspect the
   private preview and confirm Publish. Cancel/expiry publishes nothing. Save the
   returned message ID; later use `/support panel message_id:<id>` in that same
   channel to update it. Only a bot-owned help-desk panel can be updated.
5. Complete the smoke tests below before redirecting old channels or onboarding
   links. Publishing a new panel is deliberate; rerunning without `message_id`
   creates another panel. The bot never scans history or republishes on restart.

The live dropdown uses five fixed routes: Tracker, RatScanner, Monitor, account
support, and harassment/unwanted DMs. Product responses are private-to-user links,
not public messages or new tickets. The Tracker bug link opens public GitHub issue
intake; private concerns must never use it. Product and contact link buttons remain
usable when TrackerBot is offline. Dropdown actions require the bot to be online.

## Ticket lifecycle and recovery

Ticket channel topics store only a versioned type, requester ID, and open/closed
state. They contain no complaint text. Cold channel fetches reconstruct state after
restarts; there is no new database or per-message component collector. Do not edit
these topics or move managed tickets out of their configured categories casually.
Category changes do not migrate old tickets or their duplicate checks.

One ticket per requester **per queue** in its configured category is reused,
including closed tickets. Account and moderation requests are independent. A
legacy `Ticket for <id>` topic in the account destination also prevents duplicate
creation, but legacy tickets do not gain new lifecycle controls automatically.
Review outstanding legacy tickets before changing destinations.

A requester or the ticket's assigned staff can close it. Closing atomically sets
closed metadata and explicit overwrites: the requester keeps read access but is
denied sending and thread creation. Staff retain access for follow-up notes.
Only that queue's current assigned staff can reopen it; cached interaction roles
and unrelated support/admin roles do not authorize bot lifecycle actions. Discord
administrators still have their inherent manual powers. Lifecycle changes apply
the **current configured staff list**, replacing extra channel overwrites; review
outstanding tickets before changing staff settings. No topic edit or permission
change is made for an already-open/closed action.

Buttons on the opening message and `/ticket close` / `/ticket reopen` use the same
runtime checks. The slash commands recover lifecycle access if the opening notice
failed or was removed. They cannot operate on arbitrary text channels or legacy
unmanaged tickets. The requester needs application-command access to use this
fallback. Do not use generic `/channel archive` as a moderation-ticket close:
that command applies the broader configured admin audience instead of preserving
the queue's privacy. Retention, deletion, escalation policy and any removal of
requester read access are manual policy decisions, not new automation here.

Errors after a channel create/edit or panel send/edit are **unconfirmed outcomes**.
Inspect the actual channel/message before repeating; the application never starts
a second mutation call automatically. Discord SDK transport behavior is not an
exactly-once delivery guarantee. Failure to send an opening/confirmation message does not mean
creation failed. Logs contain diagnostic names/codes, not report descriptions or
SDK request bodies. No transcript export or external evidence storage is added.

Locks prevent overlapping creates for one requester/queue, overlapping lifecycle
actions per channel, and overlapping panel publications per channel in **one
process**. They are not distributed. Multiple bot instances require an approved
shared locking design first. Restrict panel-publishing permissions, monitor queue
capacity, and apply the server's existing moderation controls against abusive
account creation. There is no new server-wide ticket rate limiter.

## Required live smoke tests (staging, then approved production)

- Ordinary member: open the panel with no optional onboarding answers. All three
  product links and bug/contact links are usable; inaccessible product routing
  gives no private channel link. No product selection creates a ticket or posts
  publicly. Test intended member roles, not an administrator account.
- Account support: inspect the privacy notice; open once, then click again. One
  channel exists; account staff can see it; moderation-only staff and ordinary
  unrelated members cannot. Do not put real private evidence in smoke tests.
- Moderation: open while the account ticket exists. A separate channel exists;
  moderation staff can see it; account-only/developer roles cannot. Confirm the
  named alternate contact is suitable for reports about normal ticket handlers.
- Close as requester: history remains readable and sending/thread creation is
  denied. Requester cannot reopen; assigned staff can reopen. An unrelated staff
  role cannot. Remove a staff role and verify an old button cannot bypass removal.
- Restart the bot: the existing panel, existing ticket buttons, duplicate detection
  and slash lifecycle commands still work without reposting. Remove a test opening
  message and verify the slash fallback in that same managed ticket.
- Use `/support panel message_id:<id>` to update without posting a second panel.
  Cancel one preview; let another expire; revoke publisher authority during a
  preview. None should publish. Invalid/missing staff/category configuration must
  fail closed, not route to a broader audience.
- Stop the bot: permanent help/bug/private-contact links still work. Observe the
  bot's actual Discord connectivity through the hosting monitor; the separate web
  `/health` endpoint only proves the HTTP process is running, not Discord readiness.

Record the tested SHA, guild, role combinations, and outcomes in the PR/deployment
handoff. Automated mocks cannot prove real Discord permissions or connectivity.
Do not declare live production verification complete without this evidence.

## Rollback

Before enabling settings, save the old ticket-entry message references and review
outstanding tickets. With **no** help-desk settings configured, legacy ticket
buttons retain their old creation behavior. With **any** configured, they show the
new account-ticket privacy disclosure; partial/invalid configuration fails closed.

To disable rollout, remove/disable the new panel's interactive entry and point
members to its permanent links, then remove all nine `SUPPORT_*` settings together
and restart the bot. Preserve/review existing ticket channels and their explicit
permissions; removing settings does not delete or migrate them, and new-ticket
lifecycle operations will remain unavailable until valid settings are restored.
Removing the new staff settings also removes their notification-button exclusion,
so review configured notification-role IDs/names before rollback. Do not re-enable
legacy entry unless its `TICKET_CATEGORY_ID`/`TICKET_STAFF_ROLE_IDS` audience is
appropriate. Repository tests neither deploy the bot nor perform these writes.
