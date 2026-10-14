// lib/pvs/normalize.js — Stable PVS-facing normalization for Douyin read data.

function text(value) {
  if (value === null || value === undefined) return "";
  return String(value);
}

function nonNegativeInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round(n));
}

function isoFromSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const date = new Date(n * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function firstUrl(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  const list = value.url_list;
  if (Array.isArray(list)) {
    return list.find((item) => typeof item === "string" && item.startsWith("http")) || "";
  }
  if (typeof value.uri === "string" && value.uri.startsWith("http")) return value.uri;
  return "";
}

function normalizeAuthor(author) {
  const a = author && typeof author === "object" ? author : {};
  return {
    nickname: text(a.nickname),
    uid: text(a.uid || a.uid_str),
    secUid: text(a.sec_uid),
    uniqueId: text(a.unique_id),
  };
}

function normalizeMetrics(statistics) {
  const s = statistics && typeof statistics === "object" ? statistics : {};
  const metrics = {
    plays: nonNegativeInt(s.play_count ?? s.plays),
    likes: nonNegativeInt(s.digg_count ?? s.likes),
    comments: nonNegativeInt(s.comment_count ?? s.comments),
    shares: nonNegativeInt(s.share_count ?? s.shares),
  };
  const collect = s.collect_count ?? s.collects;
  if (collect !== undefined && collect !== null) {
    metrics.collects = nonNegativeInt(collect);
  }
  return metrics;
}

function normalizeWork(raw) {
  const item = raw && typeof raw === "object" ? raw : {};
  const awemeId = text(item.aweme_id);
  const video = item.video && typeof item.video === "object" ? item.video : {};
  const durationMs = nonNegativeInt(video.duration);
  return {
    awemeId,
    description: text(item.desc),
    publishedAt: isoFromSeconds(item.create_time),
    author: normalizeAuthor(item.author),
    metrics: normalizeMetrics(item.statistics ?? item.stats),
    durationMs,
    coverUrl:
      firstUrl(video.cover) ||
      firstUrl(video.origin_cover) ||
      firstUrl(video.dynamic_cover),
    externalUrl: awemeId ? "https://www.douyin.com/video/" + awemeId : "",
  };
}

function normalizeMyPosts(data) {
  const list = Array.isArray(data?.aweme_list) ? data.aweme_list : [];
  return list.map(normalizeWork).filter((item) => item.awemeId);
}

function normalizeSearch(data) {
  const list = Array.isArray(data?.data) ? data.data : [];
  return list
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const raw = entry.aweme_info ?? entry;
      const work = normalizeWork(raw);
      return work.awemeId ? work : null;
    })
    .filter(Boolean);
}

function normalizeIdentity(data) {
  const source = data && typeof data === "object" ? data : {};
  return {
    nickname: text(source.nickname),
    uid: text(source.uid),
    secUid: text(source.sec_uid ?? source.secUid),
    uniqueId: text(source.unique_id ?? source.uniqueId),
    shortId: text(source.short_id ?? source.shortId),
  };
}

function normalizeComment(raw, parentCid = "") {
  const c = raw && typeof raw === "object" ? raw : {};
  const user = c.user && typeof c.user === "object" ? c.user : {};
  return {
    cid: text(c.cid),
    awemeId: text(c.aweme_id),
    uid: text(user.uid || user.uid_str),
    secUid: text(user.sec_uid),
    nickname: text(user.nickname),
    text: text(c.text),
    diggCount: nonNegativeInt(c.digg_count ?? c.likes),
    replyCount: nonNegativeInt(c.reply_comment_total ?? c.replies),
    createdAt: isoFromSeconds(c.create_time ?? c.time),
    parentCid: text(c.parent_cid || parentCid),
    avatarUrl:
      firstUrl(user.avatar_thumb) ||
      firstUrl(user.avatar_medium),
  };
}

function normalizeCommentPage(data, parentCid = "") {
  const list = Array.isArray(data?.comments) ? data.comments : [];
  return {
    comments: list
      .map((item) => normalizeComment(item, parentCid))
      .filter((item) => item.cid),
    cursor: text(data?.cursor ?? ""),
    hasMore: Boolean(data?.has_more),
  };
}

function extractMedia(rawDetail) {
  const detail = rawDetail && typeof rawDetail === "object" ? rawDetail : {};
  const work = normalizeWork(detail);
  const video = detail.video && typeof detail.video === "object" ? detail.video : {};

  let videoUrl = firstUrl(video.play_addr) || firstUrl(video.download_addr);
  const bitRates = Array.isArray(video.bit_rate) ? [...video.bit_rate] : [];
  bitRates.sort((a, b) => nonNegativeInt(b?.bit_rate) - nonNegativeInt(a?.bit_rate));
  for (const rate of bitRates) {
    const candidate = firstUrl(rate?.play_addr);
    if (candidate) {
      videoUrl = candidate;
      break;
    }
  }

  const music = detail.music && typeof detail.music === "object" ? detail.music : {};
  const audioUrl = firstUrl(music.play_url);

  return {
    work,
    media: {
      videoUrl,
      audioUrl,
    },
  };
}

module.exports = {
  text,
  nonNegativeInt,
  isoFromSeconds,
  normalizeIdentity,
  normalizeWork,
  normalizeMyPosts,
  normalizeSearch,
  normalizeComment,
  normalizeCommentPage,
  extractMedia,
};
