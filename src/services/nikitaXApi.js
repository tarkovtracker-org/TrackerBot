export const nikitaHandle = "nikgeneburn";
export const isPostId = value => typeof value === "string" && /^[1-9]\d{0,18}$/.test(value);

const postQuery = {
  "tweet.fields": "created_at,lang,note_tweet,attachments,referenced_tweets,withheld",
  expansions: "attachments.media_keys",
  "media.fields": "media_key,type,url,preview_image_url"
};

function xError(message, code, retryAt = 0) {
  return Object.assign(new Error(message), { code, retryAt });
}

function retryTime(headers, now) {
  const retryAfter = headers.get("retry-after");
  const time = retryAfter && (/^\d+$/.test(retryAfter) ? now + Number(retryAfter) * 1000 : Date.parse(retryAfter));
  return Math.max(time || 0, Number(headers.get("x-rate-limit-reset")) * 1000 || 0);
}

export function comparePostIds(left, right) {
  return left.length - right.length || left.localeCompare(right);
}

function postImage(media) {
  const url = URL.parse((media?.type === "photo" ? media.url : media?.preview_image_url) ?? "");
  if (url?.origin === "https://pbs.twimg.com" && !url.username && !url.password) return url.href;
  return null;
}

function readPost(raw, media) {
  const { id, created_at: timestamp, lang, withheld } = raw;
  const text = raw.note_tweet?.text ?? raw.note_post?.text ?? raw.text;
  const history = raw.edit_history_post_ids ?? raw.edit_history_tweet_ids ?? [id];
  if (!isPostId(id) || !Array.isArray(history) || !history.includes(id) || !history.every(isPostId)
      || typeof text !== "string" || !Number.isFinite(Date.parse(timestamp))) {
    throw xError("Invalid X post", "X_PAYLOAD");
  }

  const refs = raw.referenced_posts ?? raw.referenced_tweets ?? [];
  const repost = refs.some(ref => ref.type === "retweeted" || ref.type === "reposted")
    && !refs.some(ref => ref.type === "quoted");
  const sourceId = history[0];
  // Edited versions have newer IDs. The first version's X Snowflake preserves the publish time.
  const createdAt = sourceId === id ? timestamp : new Date(Number((BigInt(sourceId) >> 22n) + 1288834974657n)).toISOString();
  const mediaKeys = raw.attachments?.media_keys ?? [];
  const images = mediaKeys.map(key => postImage(media.get(key))).filter(Boolean);
  const mediaComplete = images.length === mediaKeys.length;

  return { id, sourceId, history, latestId: history.at(-1), createdAt, lang, text, images, mediaComplete, skip: repost || Boolean(withheld) };
}

function readPosts(response) {
  const media = new Map((response.includes?.media ?? []).map(item => [item.media_key, item]));
  return (response.data ?? []).map(raw => readPost(raw, media));
}

function unavailableIds(response) {
  return new Set((response.errors ?? []).filter(error =>
    ["post", "tweet"].includes(error.resource_type)
    && (error.type === undefined && error.title === "Not Found Error"
      || /^https:\/\/(?:api\.)?(?:twitter|x)\.com\/2\/problems\/(?:resource-not-found|not-authorized-for-resource|resource-unavailable)$/.test(error.type)))
    .map(error => error.resource_id ?? error.value));
}

function indexLookup(response) {
  const byId = new Map([...unavailableIds(response)].map(id => [id, null]));
  for (const post of readPosts(response)) {
    for (const id of post.history) {
      const previous = byId.get(id);
      if (!previous || comparePostIds(post.id, previous.id) > 0) byId.set(id, post);
    }
  }
  return byId;
}

export function createNikitaXApi(bearerToken, fetchImpl, now, holds) {
  async function get(path, params, { endpoint = path, allowMissing = false } = {}) {
    const held = holds.get(endpoint);
    if (held?.retryAt > now()) throw held;
    holds.delete(endpoint);

    const url = new URL(path, "https://api.x.com");
    url.search = new URLSearchParams(params);
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${bearerToken}` },
      redirect: "error",
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) {
      if (response.status === 404 && allowMissing) return null;
      const time = now();
      let retryAt = response.status === 429 || response.status === 503 ? retryTime(response.headers, time) : 0;
      if (response.status === 429 && retryAt <= time) retryAt = time + 120_000;
      const error = xError("X request failed", `X_HTTP_${response.status}`, retryAt);
      if (retryAt > time) holds.set(endpoint, error);
      throw error;
    }
    return response.json();
  }

  async function resolveUserId() {
    const { data } = await get(`/2/users/by/username/${nikitaHandle}`, {});
    if (!isPostId(data?.id) || data.username?.toLowerCase() !== nikitaHandle) {
      throw xError("Invalid X account lookup", "X_PAYLOAD");
    }
    return data.id;
  }

  async function timeline(userId, sinceId, { seed = false } = {}) {
    const params = { ...postQuery, max_results: seed ? "5" : "100", exclude: "retweets" };
    if (sinceId) params.since_id = sinceId;
    const posts = new Map();
    const tokens = new Set();

    do {
      const page = await get(`/2/users/${userId}/tweets`, params);
      // Partial expansion errors can coexist with valid posts. A fetch with no timeline cannot seed or advance the feed.
      if ((!Array.isArray(page.data) && page.meta?.result_count !== 0)
          || (!page.data?.length && page.errors?.length)) {
        throw xError("Invalid X timeline", "X_PAYLOAD");
      }
      for (const post of readPosts(page)) {
        if (!sinceId || comparePostIds(post.id, sinceId) > 0) posts.set(post.id, post);
      }
      const token = page.meta?.next_token;
      if (!token || seed) break;
      if (tokens.has(token)) throw xError("Repeated X pagination token", "X_PAYLOAD");
      tokens.add(token);
      params.pagination_token = token;
    } while (true);

    return [...posts.values()].sort((left, right) => comparePostIds(left.id, right.id));
  }

  async function lookup(ids) {
    async function fetchIds(values) {
      if (values.length > 1) return indexLookup(await get("/2/tweets", { ...postQuery, ids: values.join(",") }));
      const [id] = values;
      const single = await get(`/2/tweets/${id}`, postQuery, { endpoint: "/2/tweets/:id", allowMissing: true });
      if (!single) return new Map([[id, null]]);
      return indexLookup({ ...single, data: single.data ? [single.data] : [] });
    }
    const requested = new Map();
    let retryError;
    const initial = await fetchIds(ids);
    for (const id of ids) requested.set(id, initial.get(id));
    // X permits at most five edits. A history that keeps changing is retried on a later poll.
    for (let attempt = 0; attempt < 5; attempt++) {
      const unsettled = [...requested].filter(([, post]) => post && post.id !== post.latestId);
      if (!unsettled.length) break;
      let latest;
      try {
        latest = await fetchIds([...new Set(unsettled.map(([, post]) => post.latestId))]);
      } catch (error) {
        retryError = error;
        break;
      }
      for (const [id, post] of unsettled) {
        const revision = latest.get(post.latestId);
        requested.set(id, revision && revision.sourceId !== post.sourceId ? undefined : revision);
      }
    }
    for (const [id, post] of requested) {
      if (post && post.id !== post.latestId) requested.set(id, undefined);
    }
    return { posts: requested, retryError };
  }

  return { resolveUserId, timeline, lookup };
}
