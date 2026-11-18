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

function retryTime(headers) {
  const retryAfter = headers.get("retry-after");
  const time = retryAfter && (/^\d+$/.test(retryAfter) ? Date.now() + Number(retryAfter) * 1000 : Date.parse(retryAfter));
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
  const images = (raw.attachments?.media_keys ?? []).map(key => postImage(media.get(key))).filter(Boolean);

  return { id, sourceId, history, latestId: history.at(-1), createdAt, lang, text, images, skip: repost || Boolean(withheld) };
}

function readPosts(response) {
  const media = new Map((response.includes?.media ?? []).map(item => [item.media_key, item]));
  return (response.data ?? []).map(raw => readPost(raw, media));
}

function unavailableIds(response) {
  return new Set((response.errors ?? []).filter(error =>
    ["post", "tweet"].includes(error.resource_type)
    && /^https:\/\/(?:api\.)?(?:twitter|x)\.com\/2\/problems\/(?:resource-not-found|not-authorized-for-resource|resource-unavailable)$/.test(error.type))
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

export function createNikitaXApi(bearerToken, fetchImpl = fetch) {
  async function get(path, params) {
    const url = new URL(path, "https://api.x.com");
    url.search = new URLSearchParams(params);
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${bearerToken}` },
      redirect: "error",
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) {
      const retryAt = response.status === 429 || response.status === 503 ? retryTime(response.headers) : 0;
      throw xError("X request failed", `X_HTTP_${response.status}`, retryAt);
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
    if (!ids.length) return new Map();
    const fetchIds = async values => indexLookup(await get("/2/tweets", { ...postQuery, ids: values.join(",") }));
    const byId = await fetchIds(ids);
    const requested = ids.map(id => byId.get(id));
    if (requested.includes(undefined)) throw xError("Incomplete X post lookup", "X_PAYLOAD");

    const latestIds = [...new Set(requested.filter(post => post && post.id !== post.latestId).map(post => post.latestId))];
    const latestById = latestIds.length ? await fetchIds(latestIds) : new Map();
    return new Map(ids.map((id, index) => {
      const post = requested[index];
      if (!post || post.id === post.latestId) return [id, post];
      const latest = latestById.get(post.latestId);
      if (latest === undefined || latest && latest.sourceId !== post.sourceId) {
        throw xError("Incomplete X edit lookup", "X_PAYLOAD");
      }
      return [id, latest];
    }));
  }

  return { resolveUserId, timeline, lookup };
}
