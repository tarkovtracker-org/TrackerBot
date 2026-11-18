import assert from "node:assert/strict";
import fs, { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChannelType, PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { getNikitaXFeedConfig } from "../src/config/env.js";
import { pollNikitaXFeed } from "../src/handlers/nikitaXFeed.js";

const time = Date.parse("2026-05-12T11:04:00Z");
const channelId = "100000000000000001";
const userId = "100000000000000002";
const botId = "100000000000000003";
const otherChannelId = "100000000000000099";
const guildId = "100000000000000088";
const xId = offset => ((BigInt(time + offset) - 1288834974657n) << 22n).toString();
const image = "https://pbs.twimg.com/media/server.jpg";
const extraImage = "https://pbs.twimg.com/media/rack.jpg";

function post(offset, values = {}) {
  return { id: xId(offset), text: "Hello from X", created_at: new Date(time + offset).toISOString(), lang: "en", ...values };
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "trackerbot-nikita-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = {
    NIKITA_X_CHANNEL_ID: channelId,
    NIKITA_X_BEARER_TOKEN: "synthetic-x-token",
    NIKITA_X_STATE_FILE: join(dir, "feed.json"),
    NIKITA_X_TRANSLATE_URL: "https://translator.example.test/translate",
    NIKITA_X_TRANSLATE_API_KEY: "synthetic-translator-key"
  };
  const config = getNikitaXFeedConfig(env);
  const operations = [];
  const messages = new Map();
  const calls = [];
  const endpointHolds = new Map();
  let currentTime = time + 1000;
  let nextMessage = 100000000000000003n;
  const channel = {
    id: channelId,
    guildId,
    type: ChannelType.GuildText,
    guild: { members: { async fetchMe({ force }) { assert.equal(force, true); return { fresh: true }; } } },
    permissionsFor(member) {
      const permissions = new PermissionsBitField(PermissionsBitField.All).remove(PermissionFlagsBits.Administrator);
      if (channel.noHistory || member.fresh && channel.hideHistory) permissions.remove(PermissionFlagsBits.ReadMessageHistory);
      if (channel.noAttachments) permissions.remove(PermissionFlagsBits.AttachFiles);
      return permissions;
    },
    async send(payload) {
      nextMessage++;
      const id = nextMessage.toString();
      const message = {
        id, createdTimestamp: currentTime, author: { id: botId },
        embeds: payload.embeds.map(embed => embed.toJSON?.() ?? embed)
      };
      messages.set(id, message);
      operations.push({ type: "send", id, payload, channelId: this.id });
      if (channel.loseResponse) throw new Error("Discord accepted the send before the connection dropped");
      return message;
    },
    messages: {
      async fetch({ before, limit, message }) {
        if (message) return messages.get(message);
        if (channel.restoreHistoryAfterRead) {
          channel.restoreHistoryAfterRead = false;
          return new Map();
        }
        if (channel.hideHistory) return new Map();
        return new Map([...messages].reverse().filter(([id]) => !before || id < before).slice(0, limit));
      },
      async edit(id, payload) {
        const message = messages.get(id);
        assert.ok(message);
        message.embeds = payload.embeds.map(embed => embed.toJSON?.() ?? embed);
        operations.push({ type: "edit", id, payload });
        if (channel.loseEditResponse) throw new Error("Discord accepted the edit before the connection dropped");
      },
      async delete(id) {
        assert.ok(messages.delete(id));
        operations.push({ type: "delete", id });
      }
    }
  };
  const alternate = { ...channel, id: otherChannelId, messages: {
    ...channel.messages,
    async delete() { assert.fail("A receipt from the original channel must not be removed in the new channel"); }
  } };
  const client = {
    user: { id: botId },
    channels: {
      async fetch(id, { force }) {
        assert.ok([channelId, otherChannelId].includes(id));
        assert.equal(typeof force, "boolean");
        if (id === channelId && channel.deleted) throw Object.assign(new Error("Unknown Channel"), { code: 10003 });
        return id === channelId ? channel : alternate;
      }
    }
  };

  const feed = {
    config, env, channel, alternate, operations, calls, messages,
    get time() { return currentTime; },
    timeline: () => ({ meta: { result_count: 0 } }),
    lookup: () => assert.fail("Unexpected X post lookup"),
    translate: () => assert.fail("Unexpected translation"),
    advance: ms => { currentTime += ms; },
    read: async () => JSON.parse(await readFile(config.stateFile, "utf8")),
    async poll() {
      await pollNikitaXFeed(client, config, {
        endpointHolds,
        now: () => currentTime,
        async fetchImpl(url, options) {
          calls.push({ url, options });
          assert.equal(options.redirect, "error");
          if (url.origin === config.translateUrl.origin) {
            assert.equal(new Headers(options.headers).has("authorization"), false);
            const result = await feed.translate(JSON.parse(options.body));
            return result instanceof Response ? result : Response.json(result);
          }
          assert.equal(url.origin, "https://api.x.com");
          assert.equal(options.headers.Authorization, "Bearer synthetic-x-token");
          switch (url.pathname) {
            case "/2/users/by/username/nikgeneburn":
              return Response.json({ data: { id: userId, username: "nikgeneburn" } });
            case `/2/users/${userId}/tweets`: {
              const result = await feed.timeline(url.searchParams);
              return result instanceof Response ? result : Response.json(result);
            }
            case "/2/tweets": {
              const result = await feed.lookup(url.searchParams.get("ids").split(","));
              return result instanceof Response ? result : Response.json(result);
            }
            default: {
              if (url.pathname.startsWith("/2/tweets/")) {
                const result = await feed.lookup([url.pathname.split("/").at(-1)]);
                if (result instanceof Response) return result;
                return Response.json({ ...result, data: result.data?.[0] });
              }
              assert.fail(`Unexpected URL: ${url}`);
            }
          }
        }
      });
    },
    async seed() {
      feed.timeline = params => {
        assert.equal(params.has("since_id"), false);
        assert.equal(params.get("max_results"), "5");
        return { data: [post(1)] };
      };
      await feed.poll();
      assert.deepEqual(operations, []);
      feed.timeline = () => ({ meta: { result_count: 0 } });
    }
  };
  return feed;
}

test("feed is opt-in and requires a complete configuration and trusted HTTPS translator", async t => {
  const { env, config } = await fixture(t);
  assert.equal(getNikitaXFeedConfig({ NIKITA_X_BEARER_TOKEN: "token" }), null);
  assert.equal(config.stateFile, env.NIKITA_X_STATE_FILE);
  for (const invalid of [
    { NIKITA_X_BEARER_TOKEN: "" }, { NIKITA_X_CHANNEL_ID: "invalid" },
    { NIKITA_X_STATE_FILE: "relative.json" }, { NIKITA_X_TRANSLATE_URL: "http://example.test/translate" },
    { TRACKERBOT_DESTINATIONS_FILE: config.stateFile },
    { NIKITA_X_TRANSLATE_URL: "https://user:password@example.test/translate" }
  ]) {
    assert.throws(() => getNikitaXFeedConfig({ ...env, ...invalid }), /Invalid Nikita X feed/);
  }
});

test("seeds without backfill, paginates oldest first and mirrors replies, quotes, images and translation", async t => {
  const feed = await fixture(t);
  await feed.seed();
  const reply = post(2, {
    text: "Обновление сегодня. #Tarkov", lang: "ru",
    referenced_tweets: [{ type: "replied_to", id: xId(0) }],
    attachments: { media_keys: ["photo_1", "photo_2", "wrong_origin"] }
  });
  const repost = post(3, { referenced_tweets: [{ type: "retweeted", id: xId(0) }] });
  const quote = post(4, { referenced_tweets: [{ type: "quoted", id: xId(0) }] });
  feed.timeline = params => {
    assert.equal(params.get("since_id"), xId(1));
    assert.equal(params.get("exclude"), "retweets");
    const fields = params.get("tweet.fields").split(",");
    for (const field of ["created_at", "note_tweet", "referenced_tweets"]) assert.ok(fields.includes(field));
    assert.equal(params.get("expansions"), "attachments.media_keys");
    if (!params.has("pagination_token")) return { data: [quote, repost], meta: { next_token: "next-page" } };
    assert.equal(params.get("pagination_token"), "next-page");
    return {
      data: [reply, quote],
      includes: { media: [
        { media_key: "photo_2", type: "photo", url: extraImage },
        { media_key: "photo_1", type: "photo", url: image },
        { media_key: "wrong_origin", type: "photo", url: "https://not-x.example.test/collect" }
      ] }
    };
  };
  feed.translate = body => {
    assert.deepEqual(body, { q: reply.text, source: "auto", target: "en", format: "text", api_key: "synthetic-translator-key" });
    return { translatedText: "Update today. #Tarkov", detectedLanguage: { language: "ru" } };
  };
  await feed.poll();
  assert.deepEqual(feed.operations.map(({ type, payload }) => [type, payload.nonce]), [["send", reply.id], ["send", quote.id]]);
  const { payload } = feed.operations[0];
  const [rendered] = feed.messages.get(feed.operations[0].id).embeds;
  assert.match(rendered.description, /Обновление сегодня/);
  assert.equal(rendered.url, `https://x.com/nikgeneburn/status/${reply.id}`);
  assert.equal(rendered.timestamp, reply.created_at);
  assert.deepEqual(feed.messages.get(feed.operations[0].id).embeds.map(embed => embed.image?.url), [image, extraImage]);
  assert.deepEqual(rendered.fields, [{ name: "English · Machine translation", value: "Update today. #Tarkov" }]);
  assert.deepEqual(payload.allowedMentions.parse, []);
  assert.equal(payload.enforceNonce, true);

  feed.timeline = params => {
    assert.equal(params.get("since_id"), quote.id);
    return { data: [reply, quote] }; // Defensive against repeats from X.
  };
  await feed.poll();
  assert.equal(feed.operations.length, 2);
});

test("publishes hashtag-only posts without translation and attaches full long-form text", async t => {
  const feed = await fixture(t);
  await feed.seed();
  const text = "Full text. ".repeat(700);
  feed.timeline = () => ({ data: [
    post(2, { lang: "qme", text: "#untarcontrol https://t.co/synthetic", attachments: { media_keys: ["photo"] },
      referenced_posts: [{ type: "quoted", id: xId(0) }] }),
    post(3, { text: "Truncated text", note_tweet: { text } })
  ], includes: { media: [{ media_key: "photo", type: "photo", url: image }] } });
  await feed.poll();
  const [hashtag, long] = feed.operations;
  assert.match(hashtag.payload.embeds[0].toJSON().description, /#untarcontrol/);
  assert.equal(hashtag.payload.embeds[0].toJSON().image.url, image);
  assert.equal(long.payload.files[0].name, "x-post.txt");
  assert.equal(long.payload.files[0].attachment.toString(), text);
  assert.equal(feed.calls.filter(call => call.url.origin === feed.config.translateUrl.origin).length, 0);
});

test("translation failure delivers the original and updates the same message when the retry works", async t => {
  const feed = await fixture(t);
  await feed.seed();
  const entry = post(2, { text: "Обновление сегодня", lang: "ru", attachments: { media_keys: ["photo"] } });
  feed.timeline = () => ({ data: [entry], includes: { media: [{ media_key: "photo", type: "photo", url: image }] } });
  feed.translate = () => new Response(null, { status: 503 });
  await feed.poll();
  assert.equal(feed.operations[0].payload.embeds[0].toJSON().description, entry.text);
  assert.equal(feed.operations[0].payload.embeds[0].toJSON().fields, undefined);

  feed.advance(14 * 60_000);
  await feed.poll();
  assert.equal(feed.operations.length, 1);
  feed.advance(60_000);
  feed.lookup = ids => {
    assert.deepEqual(ids, [entry.id]);
    return { data: [entry] };
  };
  feed.translate = () => ({ translatedText: "Update today" });
  await feed.poll();
  const [sent, edited] = feed.operations;
  assert.equal(edited.type, "edit");
  assert.equal(edited.id, sent.id);
  assert.equal(edited.payload.embeds[0].toJSON().fields[0].value, "Update today");
  assert.equal(edited.payload.embeds[0].toJSON().image.url, image);
  assert.equal((await feed.read()).published[entry.id].retryTranslationAt, 0);
});

test("recovers a Discord send with a lost receipt after restarting without another send", async t => {
  const feed = await fixture(t);
  await feed.seed();
  const history = [xId(2), xId(3)];
  const entry = post(2, { edit_history_post_ids: history });
  const revision = post(3, { edit_history_post_ids: history, attachments: { media_keys: ["photo"] } });
  feed.timeline = () => ({ data: [entry] });
  feed.lookup = () => ({ data: [revision], includes: { media: [{ media_key: "photo", type: "photo", url: image }] } });
  feed.channel.loseResponse = true;
  await assert.rejects(feed.poll(), /connection dropped/);
  assert.equal((await feed.read()).sinceId, xId(1));
  assert.equal((await feed.read()).pending.id, entry.id);
  assert.equal((await feed.read()).pending.versionId, revision.id);

  feed.advance(20 * 60_000); // Past Discord's short nonce de-duplication window.
  feed.channel.loseResponse = false;
  feed.lookup = () => ({ data: [revision] });
  feed.channel.hideHistory = true;
  await assert.rejects(feed.poll(), { code: "X_FEED_CHANNEL" });
  assert.equal((await feed.read()).pending.id, entry.id);
  assert.equal(feed.operations.length, 1);
  feed.channel.hideHistory = false;
  feed.channel.restoreHistoryAfterRead = true;
  await feed.poll();
  assert.deepEqual(feed.operations.map(operation => operation.type), ["send", "edit"]);
  assert.equal(feed.operations[1].payload.embeds[0].toJSON().image.url, image);
  const checkpoint = await feed.read();
  assert.equal(checkpoint.sinceId, entry.id);
  assert.equal(checkpoint.pending, null);
  assert.equal(checkpoint.published[entry.id].messageId, feed.operations[0].id);
});

test("refetches edited content, preserves the original timestamp and removes confirmed unavailable posts", async t => {
  const feed = await fixture(t);
  await feed.seed();
  const entry = post(2);
  const edit = post(3, { text: "Superseded edit", edit_history_post_ids: [entry.id, xId(3), xId(4)] });
  const revised = post(4, { text: "Corrected X text", edit_history_post_ids: edit.edit_history_post_ids });
  feed.timeline = () => ({ data: [entry] });
  await feed.poll();
  feed.advance(12 * 60 * 60_000);
  feed.lookup = ([id]) => ({
    data: [id === entry.id ? { ...entry, edit_history_post_ids: [entry.id, edit.id] } : id === edit.id ? edit : revised]
  });
  await feed.poll();
  const [sent, edited] = feed.operations;
  assert.equal(edited.id, sent.id);
  assert.equal(edited.payload.embeds[0].toJSON().description, revised.text);
  assert.equal(edited.payload.embeds[0].toJSON().timestamp, entry.created_at);
  assert.equal(edited.payload.embeds[0].toJSON().url, `https://x.com/nikgeneburn/status/${entry.id}`);
  assert.deepEqual(edited.payload.attachments, []);

  feed.advance(12 * 60 * 60_000);
  feed.lookup = () => ({ errors: [{ type: "https://api.x.com/2/problems/internal-error" }] });
  await assert.rejects(feed.poll(), /Incomplete X post lookup/);
  assert.equal(feed.operations.length, 2);
  feed.lookup = ids => ({ errors: [{ resource_type: "tweet", resource_id: ids[0], title: "Not Found Error" }] });
  feed.timeline = () => new Response(null, { status: 503 });
  feed.channel.noAttachments = true;
  feed.channel.noHistory = true;
  await assert.rejects(feed.poll(), { code: "X_HTTP_503" });
  assert.deepEqual(feed.operations.at(-1), { type: "delete", id: sent.id });
  assert.deepEqual((await feed.read()).published, {});
  assert.equal((await feed.read()).sinceId, entry.id);
});

test("corrupt state and a failed X poll stop without dropping the delivery cursor", async t => {
  const feed = await fixture(t);
  await feed.seed();
  feed.timeline = () => new Response(null, { status: 429, headers: { "Retry-After": "30" } });
  await assert.rejects(feed.poll(), { code: "X_HTTP_429", retryAt: feed.time + 30_000 });
  assert.equal((await feed.read()).sinceId, xId(1));
  await writeFile(feed.config.stateFile, "{}");
  await assert.rejects(feed.poll(), { code: "X_FEED_STATE" });
  await writeFile(feed.config.stateFile, "{");
  await assert.rejects(feed.poll(), { code: "X_FEED_STATE" });
  assert.equal(await readFile(feed.config.stateFile, "utf8"), "{");
  assert.deepEqual(feed.operations, []);
});

test("a failed later timeline page cannot skip unseen older posts", async t => {
  const feed = await fixture(t);
  await feed.seed();
  feed.timeline = params => params.has("pagination_token")
    ? new Response(null, { status: 503 })
    : { data: [post(3)], meta: { next_token: "next-page" } };
  await assert.rejects(feed.poll(), { code: "X_HTTP_503" });
  assert.equal((await feed.read()).sinceId, xId(1));
  assert.deepEqual(feed.operations, []);
  feed.timeline = params => params.has("pagination_token")
    ? { data: [post(2)] }
    : { data: [post(3)], meta: { next_token: "next-page" } };
  await feed.poll();
  assert.deepEqual(feed.operations.map(operation => operation.payload.nonce), [xId(2), xId(3)]);
});

test("a failing lookup batch leaves later reviews independent and records only successful checks", async t => {
  const feed = await fixture(t);
  await feed.seed();
  const state = await feed.read();
  for (let offset = 2; offset <= 102; offset++) {
    state.published[xId(offset)] = {
      versionId: xId(offset), messageId: String(100000000000000000n + BigInt(offset)),
      mediaComplete: true, retryTranslationAt: 0, nextReviewAt: feed.time
    };
  }
  await writeFile(feed.config.stateFile, JSON.stringify(state));
  const batches = [];
  feed.lookup = ids => {
    batches.push(ids);
    return ids.length === 100 ? new Response(null, { status: 503 }) : { data: [post(102)] };
  };
  await assert.rejects(feed.poll(), { code: "X_HTTP_503" });
  assert.deepEqual(batches.map(batch => batch.length), [100, 1]);
  const checkpoint = await feed.read();
  assert.equal(checkpoint.published[xId(2)].nextReviewAt, feed.time);
  assert.equal(checkpoint.published[xId(102)].nextReviewAt, feed.time + 12 * 60 * 60_000);
  await assert.rejects(feed.poll(), { code: "X_HTTP_503" });
  assert.deepEqual(batches.map(batch => batch.length), [100, 1, 100]);
});

test("a later lookup adds missing previews without replacing the existing translation", async t => {
  const feed = await fixture(t);
  await feed.seed();
  const entry = post(2, { text: "Скоро", lang: "ru", attachments: { media_keys: ["photo"] } });
  feed.translate = () => ({ translatedText: "Soon" });
  feed.timeline = () => ({ data: [entry], includes: { media: [{ media_key: "photo", type: "photo" }] } });
  await feed.poll();
  assert.equal(feed.operations[0].payload.embeds[0].toJSON().image, undefined);
  assert.equal((await feed.read()).published[entry.id].mediaComplete, false);

  feed.advance(12 * 60 * 60_000);
  feed.lookup = () => ({ data: [entry], includes: { media: [{ media_key: "photo", type: "photo", url: image }] } });
  feed.translate = () => new Response(null, { status: 503 });
  await feed.poll();
  const [sent, edited] = feed.operations;
  assert.equal(edited.id, sent.id);
  assert.equal(edited.payload.embeds[0].toJSON().image.url, image);
  assert.equal(edited.payload.embeds[0].toJSON().fields[0].value, "Soon");
  assert.equal(edited.payload.attachments, undefined);
  assert.equal(feed.calls.filter(call => call.url.origin === feed.config.translateUrl.origin).length, 1);
  assert.equal((await feed.read()).published[entry.id].mediaComplete, true);
});

test("new delivery requires message history before reserving or sending an alert", async t => {
  const feed = await fixture(t);
  await feed.seed();
  const entry = post(2);
  feed.timeline = () => ({ data: [entry] });
  feed.channel.noHistory = true;
  await assert.rejects(feed.poll(), { code: "X_FEED_CHANNEL" });
  assert.deepEqual(feed.operations, []);
  const checkpoint = await feed.read();
  assert.equal(checkpoint.sinceId, xId(1));
  assert.equal(checkpoint.pending, null);

  feed.channel.noHistory = false;
  await feed.poll();
  assert.deepEqual(feed.operations.map(operation => operation.payload.nonce), [entry.id]);
});

test("pending delivery and review share a lookup rate limit and a definite 404 clears pending", async t => {
  const feed = await fixture(t);
  await feed.seed();
  const original = post(2);
  const pending = post(3);
  feed.timeline = () => ({ data: [original] });
  await feed.poll();

  feed.advance(12 * 60 * 60_000);
  const state = await feed.read();
  state.pending = { id: pending.id, versionId: pending.id, sourceId: pending.id, startedAt: feed.time };
  await writeFile(feed.config.stateFile, JSON.stringify(state));
  let lookups = 0;
  feed.lookup = () => {
    lookups++;
    return new Response(null, { status: 429, headers: { "Retry-After": "30" } });
  };
  await assert.rejects(feed.poll(), { code: "X_HTTP_429" });
  await assert.rejects(feed.poll(), { code: "X_HTTP_429" });
  assert.equal(lookups, 1);
  assert.equal((await feed.read()).pending.id, pending.id);

  feed.advance(30_000);
  feed.lookup = ([id]) => id === pending.id ? new Response(null, { status: 404 }) : { data: [original] };
  feed.timeline = () => ({ data: [post(4)] });
  await feed.poll();
  assert.equal((await feed.read()).pending, null);
  assert.equal((await feed.read()).sinceId, xId(4));
  assert.deepEqual(feed.operations.map(operation => operation.payload.nonce), [original.id, xId(4)]);
});

test("a transient Windows sharing violation does not lose the delivery receipt", async t => {
  const feed = await fixture(t);
  await feed.seed();
  const rename = fs.rename;
  let writes = 0;
  t.mock.method(fs, "rename", async (from, to) => {
    if (to === feed.config.stateFile && ++writes === 2) {
      throw Object.assign(new Error("Synthetic sharing violation"), { code: "EPERM" });
    }
    await rename(from, to);
  });
  syncBuiltinESMExports();
  try {
    const entry = post(2);
    feed.timeline = () => ({ data: [entry] });
    await feed.poll();
    assert.equal(writes, 3);
    assert.equal((await feed.read()).published[entry.id].messageId, feed.operations[0].id);
    assert.equal((await feed.read()).pending, null);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("recovery uses the edit Discord accepted even when its response was lost", async t => {
  const feed = await fixture(t);
  await feed.seed();
  const original = post(2, { attachments: { media_keys: ["old"] } });
  const revised = post(3, { edit_history_tweet_ids: [original.id, xId(3)], attachments: { media_keys: ["new"] } });
  feed.timeline = () => ({ data: [original], includes: { media: [{ media_key: "old", type: "photo", url: image }] } });
  feed.channel.loseResponse = true;
  await assert.rejects(feed.poll(), /accepted the send/);
  feed.channel.loseResponse = false;
  feed.channel.loseEditResponse = true;
  feed.lookup = () => ({ data: [revised], includes: { media: [{ media_key: "new", type: "photo", url: extraImage }] } });
  await assert.rejects(feed.poll(), /accepted the edit/);
  assert.equal((await feed.read()).pending.versionId, original.id);
  feed.channel.loseEditResponse = false;
  feed.lookup = () => ({ data: [revised] });
  await feed.poll();
  assert.deepEqual(feed.operations.map(operation => operation.type), ["send", "edit", "edit"]);
  assert.equal(feed.operations[2].payload.embeds[0].toJSON().image.url, extraImage);
  assert.equal((await feed.read()).published[original.id].versionId, revised.id);
});

test("a failed revision lookup still applies settled deletions in the batch", async t => {
  const feed = await fixture(t);
  await feed.seed();
  const deleted = post(2);
  const original = post(3);
  feed.timeline = () => ({ data: [deleted, original] });
  await feed.poll();
  feed.advance(12 * 60 * 60_000);
  feed.lookup = ids => {
    if (ids.length === 1) {
      assert.deepEqual(ids, [xId(4)]);
      return new Response(null, { status: 503, headers: { "Retry-After": "15" } });
    }
    return {
      data: [{ ...original, edit_history_tweet_ids: [original.id, xId(4)] }],
      errors: [{ title: "Not Found Error", resource_type: "tweet", resource_id: deleted.id }]
    };
  };
  await assert.rejects(feed.poll(), { code: "X_HTTP_503", retryAt: feed.time + 15_000 });
  assert.deepEqual(feed.operations.at(-1), { type: "delete", id: feed.operations[0].id });
  const checkpoint = await feed.read();
  assert.equal(checkpoint.published[deleted.id], undefined);
  assert.equal(checkpoint.published[original.id].nextReviewAt, feed.time);
});

test("switching the feed destination preserves old receipts and relays new posts only to the new channel", async t => {
  const feed = await fixture(t);
  await feed.seed();
  const old = post(2);
  const recent = post(3);
  feed.timeline = () => ({ data: [old] });
  await feed.poll();
  const legacy = await feed.read();
  delete legacy.published[old.id].channelId;
  await writeFile(feed.config.stateFile, JSON.stringify(legacy));

  feed.config.guildId = guildId;
  feed.config.channelId = otherChannelId;
  feed.timeline = () => ({ data: [old, recent] });
  await feed.poll();
  assert.deepEqual(feed.operations.map(operation => [operation.channelId, operation.payload.embeds[0].toJSON().url]), [
    [channelId, `https://x.com/nikgeneburn/status/${old.id}`],
    [otherChannelId, `https://x.com/nikgeneburn/status/${recent.id}`]
  ]);
  assert.equal((await feed.read()).published[recent.id].channelId, otherChannelId);

  feed.config.channelId = undefined;
  feed.advance(12 * 60 * 60_000);
  feed.lookup = () => ({
    data: [recent], errors: [{ title: "Not Found Error", resource_type: "tweet", resource_id: old.id }]
  });
  await feed.poll();
  assert.deepEqual(feed.operations.at(-1), { type: "delete", id: feed.operations[0].id });
  assert.equal((await feed.read()).sinceId, recent.id);
});

test("a host-enabled feed cannot send to a channel outside its configured guild", async t => {
  const feed = await fixture(t);
  feed.config.guildId = "100000000000000077";
  await assert.rejects(feed.poll(), { code: "X_FEED_CHANNEL" });
  assert.deepEqual(feed.calls, []);
});

test("a deleted pending destination cannot block delivery to the new channel", async t => {
  const feed = await fixture(t);
  await feed.seed();
  const entry = post(2);
  feed.timeline = () => ({ data: [entry] });
  feed.channel.loseResponse = true;
  await assert.rejects(feed.poll(), /accepted the send/);
  feed.channel.loseResponse = false;
  feed.channel.deleted = true;
  feed.config.guildId = guildId;
  feed.config.channelId = otherChannelId;
  await feed.poll();
  assert.deepEqual(feed.operations.map(operation => operation.channelId), [channelId, otherChannelId]);
  assert.notEqual(feed.operations[0].payload.nonce, feed.operations[1].payload.nonce);
  const checkpoint = await feed.read();
  assert.equal(checkpoint.pending, null);
  assert.equal(checkpoint.published[entry.id].channelId, otherChannelId);
});
