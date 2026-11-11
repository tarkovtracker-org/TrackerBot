import test from "node:test";
import assert from "node:assert/strict";
import { Events } from "discord.js";
import { registerInteractionHandler } from "../src/handlers/interactionHandler.js";

for (const failure of [Object.assign(new Error("Synthetic Discord failure"), {
  code: 10062,
  url: "https://discord.com/api/v10/interactions/test-id/synthetic-interaction-token/callback",
  requestBody: { json: { content: "private synthetic preview" } }
}), null]) {
  test(`interaction errors log only safe diagnostics (${failure === null ? "null" : "API error"})`, async t => {
    t.mock.method(console, "error", () => {});
    let listener;
    registerInteractionHandler({ on: (event, handler) => {
      assert.equal(event, Events.InteractionCreate);
      listener = handler;
    } });
    let attempts = 0;
    const interaction = {
      inGuild: () => false,
      isRepliable: () => true,
      deferred: false,
      replied: false,
      reply: async () => { attempts++; throw failure; }
    };
    await assert.doesNotReject(listener(interaction));
    assert.equal(attempts, 2, "the failed safe recovery is contained too");
    assert.deepEqual(console.error.mock.calls.map(call => call.arguments), [
      ["Unhandled interaction error:", { name: failure?.name ?? "unknown", code: failure?.code ?? "unknown" }]
    ]);
  });
}
