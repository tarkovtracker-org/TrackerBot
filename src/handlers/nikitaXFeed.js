import { ChannelType, PermissionFlagsBits, escapeMarkdown } from "discord.js";
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
    if (error.code === 10008) return false; // The Discord message was already removed.
    throw error;
  }
}

export async function pollNikitaXFeed(client, config, { fetchImpl = fetch, now = Date.now } = {}) {
  const channel = await client.channels.fetch(config.channelId);
  if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)
      || !channel.permissionsFor(client.user)?.has(requiredPermissions)) {
    throw Object.assign(new Error("Nikita X feed destination is unavailable"), { code: "X_FEED_CHANNEL" });
  }

  const x = createNikitaXApi(config.bearerToken, fetchImpl);
  const save = state => saveNikitaXState(config.stateFile, state);
  const state = await loadNikitaXState(config.stateFile, config.channelId);
  if (!state) {
    const userId = await x.resolveUserId();
    const posts = await x.timeline(userId, null, { seed: true });
    await save({
      version: 1, channelId: config.channelId, userId, sinceId: posts.at(-1)?.id ?? null,
      lastReviewAt: now(), pending: null, published: {}
    });
    return;
  }

  async function publish(post, existing) {
    const { payload, retryTranslationAt } = await makeMessage(post, config, fetchImpl, now);
    let messageId = existing?.id;
    if (messageId) {
      if (!await syncMessage(channel, messageId, payload)) return null;
    } else {
      const message = await channel.send({ ...payload, nonce: post.sourceId, enforceNonce: true });
      messageId = message.id;
    }
    return { messageId, versionId: post.id, retryTranslationAt };
  }

  if (state.pending) {
    const { id, sourceId } = state.pending;
    const post = (await x.lookup([id])).get(id);
    if (post && post.sourceId !== sourceId) {
      throw Object.assign(new Error("Mismatched pending X post"), { code: "X_PAYLOAD" });
    }
    const existing = await findPendingMessage(channel, client.user.id, state.pending);
    if (post && !post.skip) {
      const receipt = await publish(post, existing);
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
    const post = version.id === version.latestId ? version
      : returnedIds.has(version.latestId) ? null : (await x.lookup([version.id])).get(version.id);
    if (post?.sourceId !== undefined && post.sourceId !== version.sourceId) {
      throw Object.assign(new Error("Mismatched X timeline edit"), { code: "X_PAYLOAD" });
    }
    if (!post) continue;
    const known = state.published[post.sourceId];
    if (known && comparePostIds(post.id, known.versionId) > 0) {
      await refresh(post.sourceId, known, post);
    } else if (!known && !post.skip) {
      state.pending = { id: version.id, sourceId: post.sourceId, startedAt: now() };
      await save(state);
      state.published[post.sourceId] = await publish(post, null);
      state.pending = null;
    }
    state.sinceId = version.id;
    await save(state);
  }

  async function refresh(sourceId, record, post) {
    if (post && post.sourceId !== sourceId) {
      throw Object.assign(new Error("Mismatched published X post"), { code: "X_PAYLOAD" });
    }
    if (!post || post.skip) {
      await syncMessage(channel, record.messageId, null);
      delete state.published[sourceId];
    } else if (comparePostIds(post.id, record.versionId) > 0 || record.retryTranslationAt && record.retryTranslationAt <= now()) {
      const receipt = await publish(post, { id: record.messageId });
      if (receipt) state.published[sourceId] = receipt;
      else delete state.published[sourceId];
    }
  }

  const reviewAll = now() - state.lastReviewAt >= reviewInterval;
  const targets = Object.entries(state.published).filter(([, { retryTranslationAt }]) =>
    reviewAll || retryTranslationAt > 0 && retryTranslationAt <= now());
  for (let offset = 0; offset < targets.length; offset += 100) {
    const batch = targets.slice(offset, offset + 100);
    const posts = await x.lookup(batch.map(([, record]) => record.versionId));
    for (const [sourceId, record] of batch) {
      await refresh(sourceId, record, posts.get(record.versionId));
    }
    await save(state);
  }
  if (reviewAll) {
    state.lastReviewAt = now();
    await save(state);
  }
}

export function startNikitaXFeed(client) {
  let config;
  try {
    config = getNikitaXFeedConfig();
  } catch {
    console.error("Nikita X feed configuration is invalid. Check the NIKITA_X_* settings.");
    return;
  }
  if (!config) return;

  let failures = 0;
  async function tick() {
    let nextDelay = pollInterval;
    try {
      if (client.isReady()) await pollNikitaXFeed(client, config);
      failures = 0;
    } catch (error) {
      failures = Math.min(failures + 1, 5);
      nextDelay = Math.max(pollInterval * 2 ** (failures - 1), (error?.retryAt ?? 0) - Date.now());
      const code = error?.code;
      console.error("Nikita X feed check failed", { code: /^[A-Z0-9_]{1,40}$/.test(code) ? code : "unknown" });
    }
    setTimeout(tick, Math.min(nextDelay, 2 ** 31 - 1)).unref();
  }
  void tick();
}
