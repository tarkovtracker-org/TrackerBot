import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChannelType } from "discord.js";
import { getNikitaXFeedConfig } from "../src/config/env.js";
import { pollNikitaXFeed } from "../src/handlers/nikitaXFeed.js";

const time = Date.parse("2026-05-12T11:04:00Z");
const channelId = "100000000000000001";
const userId = "100000000000000002";
const botId = "100000000000000003";
const xId = offset => ((BigInt(time + offset) - 1288834974657n) << 22n).toString();
const image = "https://pbs.twimg.com/media/server.jpg";
const extraImage = "https://pbs.twimg.com/media/rack.jpg";

function post(offset, values = {}) {
  return { id: xId(offset), text: "Hello from X", created_at: new Date(time + offset).toISOString(), lang: "en", ...values };
}

function missing(id) {
  return { type: "https://api.x.com/2/problems/resource-not-found", resource_type: "post", resource_id: id };
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
  let currentTime = time + 1000;
  let nextMessage = 100000000000000003n;
  const channel = {
    type: ChannelType.GuildText,
    permissionsFor: () => ({ has: () => true }),
    async send(payload) {
      nextMessage++;
      const id = nextMessage.toString();
      const message = {
        id, createdTimestamp: currentTime, author: { id: botId },
        embeds: payload.embeds.map(embed => embed.toJSON?.() ?? embed)
      };
      messages.set(id, message);
      operations.push({ type: "send", id, payload });
      if (channel.loseResponse) throw new Error("Discord accepted the send before the connection dropped");
      return message;
    },
    messages: {
      async fetch({ before, limit }) {
        return new Map([...messages].reverse().filter(([id]) => !before || id < before).slice(0, limit));
      },
      async edit(id, payload) {
        assert.ok(messages.has(id));
        operations.push({ type: "edit", id, payload });
      },
      async delete(id) {
        assert.ok(messages.delete(id));
        operations.push({ type: "delete", id });
      }
    }
  };
  const client = {
    user: { id: botId },
    channels: {
      async fetch(id) {
        assert.equal(id, channelId);
        return channel;
      }
    }
  };

  const feed = {
    config, env, channel, operations, calls, messages,
    timeline: () => ({ meta: { result_count: 0 } }),
    lookup: () => assert.fail("Unexpected X post lookup"),
    translate: () => assert.fail("Unexpected translation"),
    advance: ms => { currentTime += ms; },
    read: async () => JSON.parse(await readFile(config.stateFile, "utf8")),
    async poll() {
      await pollNikitaXFeed(client, config, {
        now: () => currentTime,
        async fetchImpl(url, options) {
          calls.push({ url, options });
          assert.equal(options.redirect, "error");
          if (url.origin === config.translateUrl.origin) {
            assert.equal(options.headers.Authorization, undefined);
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
            default:
              assert.fail(`Unexpected URL: ${url}`);
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
    referenced_posts: [{ type: "replied_to", id: xId(0) }],
    attachments: { media_keys: ["photo_1", "photo_2", "wrong_origin"] }
  });
  const repost = post(3, { referenced_tweets: [{ type: "retweeted", id: xId(0) }] });
  const quote = post(4, { referenced_posts: [{ type: "quoted", id: xId(0) }] });
  feed.timeline = params => {
    assert.equal(params.get("since_id"), xId(1));
    assert.equal(params.get("exclude"), "retweets");
    assert.match(params.get("tweet.fields"), /created_at.*note_tweet.*referenced_tweets/);
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
  const [embed, second] = payload.embeds;
  const rendered = embed.toJSON();
  assert.match(rendered.description, /Обновление сегодня/);
  assert.equal(rendered.url, `https://x.com/nikgeneburn/status/${reply.id}`);
  assert.equal(rendered.timestamp, reply.created_at);
  assert.equal(rendered.image.url, image);
  assert.equal(second.image.url, extraImage);
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
    post(2, { lang: "qme", text: "#untarcontrol https://t.co/synthetic", attachments: { media_keys: ["photo"] } }),
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
  const entry = post(2, { text: "Обновление сегодня", lang: "ru" });
  feed.timeline = () => ({ data: [entry] });
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
  assert.equal((await feed.read()).published[entry.id].retryTranslationAt, 0);
});

test("recovers a Discord send with a lost receipt after restarting without another send", async t => {
  const feed = await fixture(t);
  await feed.seed();
  const entry = post(2);
  feed.timeline = () => ({ data: [entry] });
  feed.channel.loseResponse = true;
  await assert.rejects(feed.poll(), /connection dropped/);
  assert.equal((await feed.read()).sinceId, xId(1));
  assert.equal((await feed.read()).pending.id, entry.id);

  feed.advance(20 * 60_000); // Past Discord's short nonce de-duplication window.
  feed.channel.loseResponse = false;
  feed.lookup = () => ({ data: [entry] });
  await feed.poll();
  assert.deepEqual(feed.operations.map(operation => operation.type), ["send", "edit"]);
  const checkpoint = await feed.read();
  assert.equal(checkpoint.sinceId, entry.id);
  assert.equal(checkpoint.pending, null);
  assert.equal(checkpoint.published[entry.id].messageId, feed.operations[0].id);
});

test("refetches edited content, preserves the original timestamp and removes confirmed unavailable posts", async t => {
  const feed = await fixture(t);
  await feed.seed();
  const entry = post(2);
  const revised = post(3, { text: "Corrected X text", edit_history_post_ids: [entry.id, xId(3)] });
  feed.timeline = () => ({ data: [entry] });
  await feed.poll();
  feed.advance(12 * 60 * 60_000);
  feed.lookup = ids => ({
    data: [ids[0] === entry.id ? { ...entry, edit_history_post_ids: revised.edit_history_post_ids } : revised]
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
  feed.lookup = ids => ({ errors: [missing(ids[0])] });
  await feed.poll();
  assert.deepEqual(feed.operations.at(-1), { type: "delete", id: sent.id });
  assert.deepEqual((await feed.read()).published, {});
});

test("corrupt state and a failed X poll stop without dropping the delivery cursor", async t => {
  const feed = await fixture(t);
  await feed.seed();
  feed.timeline = () => new Response(null, { status: 429, headers: { "Retry-After": "30" } });
  await assert.rejects(feed.poll(), error => error.code === "X_HTTP_429" && error.retryAt > Date.now());
  assert.equal((await feed.read()).sinceId, xId(1));
  await writeFile(feed.config.stateFile, "{}");
  await assert.rejects(feed.poll(), { code: "X_FEED_STATE" });
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
