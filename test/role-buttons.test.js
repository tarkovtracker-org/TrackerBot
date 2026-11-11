import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Collection, PermissionsBitField, PermissionFlagsBits, MessageFlags } from "discord.js";
import { adminRoles } from "../src/config/constants.js";
import { handleButtonInteraction } from "../src/interactions/buttonHandlers.js";

const names = ["REACTION_ROLE_SITE_ID", "REACTION_ROLE_MONITOR_ID", "REACTION_ROLE_POLLS_ID", "REACTION_ROLE_NEWS_ID", "REACTION_ROLE_NOTIFS_ID", "TICKET_STAFF_ROLE_IDS"];
const original = Object.fromEntries(names.map(name => [name, process.env[name]]));
const originalAdmins = [...adminRoles];
beforeEach(t => {
  names.forEach(name => delete process.env[name]);
  adminRoles.clear();
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "error", () => {});
});
afterEach(() => {
  for (const name of names) {
    if (original[name] === undefined) delete process.env[name];
    else process.env[name] = original[name];
  }
  adminRoles.clear(); originalAdmins.forEach(id => adminRoles.add(id));
});

function fixture({ name = "site", permissions = [], freshHasRole = false, managed = false, editable = true, expired = false } = {}) {
  const events = [], replies = [], changes = [], violations = [];
  const role = { id: "notification-role", name, guild: { id: "guild" }, permissions: new PermissionsBitField(permissions), managed, editable };
  const freshCache = new Collection(freshHasRole ? [[role.id, role]] : []);
  const add = async value => { events.push("add"); changes.push(["add", value.id ?? value]); freshCache.set(role.id, role); };
  const remove = async value => { events.push("remove"); changes.push(["remove", value.id ?? value]); freshCache.delete(role.id); };
  const interaction = {
    customId: "role_site", isButton: () => true,
    member: { id: "member", roles: { cache: new Collection(), add, remove } },
    guild: {
      id: "guild",
      roles: { cache: new Collection([[role.id, role]]), fetch: async function () { events.push("fetch-roles"); return this.cache; } },
      members: { fetch: async options => {
        events.push("fetch-member");
        if (JSON.stringify(options) !== JSON.stringify({ user: "member", force: true })) violations.push("member fetch must bypass cache");
        return { id: "member", roles: { cache: freshCache, add, remove } };
      } }
    },
    deferReply: async options => {
      events.push("defer");
      if (options.flags !== MessageFlags.Ephemeral) violations.push("acknowledgement must be private");
      if (expired) throw new Error("Unknown interaction");
    },
    editReply: async data => { events.push("edit"); replies.push(data); },
    reply: async data => { events.push("reply"); replies.push(data); }
  };
  return { interaction, role, events, replies, changes, violations };
}

async function run(f) {
  assert.equal(await handleButtonInteraction(f.interaction), true);
  assert.deepEqual(f.violations, []);
  return f;
}

function title(f) { return f.replies.at(-1)?.embeds?.[0].toJSON().title; }

test("legacy notification roles acknowledge privately before network and mutation", async () => {
  const f = await run(fixture());
  assert.equal(f.events[0], "defer");
  assert.ok(f.events.includes("fetch-roles"));
  assert.ok(f.events.includes("fetch-member"));
  assert.deepEqual(f.changes, [["add", "notification-role"]]);
  assert.equal(title(f), "Role added");
});

test("configured notification role ID survives renames", async () => {
  const f = fixture({ name: "Renamed notifications" });
  process.env.REACTION_ROLE_SITE_ID = " notification-role ";
  await run(f);
  assert.deepEqual(f.changes, [["add", "notification-role"]]);
});

test("invalid explicit role ID fails closed instead of granting a name-matched role", async () => {
  const f = fixture();
  process.env.REACTION_ROLE_SITE_ID = "missing-role";
  await run(f);
  assert.equal(f.changes.length, 0);
  assert.equal(title(f), "Role missing");
});

test("role toggles use current membership rather than the interaction snapshot", async () => {
  const f = await run(fixture({ freshHasRole: true }));
  assert.deepEqual(f.changes, [["remove", "notification-role"]]);
  assert.equal(title(f), "Role removed");
});

for (const permissions of [[PermissionFlagsBits.Administrator], [PermissionFlagsBits.ManageRoles], [PermissionFlagsBits.ManageChannels], [PermissionFlagsBits.ManageWebhooks]]) {
  test(`self-service rejects privileged role flags ${permissions}`, async () => {
    const f = await run(fixture({ permissions }));
    assert.equal(f.changes.length, 0);
    assert.equal(title(f), "Role unavailable");
  });
}

for (const config of [{ managed: true }, { editable: false }]) {
  test(`self-service rejects unassignable roles ${JSON.stringify(config)}`, async () => {
    const f = await run(fixture(config));
    assert.equal(f.changes.length, 0);
    assert.equal(title(f), "Role unavailable");
  });
}

test("configured admin and private-support roles cannot be self-assigned even with zero base permissions", async () => {
  const admin = fixture();
  adminRoles.add(admin.role.id);
  await run(admin);
  assert.equal(admin.changes.length, 0);
  adminRoles.clear();
  const staff = fixture();
  process.env.TICKET_STAFF_ROLE_IDS = staff.role.id;
  await run(staff);
  assert.equal(staff.changes.length, 0);
});

test("malformed staff configuration still protects its known staff IDs from self-service", async () => {
  const f = fixture();
  process.env.TICKET_STAFF_ROLE_IDS = `${f.role.id},,`;
  await run(f);
  assert.equal(f.changes.length, 0);
  assert.equal(title(f), "Role unavailable");
});

test("legacy Discord Admin names cannot be self-assigned through an explicit notification ID", async () => {
  const f = fixture({ name: " Discord Admin " });
  process.env.REACTION_ROLE_SITE_ID = f.role.id;
  await run(f);
  assert.equal(f.changes.length, 0);
  assert.equal(title(f), "Role unavailable");
});

test("unknown future notification permission bits fail closed", async () => {
  const unknown = 1n << 60n;
  assert.equal(Object.values(PermissionFlagsBits).includes(unknown), false);
  const f = await run(fixture({ permissions: [unknown] }));
  assert.equal(f.changes.length, 0);
  assert.equal(title(f), "Role unavailable");
});

test("@everyone cannot be used as a notification role", async () => {
  const f = fixture();
  f.role.id = "guild"; f.role.name = "@everyone";
  f.interaction.guild.roles.cache = new Collection([["guild", f.role]]);
  process.env.REACTION_ROLE_SITE_ID = "guild";
  await run(f);
  assert.equal(f.changes.length, 0);
  assert.equal(title(f), "Role unavailable");
});

test("expired acknowledgement does not assign or remove any role", async () => {
  const f = await run(fixture({ expired: true }));
  assert.deepEqual(f.events, ["defer"]);
  assert.equal(f.changes.length, 0);
});

test("overlapping role clicks make one change and privately explain the pending action", async () => {
  const first = fixture();
  const second = fixture();
  second.interaction.guild = first.interaction.guild;
  await Promise.all([run(first), run(second)]);
  assert.equal(first.changes.length, 1);
  assert.match(second.replies.at(-1).content, /already in progress/);
});

test("ordinary communication permissions remain valid for dedicated notification roles", async () => {
  const f = await run(fixture({ permissions: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }));
  assert.equal(f.changes.length, 1);
});

test("role-fetch failures release the per-member lock", async () => {
  const failed = fixture();
  failed.interaction.guild.roles.fetch = async () => { throw new Error("Discord unavailable"); };
  await run(failed);
  assert.equal(failed.changes.length, 0);
  const next = await run(fixture());
  assert.equal(next.changes.length, 1);
});

test("a role confirmation notice failure does not repeat or misreport the applied change", async () => {
  const f = fixture();
  f.interaction.editReply = async () => { throw new Error("Notice delivery failed"); };
  await assert.doesNotReject(run(f));
  assert.equal(f.changes.length, 1);
  assert.equal(console.warn.mock.calls.at(-1).arguments[0], "Notification role changed but confirmation notice failed");
});

test("inherited object keys are not role-button custom IDs", async () => {
  const f = fixture();
  f.interaction.customId = "__proto__";
  assert.equal(await handleButtonInteraction(f.interaction), false);
  assert.deepEqual(f.events, []);
});
