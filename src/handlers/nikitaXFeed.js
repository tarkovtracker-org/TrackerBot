import { createHash } from "node:crypto";
import { ChannelType, EmbedBuilder, Events, PermissionFlagsBits, escapeMarkdown } from "discord.js";
import { getNikitaXFeedConfig } from "../config/env.js";
import { getNikitaGuildIds, getNikitaSubscription, isDiscordId, withDestinationReadLock } from "../config/destinations.js";
import { comparePostIds, createNikitaXApi, isPostId, nikitaHandle } from "../services/nikitaXApi.js";
import { openNikitaXState } from "../services/nikitaXState.js";
import { createCardEmbed } from "../utils/cardEmbed.js";
import { noMentions } from "../utils/messageReply.js";

const pollInterval = 120_000;
const reviewInterval = 12 * 60 * 60_000;
const translationRetryInterval = 15 * 60_000;
const translationLabel = "English · Machine translation";
const translationFilename = "english-machine-translation.txt";
const publishingPermissions = [
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AttachFiles
];

const postUrl = id => `https://x.com/${nikitaHandle}/status/${id}`;

function withImages(embed, images) {
  const [firstImage, ...otherImages] = images.slice(0, 10);
  embed.setImage(firstImage ?? null);
  return [embed, ...otherImages.map(url => ({ image: { url } }))];
}

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
    title: "Posted on X",
    description: original.length > 4096 ? "Original text attached." : original || undefined,
    timestamp: new Date(post.createdAt),
    footer: "X • Original post time"
  }).setURL(postUrl(post.sourceId))
    .setAuthor({ name: "Nikita Buyanov (@nikgeneburn)", url: postUrl(post.id) });

  if (translation.text) {
    const escaped = escapeMarkdown(translation.text);
    if (escaped.length > 1024) {
      files.push({ attachment: Buffer.from(translation.text), name: translationFilename });
      embed.addFields({ name: translationLabel, value: "Translation attached." });
    } else {
      embed.addFields({ name: translationLabel, value: escaped });
    }
  }

  return {
    payload: { embeds: withImages(embed, post.images), files, allowedMentions: noMentions },
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
      if (message.createdTimestamp >= earliest && message.author.id === botId) {
        const original = message.embeds.find(embed => embed.url === link);
        if (original) {
          const revisionLink = original.author?.url;
          const versionId = revisionLink?.startsWith(postUrl("")) ? revisionLink.slice(postUrl("").length) : null;
          return { id: message.id, versionId: isPostId(versionId) ? versionId : pending.versionId, message };
        }
      }
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
      await channel.messages.edit(messageId, payload);
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

const channelInaccessible = error => ["X_FEED_CHANNEL", 50001, 50013].includes(error?.code);

function requirePublishingPermissions(channel, member, creating) {
  const permissions = channel.permissionsFor(member);
  if (!permissions?.has(publishingPermissions)
      || creating && !permissions.has(PermissionFlagsBits.ReadMessageHistory)) throw channelError();
}

async function getDestination(client, channelId, { verifyHistory = false, guildId } = {}) {
  const channel = await client.channels.fetch(channelId, { force: verifyHistory });
  if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) throw channelError();
  if (guildId && channel.guildId !== guildId) throw channelError();
  const member = verifyHistory ? await channel.guild.members.fetchMe({ force: true }) : client.user;
  const permissions = channel.permissionsFor(member);
  if (!permissions?.has(PermissionFlagsBits.ViewChannel)
      || verifyHistory && !permissions.has(PermissionFlagsBits.ReadMessageHistory)) throw channelError();
  return channel;
}

function checkedPost(post, sourceId, retryError) {
  if (post === undefined || post && post.sourceId !== sourceId) {
    throw retryError ?? lookupError();
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

export async function pollNikitaXFeed(client, config, { fetchImpl = fetch, now = Date.now, runPhase, endpointHolds = new Map() } = {}) {
  const store = await openNikitaXState(config.stateFile);
  const x = createNikitaXApi(config.bearerToken, fetchImpl, now, endpointHolds);
  const errors = [];
  const phase = runPhase ?? (async (_, run) => {
    try {
      await run();
    } catch (error) {
      errors.push(error);
    }
  });

  const channelOwners = new Map();
  function findGuild(channelId) {
    if (!channelOwners.has(channelId)) {
      channelOwners.set(channelId, client.channels.fetch(channelId, { force: false }).then(channel =>
        isDiscordId(channel?.guildId) ? channel.guildId : undefined, error => {
        if (!channelInaccessible(error)) throw error;
      }));
    }
    return channelOwners.get(channelId);
  }

  let defaultGuild = config.guildId;
  if (config.channelId && !defaultGuild) {
    await phase("host-default", async () => { defaultGuild = await findGuild(config.channelId); });
  }
  const old = store.legacy;
  if (old && !store.guildIds().includes(old.guildId)) {
    await phase("migration", async () => {
      const guildId = old.guildId ?? await findGuild(old.channelId);
      if (guildId) await store.migrate(guildId);
    });
  }

  function subscription(guildId) {
    const saved = getNikitaSubscription(guildId);
    if (saved !== undefined) return saved;
    if (config.channelId && guildId === defaultGuild) return { channelId: config.channelId };
    return null;
  }

  const guilds = new Set([...store.guildIds(), ...getNikitaGuildIds()]);
  if (defaultGuild && config.channelId) guilds.add(defaultGuild);
  const entries = [...guilds].map(guildId => ({ guildId, saved: store.load(guildId), selected: subscription(guildId) }));
  const resumed = entries.filter(({ saved, selected }) => saved && selected && saved.subscriptionId === selected.subscriptionId);
  const cursors = resumed.map(({ saved }) => saved.sinceId);
  const checkpoints = cursors.filter(Boolean).sort(comparePostIds);
  const oldest = cursors.includes(null) ? null : checkpoints[0] ?? null;
  const existingUserId = entries.find(({ saved }) => saved)?.saved.userId;
  let timelineRequest;
  function timeline() {
    return timelineRequest ??= (async () => {
      const userId = existingUserId ?? await x.resolveUserId();
      const posts = await x.timeline(userId, oldest, { seed: resumed.length === 0 });
      const head = [posts.at(-1)?.id, checkpoints.at(-1)].filter(Boolean).sort(comparePostIds).at(-1);
      return { userId, posts, sinceId: head ?? null };
    })();
  }

  const deliveries = entries.map(({ guildId, selected }) => pollDestination(client, config, {
    guildId, phase: (scope, run) => phase(`${guildId}:${scope}`, run), x, timeline, fetchImpl, now,
    load: () => store.load(guildId), save: state => store.save(guildId, state),
    subscriptionId: selected?.subscriptionId,
    activeChannelId() {
      const current = subscription(guildId);
      if (selected && current && current.subscriptionId === selected.subscriptionId) return current.channelId;
    }
  }));
  const retired = store.legacy;
  if (retired && store.guildIds().includes(retired.guildId)) {
    deliveries.push(pollDestination(client, config, {
      guildId: retired.guildId, phase: (scope, run) => phase(`legacy:${scope}`, run), x, timeline, fetchImpl, now,
      load: () => store.legacy, save: state => store.saveLegacy(state),
      subscriptionId: retired.subscriptionId, activeChannelId: () => undefined
    }));
  }
  await Promise.all(deliveries);
  if (errors.length) throw errors[0];
}

async function pollDestination(client, config, {
  guildId, phase, x, timeline, fetchImpl, now, load, save, subscriptionId, activeChannelId
}) {
  const channels = new Map();
  function getChannel(id, verifyHistory = false) {
    if (verifyHistory) return getDestination(client, id, { verifyHistory, guildId });
    if (!channels.has(id)) channels.set(id, getDestination(client, id, { guildId }));
    return channels.get(id);
  }
  async function getReceiptChannel(id) {
    try {
      return await getChannel(id);
    } catch (error) {
      if (error?.code === 10003) return null; // A deleted channel has no remaining messages.
      throw error;
    }
  }
  async function publish(channel, post, existing) {
    const messageId = existing?.id;
    requirePublishingPermissions(channel, client.user, !messageId);
    const needsPreviews = messageId && !post.mediaComplete && existing.versionId === post.id;
    const displayPost = needsPreviews ? await retainPreviews(channel, post, messageId) : post;
    const { payload, retryTranslationAt } = await makeMessage(displayPost, config, fetchImpl, now);
    const receipt = { channelId: channel.id, versionId: post.id, mediaComplete: post.mediaComplete,
      retryTranslationAt, nextReviewAt: now() + reviewInterval };
    if (messageId) {
      const attachments = [];
      if (retryTranslationAt && existing.versionId === post.id) {
        try {
          const message = existing.message ?? await channel.messages.fetch({ message: messageId, cache: false, force: true });
          const field = message?.embeds[0]?.fields?.find(entry => entry.name === translationLabel);
          if (field) {
            payload.embeds[0].addFields(field);
            for (const attachment of message.attachments?.values() ?? []) {
              if (attachment.name === translationFilename) attachments.push({ id: attachment.id });
            }
            receipt.retryTranslationAt = 0;
          }
        } catch (error) {
          if (error?.code === 10008) return null;
          throw error;
        }
      }
      return await syncMessage(channel, messageId, { ...payload, attachments }) ? { messageId, ...receipt } : null;
    }
    const nonce = createHash("sha256").update(`${channel.id}:${post.sourceId}`).digest("base64url").slice(0, 25);
    const message = await channel.send({ ...payload, nonce, enforceNonce: true });
    return { messageId: message.id, ...receipt };
  }

  async function lookupPost(id, sourceId) {
    const { posts, retryError } = await x.lookup([id]);
    return checkedPost(posts.get(id), sourceId, retryError);
  }

  async function repairMedia(channel, record, post) {
    requirePublishingPermissions(channel, client.user, false);
    try {
      const message = await channel.messages.fetch({ message: record.messageId, cache: false, force: true });
      const embeds = withImages(EmbedBuilder.from(message.embeds[0]), post.images);
      // Edit the embeds only. Discord keeps any existing text and translation attachments.
      return await syncMessage(channel, record.messageId, { embeds, allowedMentions: noMentions });
    } catch (error) {
      if (error?.code === 10008) return false;
      throw error;
    }
  }

  async function refresh(state, sourceId, record, post) {
    const channel = await getReceiptChannel(record.channelId ?? state.channelId);
    if (!channel) {
      delete state.published[sourceId];
      return;
    }
    if (!post || post.skip) {
      await syncMessage(channel, record.messageId, null);
      delete state.published[sourceId];
      return;
    }

    const versionOrder = comparePostIds(post.id, record.versionId);
    if (versionOrder < 0) throw lookupError();
    const mediaAvailable = !record.mediaComplete && post.mediaComplete;
    if (versionOrder > 0 || record.retryTranslationAt && record.retryTranslationAt <= now()) {
      const receipt = await publish(channel, post, { id: record.messageId, versionId: record.versionId });
      if (receipt) state.published[sourceId] = receipt;
      else delete state.published[sourceId];
      return;
    }
    if (mediaAvailable && !await repairMedia(channel, record, post)) {
      delete state.published[sourceId];
      return;
    }
    if (mediaAvailable) record.mediaComplete = true;
    record.nextReviewAt = now() + reviewInterval;
  }

  async function findRecoveryTarget(state, pending) {
    const channelId = pending.channelId ?? state.channelId;
    const channel = await getReceiptChannel(channelId);
    if (!channel) return {};
    let existing = await findPendingMessage(channel, client.user.id, pending);
    if (!existing) {
      // Discord can return empty history without Read Message History. Search again with fresh permissions.
      const fresh = await getChannel(channelId, true);
      existing = await findPendingMessage(fresh, client.user.id, pending);
      if (!existing) {
        await getChannel(channelId, true);
      }
    }
    return { channel, existing };
  }

  async function recoverPending(state, pending, deferred = false) {
    const { id, sourceId, versionId } = pending;
    const channelId = pending.channelId ?? state.channelId;
    function finish(advance = true) {
      if (deferred) delete state.recoveries[sourceId];
      else {
        if (advance) state.sinceId = id;
        state.pending = null;
      }
      return save(state);
    }
    try {
      const { channel, existing } = await findRecoveryTarget(state, pending);
      // A deleted foreground destination leaves the post in the timeline for redelivery.
      if (!channel && !deferred) return await finish(false);
      if (pending.receiptOnly && !existing) return await finish();
      if (!existing && state.subscriptionId !== subscriptionId) return;
      const post = await lookupPost(versionId, sourceId);
      if (existing) {
        if (post && !post.skip) {
          const receipt = await publish(channel, post, existing);
          if (receipt) {
            state.published[sourceId] = receipt;
            return await finish();
          }
        } else {
          await syncMessage(channel, existing.id, null);
          return await finish();
        }
      }
      if (!post || post.skip || pending.receiptOnly) return await finish();
      await withDestinationReadLock(guildId, async () => {
        const currentId = activeChannelId();
        if (!currentId || state.subscriptionId !== subscriptionId) return;
        const target = await getChannel(currentId);
        requirePublishingPermissions(target, client.user, true);
        if (currentId !== channelId) {
          pending.channelId = currentId;
          pending.startedAt = now();
          await save(state);
        }
        state.published[sourceId] = await publish(target, post, null);
        await finish();
      });
    } catch (error) {
      if (deferred || !channelInaccessible(error) || (pending.channelId ?? channelId) === activeChannelId()) throw error;
      state.recoveries ??= {};
      state.recoveries[sourceId] = { ...pending, channelId: pending.channelId ?? channelId };
      await finish();
    }
  }

  async function deliver(state) {
    if (!state || activeChannelId() && state.subscriptionId !== subscriptionId) {
      const channelId = activeChannelId();
      if (!channelId) return;
      await getChannel(channelId);
      const head = await timeline();
      if (!activeChannelId()) return;
      const base = state ?? { version: 1, channelId, userId: head.userId, published: {} };
      const recoveries = { ...base.recoveries };
      if (base.pending) recoveries[base.pending.sourceId] = { ...base.pending,
        channelId: base.pending.channelId ?? base.channelId };
      for (const item of Object.values(recoveries)) item.receiptOnly = true;
      const sinceId = [head.sinceId, base.sinceId].filter(Boolean).sort(comparePostIds).at(-1) ?? null;
      await save({ ...base, subscriptionId, sinceId, pending: null, recoveries });
      return;
    }

    if (state.pending) await recoverPending(state, state.pending);

    if (!activeChannelId()) return;
    const { posts } = await timeline();
    const returnedIds = new Set(posts.map(post => post.id));
    for (const version of posts) {
      if (state.sinceId && comparePostIds(version.id, state.sinceId) <= 0) continue;
      let post = version;
      if (version.id !== version.latestId) {
        if (returnedIds.has(version.latestId)) continue;
        post = await lookupPost(version.id, version.sourceId);
      }
      const known = state.published[version.sourceId];
      const deferred = state.recoveries?.[version.sourceId];
      if (known && (!post || comparePostIds(post.id, known.versionId) > 0)) {
        try {
          await refresh(state, version.sourceId, known, post);
        } catch (error) {
          if (!channelInaccessible(error) || (known.channelId ?? state.channelId) === activeChannelId()) throw error;
          // A review lookup follows edits to the latest version. Retry this receipt independently of delivery.
          known.nextReviewAt = now() + pollInterval;
        }
      } else if (deferred) {
        if (post && comparePostIds(post.id, deferred.versionId) > 0) deferred.versionId = post.id;
      } else if (!known && post && !post.skip) {
        const delivered = await withDestinationReadLock(guildId, async () => {
          const channelId = activeChannelId();
          if (!channelId) return false;
          const channel = await getChannel(channelId);
          requirePublishingPermissions(channel, client.user, true);
          state.pending = { id: version.id, sourceId: post.sourceId, versionId: post.id, channelId, startedAt: now() };
          await save(state);
          state.published[post.sourceId] = await publish(channel, post, null);
          state.pending = null;
          state.sinceId = version.id;
          await save(state);
          return true;
        });
        if (!delivered) return;
        continue;
      }
      state.sinceId = version.id;
      await save(state);
    }
  }

  async function recoverDeferred() {
    const state = load();
    let firstError;
    for (const pending of Object.values(state?.recoveries ?? {})) {
      try {
        await recoverPending(state, pending, true);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError) throw firstError;
  }

  async function review() {
    // Read the last durable state even if delivery was interrupted mid-send.
    const state = load();
    if (!state) return;
    const time = now();
    const targets = Object.entries(state.published).filter(([, record]) =>
      record.nextReviewAt <= time || record.retryTranslationAt > 0 && record.retryTranslationAt <= time);
    let firstError;
    for (let offset = 0; offset < targets.length; offset += 100) {
      const batch = targets.slice(offset, offset + 100);
      let result;
      try {
        result = await x.lookup(batch.map(([, record]) => record.versionId));
      } catch (error) {
        if (error?.retryAt > time || error?.code === "X_HTTP_429") throw error;
        firstError ??= error;
        continue;
      }
      for (const [sourceId, record] of batch) {
        try {
          await refresh(state, sourceId, record, checkedPost(result.posts.get(record.versionId), sourceId, result.retryError));
        } catch (error) {
          firstError ??= error;
        }
      }
      await save(state);
      if (result.retryError?.retryAt > time || result.retryError?.code === "X_HTTP_429") throw result.retryError;
    }
    if (firstError) throw firstError;
  }

  const state = load();
  await phase("timeline", () => deliver(state));
  if (state) {
    await phase("recovery", recoverDeferred);
    await phase("review", review);
  }
}

export function setupNikitaXFeed(client) {
  let config;
  try {
    config = getNikitaXFeedConfig();
  } catch (error) {
    console.error(error.message);
    return;
  }
  if (!config) return;

  function logError(scope, error) {
    const code = error?.code;
    console.error("Nikita X feed check failed", { scope, code: /^[A-Z0-9_]{1,40}$/.test(code) ? code : "unknown" });
  }

  const failures = new Map();
  const endpointHolds = new Map();
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
      if (client.isReady()) {
        await pollNikitaXFeed(client, config, { runPhase, endpointHolds });
      }
    } catch (error) {
      logError("startup", error);
    } finally {
      setTimeout(tick, pollInterval).unref();
    }
  }
  client.once(Events.ClientReady, tick);
}
