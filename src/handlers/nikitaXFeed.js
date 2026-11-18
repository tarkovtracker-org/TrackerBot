import { ChannelType, Events, PermissionFlagsBits, escapeMarkdown } from "discord.js";
import { getNikitaXFeedConfig } from "../config/env.js";
import { comparePostIds, createNikitaXApi, nikitaHandle } from "../services/nikitaXApi.js";
import { loadNikitaXState, saveNikitaXState } from "../services/nikitaXState.js";
import { createCardEmbed } from "../utils/cardEmbed.js";
import { noMentions } from "../utils/messageReply.js";

const pollInterval = 120_000;
const reviewInterval = 12 * 60 * 60_000;
const translationRetryInterval = 15 * 60_000;
const requiredPermissions = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.ReadMessageHistory
];

const postUrl = id => `https://x.com/${nikitaHandle}/status/${id}`;

async function translate(post, config, fetchImpl) {
  if (/^en(?:-|$)/i.test(post.lang) || !/\p{L}/u.test(post.text.replace(/https?:\/\/\S+|[#@][\p{L}\p{M}\p{N}_]+/gu, ""))) {
    return { text: null, failed: false };
  }

  try {
    const response = await fetchImpl(config.translateUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: post.text, source: "auto", target: "en", format: "text", api_key: config.translateKey }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error("Translation request failed");
    const { translatedText, detectedLanguage } = await response.json();
    if (typeof translatedText !== "string" || !translatedText.trim()) throw new Error("Missing translation");
    const text = /^en(?:-|$)/i.test(detectedLanguage?.language) || translatedText.trim() === post.text.trim()
      ? null : translatedText;
    return { text, failed: false };
  } catch {
    console.warn("Nikita X translation request failed. The original will still be shown.");
    return { text: null, failed: true };
  }
}

async function makeMessage(post, config, fetchImpl, now) {
  const translation = await translate(post, config, fetchImpl);
  const files = [];
  const original = escapeMarkdown(post.text);
  if (original.length > 4096) files.push({ attachment: Buffer.from(post.text), name: "x-post.txt" });
  const embed = createCardEmbed({
    title: "Nikita Buyanov (@nikgeneburn) posted on X",
    description: original.length > 4096 ? "Original text attached." : original || undefined,
    timestamp: new Date(post.createdAt),
    footer: "X • Original post time"
  }).setURL(postUrl(post.sourceId));

  if (translation.text) {
    const escaped = escapeMarkdown(translation.text);
    if (escaped.length > 1024) {
      files.push({ attachment: Buffer.from(translation.text), name: "english-machine-translation.txt" });
      embed.addFields({ name: "English · Machine translation", value: "Translation attached." });
    } else {
      embed.addFields({ name: "English · Machine translation", value: escaped });
    }
  }

  const [firstImage, ...otherImages] = post.images.slice(0, 10);
  if (firstImage) embed.setImage(firstImage);
  const embeds = [embed, ...otherImages.map(url => ({ image: { url } }))];
  return {
    payload: { embeds, files, allowedMentions: noMentions },
    retryTranslationAt: translation.failed ? now() + translationRetryInterval : 0
  };
}

// Recover a Discord send that succeeded before the process could save the receipt.
async function findPendingMessage(channel, botId, pending) {
  let before;
  const earliest = pending.startedAt - 5 * 60_000;
  const link = postUrl(pending.sourceId);
  while (true) {
    const page = await channel.messages.fetch({ before, limit: 100, cache: false });
    let oldest;
    for (const message of page.values()) {
      if (message.createdTimestamp >= earliest && message.author.id === botId
          && message.embeds.some(embed => embed.url === link)) return message;
      if (!oldest || comparePostIds(message.id, oldest.id) < 0) oldest = message;
    }
    if (page.size < 100 || !oldest || oldest.createdTimestamp < earliest) return null;
    before = oldest.id;
  }
}

async function syncMessage(channel, messageId, payload) {
  try {
    if (!payload) {
      await channel.messages.delete(messageId);
    } else {
      await channel.messages.edit(messageId, { ...payload, attachments: [] });
    }
    return true;
  } catch (error) {
    if (error?.code === 10008) return false; // The Discord message was already removed.
    throw error;
  }
}

function channelError() {
  return Object.assign(new Error("Nikita X feed destination is unavailable"), { code: "X_FEED_CHANNEL" });
}

async function getDestination(client, channelId, { verifyHistory = false } = {}) {
  const channel = await client.channels.fetch(channelId, { force: verifyHistory });
  if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) throw channelError();
  const member = verifyHistory ? await channel.guild.members.fetchMe({ force: true }) : client.user;
  if (!channel.permissionsFor(member)?.has(requiredPermissions)) throw channelError();
  return channel;
}

function checkedPost(post, sourceId) {
  if (post === undefined || post && post.sourceId !== sourceId) {
    throw lookupError();
  }
  return post;
}

function lookupError() {
  return Object.assign(new Error("Incomplete X post lookup"), { code: "X_PAYLOAD" });
}

async function retainPreviews(channel, post, messageId) {
  try {
    const message = await channel.messages.fetch({ message: messageId, cache: false, force: true });
    const urls = message.embeds.map(embed => embed.image?.url).filter(Boolean);
    return { ...post, images: [...new Set([...urls, ...post.images])] };
  } catch (error) {
    if (error?.code === 10008) return post; // The edit will also report the missing message.
    throw error;
  }
}

export async function pollNikitaXFeed(client, config, { fetchImpl = fetch, now = Date.now, runPhase } = {}) {
  const channel = await getDestination(client, config.channelId);
  const x = createNikitaXApi(config.bearerToken, fetchImpl, now);
  const load = () => loadNikitaXState(config.stateFile, config.channelId);
  const save = state => saveNikitaXState(config.stateFile, state);
  const errors = [];
  const phase = runPhase ?? (async (_, run) => {
    try {
      await run();
    } catch (error) {
      errors.push(error);
    }
  });

  async function publish(post, existing) {
    const messageId = existing?.id;
    const needsPreviews = messageId && !post.mediaComplete && existing.versionId === post.id;
    const displayPost = needsPreviews ? await retainPreviews(channel, post, messageId) : post;
    const { payload, retryTranslationAt } = await makeMessage(displayPost, config, fetchImpl, now);
    const receipt = { versionId: post.id, retryTranslationAt, nextReviewAt: now() + reviewInterval };
    if (messageId) {
      return await syncMessage(channel, messageId, payload) ? { messageId, ...receipt } : null;
    }
    const message = await channel.send({ ...payload, nonce: post.sourceId, enforceNonce: true });
    return { messageId: message.id, ...receipt };
  }

  async function refresh(state, sourceId, record, post) {
    if (!post || post.skip) {
      await syncMessage(channel, record.messageId, null);
      delete state.published[sourceId];
      return;
    }

    const versionOrder = comparePostIds(post.id, record.versionId);
    if (versionOrder < 0) throw lookupError();
    if (versionOrder > 0 || record.retryTranslationAt && record.retryTranslationAt <= now()) {
      const receipt = await publish(post, { id: record.messageId, versionId: record.versionId });
      if (receipt) state.published[sourceId] = receipt;
      else delete state.published[sourceId];
    } else {
      record.nextReviewAt = now() + reviewInterval;
    }
  }

  async function deliver(state) {
    if (!state) {
      const userId = await x.resolveUserId();
      const posts = await x.timeline(userId, null, { seed: true });
      await save({ version: 1, channelId: config.channelId, userId, sinceId: posts.at(-1)?.id ?? null, pending: null, published: {} });
      return;
    }

    if (state.pending) {
      const { id, sourceId } = state.pending;
      const post = checkedPost((await x.lookup([id])).get(id), sourceId);
      const existing = await findPendingMessage(channel, client.user.id, state.pending);
      // Discord can return an empty history when access is lost. Recheck permissions before trusting that result.
      if (!existing) await getDestination(client, config.channelId, { verifyHistory: true });
      if (post && !post.skip) {
        const receipt = await publish(post, existing && { id: existing.id, versionId: id });
        if (receipt) state.published[sourceId] = receipt;
      } else if (existing) {
        await syncMessage(channel, existing.id, null);
      }
      state.pending = null;
      state.sinceId = id;
      await save(state);
    }

    const timeline = await x.timeline(state.userId, state.sinceId);
    const returnedIds = new Set(timeline.map(post => post.id));
    for (const version of timeline) {
      let post = version;
      if (version.id !== version.latestId) {
        if (returnedIds.has(version.latestId)) continue;
        post = checkedPost((await x.lookup([version.id])).get(version.id), version.sourceId);
      }
      const known = state.published[version.sourceId];
      if (known && (!post || comparePostIds(post.id, known.versionId) > 0)) {
        await refresh(state, version.sourceId, known, post);
      } else if (!known && post && !post.skip) {
        state.pending = { id: version.id, sourceId: post.sourceId, startedAt: now() };
        await save(state);
        state.published[post.sourceId] = await publish(post, null);
        state.pending = null;
      }
      state.sinceId = version.id;
      await save(state);
    }
  }

  async function review() {
    // Read the last durable state even if delivery was interrupted mid-send.
    const state = await load();
    if (!state) return;
    const time = now();
    const targets = Object.entries(state.published).filter(([, record]) =>
      record.nextReviewAt <= time || record.retryTranslationAt > 0 && record.retryTranslationAt <= time);
    let firstError;
    for (let offset = 0; offset < targets.length; offset += 100) {
      const batch = targets.slice(offset, offset + 100);
      let posts;
      try {
        posts = await x.lookup(batch.map(([, record]) => record.versionId));
      } catch (error) {
        if (error?.retryAt > time || error?.code === "X_HTTP_429") throw error;
        firstError ??= error;
        continue;
      }
      for (const [sourceId, record] of batch) {
        try {
          await refresh(state, sourceId, record, checkedPost(posts.get(record.versionId), sourceId));
        } catch (error) {
          firstError ??= error;
        }
      }
      await save(state);
    }
    if (firstError) throw firstError;
  }

  const state = await load();
  await phase("timeline", () => deliver(state));
  if (state) await phase("review", review);
  if (errors.length) throw errors[0];
}

export function setupNikitaXFeed(client) {
  let config;
  try {
    config = getNikitaXFeedConfig();
  } catch {
    console.error("Nikita X feed configuration is invalid. Check the NIKITA_X_* settings.");
    return;
  }
  if (!config) return;

  function logError(scope, error) {
    const code = error?.code;
    console.error("Nikita X feed check failed", { scope, code: /^[A-Z0-9_]{1,40}$/.test(code) ? code : "unknown" });
  }

  const failures = new Map();
  async function runPhase(scope, run) {
    const previous = failures.get(scope);
    if (previous?.retryAt > Date.now()) return;
    try {
      await run();
      failures.delete(scope);
    } catch (error) {
      const count = Math.min((previous?.count ?? 0) + 1, 5);
      const retryAt = Math.max(Date.now() + pollInterval * 2 ** (count - 1), error?.retryAt ?? 0);
      failures.set(scope, { count, retryAt });
      logError(scope, error);
    }
  }

  async function tick() {
    try {
      if (client.isReady()) await pollNikitaXFeed(client, config, { runPhase });
    } catch (error) {
      logError("startup", error);
    } finally {
      setTimeout(tick, pollInterval).unref();
    }
  }
  client.once(Events.ClientReady, tick);
}
