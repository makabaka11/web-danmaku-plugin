/*!
 * dandanplay-proxy.js
 *
 * Cloudflare Worker：为「今天要来点弹幕吗？」用户脚本代理 弹弹play 开放平台 API v2 请求。
 *
 * 目的：把 AppId / AppSecret 留在 Worker 的环境变量（Secrets）里，
 *       前端脚本只持有「Worker URL + 可选防滥用 token」，密钥不进脚本、不进仓库。
 *
 * ── 鉴权（已核实：官方文档 kaedei/dandanplay-doc/docs/open/README.md）──────────────────
 * 弹弹play 支持两种身份验证，任选其一。本 Worker 默认同时发送两种（env DDP_AUTH_MODE=both），
 * 防御性地最大化首次部署成功率；可切 'credential' / 'signature'。
 *   ① 凭证模式：X-AppId + X-AppSecret（任一密钥；两个 AppSecret 为轮换密钥、同时有效）
 *   ② 签名模式：X-AppId + X-Timestamp + X-Signature
 *        X-Signature = base64( SHA256( AppId + Timestamp + Path + AppSecret ) )
 *        // 注意：是【普通 SHA256】，AppSecret 拼在串尾当盐，不是 HMAC；
 *        //   Path 只含路径（不含域名 / query / method / body）。
 *
 * ── /api/v2/comment/{episodeId} 的 302 ─────────────────────────────────────────────
 * 该接口返回 HTTP 302 → 弹幕加速 CDN（Location 头），CDN 无需鉴权。
 * 本 Worker 用 redirect:'manual' 手动跟随，且【不】把鉴权头转发给 CDN（避免密钥泄露到第三方）。
 * 用 ?withRelated=true 一次拿整合弹幕（/related、/extcomment 已于 2026-04 弃用）。
 *
 * ── 安全 ──────────────────────────────────────────────────────────────────────────
 * 路径 + 方法白名单（仅只读拉取弹幕所需）；可选 PROXY_TOKEN 防滥用；GET 走 Cloudflare 边缘缓存。
 * 2026-06-25 起弹弹play 已上线分层配额，search/comment 有滥用检测，故白名单 + token + 缓存不可省。
 *
 * 环境变量（密钥用 `wrangler secret put` 注入，勿写入本文件 / wrangler.toml）：
 *   DDP_APP_ID      AppId            （必需，Secret）
 *   DDP_APP_SECRET  AppSecret 之一   （必需，Secret）
 *   PROXY_TOKEN     防滥用 token      （可选，Secret；设置后脚本须带 X-Proxy-Token）
 *   DDP_AUTH_MODE   both|credential|signature （可选，普通 var，默认 both）
 *   ALLOWED_ORIGIN  CORS Origin       （可选，普通 var，默认 *）
 */

const UPSTREAM = 'https://api.dandanplay.net';

// 只读白名单：路径正则 + 允许的方法。$ 锚定避免路径穿越。
const ALLOWED = [
  { re: /^\/api\/v2\/search\/anime$/, method: 'GET' },
  { re: /^\/api\/v2\/search\/episodes$/, method: 'GET' },
  { re: /^\/api\/v2\/bangumi\/[^/]+$/, method: 'GET' },
  { re: /^\/api\/v2\/comment\/[^/]+$/, method: 'GET' },
  { re: /^\/api\/v2\/match$/, method: 'POST' },
];

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;

// ── CORS ────────────────────────────────────────────────────────────────────────
function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'X-Proxy-Token, Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function jsonResponse(status, obj, env, extra) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(env) };
  if (extra) Object.assign(headers, extra);
  return new Response(JSON.stringify(obj), { status, headers });
}

// SHA256 → base64（普通哈希，非 HMAC）
async function sha256Base64(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// 按模式构造弹弹play 鉴权头。path = upstream pathname（不含 query/域名）。
async function buildAuthHeaders(pathname, env) {
  const mode = (env.DDP_AUTH_MODE || 'both').toLowerCase();
  const appId = env.DDP_APP_ID || '';
  const secret = env.DDP_APP_SECRET || '';
  const h = {};
  if (mode === 'credential' || mode === 'both') {
    h['X-AppId'] = appId;
    h['X-AppSecret'] = secret;
  }
  if (mode === 'signature' || mode === 'both') {
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = await sha256Base64(appId + ts + pathname + secret);
    h['X-AppId'] = appId;
    h['X-Timestamp'] = ts;
    h['X-Signature'] = sig;
  }
  return h;
}

// ── D1 缓存：番剧名 -> animeId ───────────────────────────────────────────────
// 目的：命中过的搜索把「番剧名->animeId」存 D1，下次直接用 animeId 调 bangumi/{id} 取最新 episodes，
//       省掉 search 调用、避开 search 滥用检测。episodes 不缓存（连载会更新）。
// 写入：API 有结果即把「番剧名->id」全部回填（数据准确）：搜索词->animes[0]（保同搜索词命中）
//       + 每个返回的 animeTitle->各自 id。多结果也写。命中后走 bangumi 只返回单个（animes[0]），
//       故手动搜索多候选的第二次会变单结果（自动载入本就取 animes[0]，不受影响）。
// 降级：env.DB 缺失或任何 D1 异常 -> 回退原 search 流程，不阻断。
let _schemaReady = false;  // 同一 isolate 只建一次表
async function ensureSchema(env) {
  if (_schemaReady || !env.DB) return;
  try {
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS anime_id_cache (' +
      'query TEXT PRIMARY KEY, anime_id INTEGER NOT NULL, anime_title TEXT, ts INTEGER DEFAULT (unixepoch()))'
    ).run();
    _schemaReady = true;
  } catch (e) { /* 建表失败不阻断，后续读写会自然降级 */ }
}

function normalizeQuery(s) {
  return (s || '').trim().toLowerCase();
}

// 复现弹弹play search/episodes 的 episode 过滤语义（bangumi 返回全集，需在 Worker 端过滤）：
//   空 -> 全集；纯数字 -> 该集（episodeNumber 匹配）；其他 -> episodeTitle 包含。
//   "movie" 由调用方在 anime 层判定（剧场版），不进这里。
function filterEpisodes(episodes, episode) {
  if (!Array.isArray(episodes)) return [];
  const ep = (episode || '').trim();
  if (!ep) return episodes;
  if (/^\d+$/.test(ep)) {
    return episodes.filter((e) => {
      const n = e && e.episodeNumber != null ? String(e.episodeNumber).trim() : '';
      return n === ep || (n && Number(n) === Number(ep));
    });
  }
  return episodes.filter((e) => ((e && e.episodeTitle) || '').includes(ep));
}

// 用 animeId 调 bangumi/{id} 取最新 episodes，适配成 search/episodes 的 {animes:[...]} 格式。
// bangumi 的 BangumiEpisode 字段（episodeId/episodeTitle/episodeNumber）与脚本期望一致，无需重命名。
// 带 episode 则按 API 语义过滤全集。失败返回 null（调用方降级走 search）。
async function fetchBangumiAsSearch(env, animeId, episode) {
  const pathname = '/api/v2/bangumi/' + encodeURIComponent(animeId);
  const authHeaders = await buildAuthHeaders(pathname, env);
  let resp;
  try {
    resp = await fetch(UPSTREAM + pathname, {
      method: 'GET',
      redirect: 'manual',
      headers: { ...authHeaders, Accept: 'application/json' },
      cf: { cacheTtl: 60, cacheEverything: true },  // 短缓存：兼顾最新 episodes 与配额
    });
  } catch (e) { return null; }
  if (!resp.ok) return null;  // bangumi 不应 302；非 2xx 视为失败
  let obj;
  try { obj = await resp.json(); } catch (e) { return null; }
  if (!obj || obj.success === false || obj.errorCode) return null;
  const bg = obj.bangumi;
  if (!bg || bg.animeId == null) return null;
  const eps = Array.isArray(bg.episodes) ? bg.episodes.map((e) => ({
    episodeId: e.episodeId,
    episodeTitle: e.episodeTitle || null,
    episodeNumber: e.episodeNumber != null ? String(e.episodeNumber) : null,
  })) : [];
  const anime = {
    animeId: bg.animeId,
    animeTitle: bg.animeTitle || null,
    type: bg.type,
    typeDescription: bg.typeDescription || null,
    episodes: eps,
  };
  const ep = (episode || '').trim();
  if (ep.toLowerCase() === 'movie') {
    // 剧场版请求：非剧场版番剧 -> 无结果（贴近 API「仅保留剧场版」语义）
    const t = String(anime.type || '').toLowerCase();
    if (!['movie', 'jpmovie', 'tmdbmovie'].includes(t)) {
      return { success: true, errorCode: 0, hasMore: false, animes: [] };
    }
  } else {
    anime.episodes = filterEpisodes(anime.episodes, ep);
  }
  return { success: true, errorCode: 0, hasMore: false, animes: [anime] };
}

function healthPage(env) {
  const mode = env.DDP_AUTH_MODE || 'both';
  const hasId = !!(env.DDP_APP_ID && env.DDP_APP_SECRET);
  const ok = hasId ? '✅ 已配置 AppId / AppSecret' : '⚠️ 未配置 DDP_APP_ID / DDP_APP_SECRET（请 wrangler secret put）';
  return `<!doctype html><meta charset="utf-8"><title>dandanplay proxy</title>
<style>body{font:14px/1.6 system-ui,sans-serif;max-width:640px;margin:48px auto;padding:0 16px;color:#333}code{background:#eee;padding:2px 6px;border-radius:3px}</style>
<h1>弹弹play 代理 Worker</h1>
<p>为「今天要来点弹幕吗？」用户脚本代理 <code>api.dandanplay.net</code> 请求。</p>
<ul>
  <li>鉴权模式：<code>${mode}</code></li>
  <li>${ok}</li>
  <li>防滥用 token：${env.PROXY_TOKEN ? '✅ 已启用' : '⬜ 未设置（公开）'}</li>
</ul>
<p>用法：<code>GET /api/v2/search/episodes?anime=孤独摇滚</code></p>
<p>也提供 <code>POST /llm</code>：转发 OpenAI 兼容的 chat/completions 请求（CORS 代理，LLM key 由前端随请求带来、不在 Worker 存储）。</p>`;
}

// ── /llm：转发 OpenAI 兼容的 chat/completions 请求（解决浏览器 CORS）──────────────
// 前端 POST /llm，body: { baseUrl, apiKey, model, messages, temperature?, ... }
// Worker 用 body 里的 baseUrl + apiKey 转发到 <baseUrl>/chat/completions，原样返回。
// LLM key 不存 Worker（每次请求带过来），Worker 只做 CORS 透传 + 超时控制。
// 注：baseUrl 由前端控制 → 仅信任脚本作者默认/用户自填，不会被第三方任意利用（且本 Worker 本就是用户自部署）。
async function handleLlm(request, env) {
  let body;
  try { body = await request.json(); } catch (e) {
    return jsonResponse(400, { success: false, errorMessage: 'invalid json body' }, env);
  }
  const baseUrl = (body && body.baseUrl || '').trim().replace(/\/+$/, '');
  const apiKey = (body && body.apiKey || '').trim();
  const model = body && body.model;
  const messages = body && body.messages;
  if (!baseUrl) return jsonResponse(400, { success: false, errorMessage: '缺少 baseUrl（LLM API 地址）' }, env);
  if (!model) return jsonResponse(400, { success: false, errorMessage: '缺少 model' }, env);
  if (!Array.isArray(messages)) return jsonResponse(400, { success: false, errorMessage: '缺少 messages' }, env);
  // 仅允许 http(s)，防 SSRF 到内网
  if (!/^https?:\/\//i.test(baseUrl)) return jsonResponse(400, { success: false, errorMessage: 'baseUrl 必须 http(s)' }, env);

  // 透传体：去掉本代理专用字段，其余（temperature/max_tokens 等）原样传给 LLM
  const upstreamBody = { ...body };
  delete upstreamBody.baseUrl;
  delete upstreamBody.apiKey;

  const upstreamUrl = baseUrl + '/chat/completions';
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;

  let resp;
  try {
    resp = await fetch(upstreamUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(upstreamBody),
      cf: { cacheTtl: 0, cacheEverything: false },  // LLM 响应绝不缓存
    });
  } catch (e) {
    return jsonResponse(502, { success: false, errorMessage: 'LLM upstream fetch failed', detail: String(e) }, env);
  }

  // 透传 LLM 响应（含流式：原样传 content-type，前端可按需处理）
  const outHeaders = new Headers(resp.headers);
  for (const [k, v] of Object.entries(corsHeaders(env))) outHeaders.set(k, v);
  outHeaders.set('Cache-Control', 'no-store');
  return new Response(resp.body, { status: resp.status, headers: outHeaders });
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env);

    // CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);

    // 健康页
    if (url.pathname === '/' || url.pathname === '') {
      return new Response(healthPage(env), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...cors },
      });
    }

    // /llm：LLM chat/completions CORS 代理（同样受 PROXY_TOKEN 保护）
    if (url.pathname === '/llm') {
      if (request.method !== 'POST') {
        return jsonResponse(405, { success: false, errorMessage: '/llm only POST' }, env);
      }
      if (env.PROXY_TOKEN) {
        const tok = request.headers.get('X-Proxy-Token') || '';
        if (tok !== env.PROXY_TOKEN) return jsonResponse(401, { success: false, errorMessage: 'invalid proxy token' }, env);
      }
      return handleLlm(request, env);
    }

    // 路径 / 方法白名单
    const rule = ALLOWED.find((r) => r.re.test(url.pathname));
    if (!rule) return jsonResponse(403, { success: false, errorMessage: 'path not allowed' }, env);
    if (request.method !== rule.method) {
      return jsonResponse(405, { success: false, errorMessage: 'method not allowed' }, env);
    }

    // 防滥用 token（可选）
    if (env.PROXY_TOKEN) {
      const tok = request.headers.get('X-Proxy-Token') || '';
      if (tok !== env.PROXY_TOKEN) {
        return jsonResponse(401, { success: false, errorMessage: 'invalid proxy token' }, env);
      }
    }

    // search/episodes：先查 D1 缓存（番剧名->animeId）。命中则用 animeId 调 bangumi/{id}
    // 取最新 episodes 返回，省掉本次 search 调用。未配置 DB / 未命中 / bangumi 失败 -> 继续走 search。
    const isSearchEpisodes = url.pathname === '/api/v2/search/episodes' && request.method === 'GET';
    if (isSearchEpisodes && env.DB) {
      await ensureSchema(env);
      const nq = normalizeQuery(url.searchParams.get('anime'));
      if (nq.length >= 2) {
        let row = null;
        try {
          row = await env.DB.prepare(
            'SELECT anime_id AS animeId, anime_title AS animeTitle FROM anime_id_cache WHERE query = ?'
          ).bind(nq).first();
        } catch (e) { /* D1 读异常：降级走 search */ }
        if (row && row.animeId != null) {
          const adapted = await fetchBangumiAsSearch(env, row.animeId, url.searchParams.get('episode') || '');
          if (adapted) {
            return jsonResponse(200, adapted, env, { 'Cache-Control': 'public, max-age=60' });
          }
          // bangumi 失败 -> 降级走 search（落到下面）
        }
      }
    }

    // 鉴权头（签名只用 pathname，不含 query）
    const authHeaders = await buildAuthHeaders(url.pathname, env);

    // 构造 upstream 请求
    const upstreamUrl = UPSTREAM + url.pathname + url.search;
    const isGet = request.method === 'GET';
    // comment 接口会 302 到带签名参数的 CDN URL（会过期）—— 缓存其 302 会拿到过期 Location，
    // 故仅对"返回 200 JSON 的 GET"（search/bangumi）开边缘缓存；comment/重定向一律不缓存。
    const isComment = /\/api\/v2\/comment\//.test(url.pathname);
    const init = {
      method: request.method,
      redirect: 'manual', // 手动跟随 302，避免把鉴权头带到 CDN
      headers: { ...authHeaders, Accept: 'application/json' },
      cf: (isGet && !isComment) ? { cacheTtl: 300, cacheEverything: true } : undefined,
    };
    if (request.method === 'POST') {
      // 透传 JSON body（签名不依赖 body）
      init.headers['Content-Type'] = request.headers.get('Content-Type') || 'application/json';
      init.body = request.body;
    }

    let resp;
    try {
      resp = await fetch(upstreamUrl, init);
    } catch (e) {
      return jsonResponse(502, { success: false, errorMessage: 'upstream fetch failed', detail: String(e) }, env);
    }

    // 手动跟随重定向（最多 3 跳）；重定向请求用【干净头】（不带鉴权，不泄露密钥）
    let hops = 0;
    while (REDIRECT_STATUSES.has(resp.status) && hops < MAX_REDIRECTS) {
      const loc = resp.headers.get('Location');
      if (!loc) break;
      hops++;
      try {
        // 302 目标是弹幕加速 CDN（URL 带签名参数、会过期），无需鉴权；GET + 干净头，不缓存
        resp = await fetch(loc, {
          method: 'GET',
          redirect: 'manual',
          headers: { Accept: 'application/json' },
        });
      } catch (e) {
        return jsonResponse(502, { success: false, errorMessage: 'redirect fetch failed', detail: String(e) }, env);
      }
    }

    // 缓存策略：comment 类缓存久一点（也与上面对 CDN 的 cacheTtl 呼应）
    const maxAge = /\/api\/v2\/comment\//.test(url.pathname) ? 3600 : 300;
    const outHeaders = new Headers(resp.headers);
    for (const [k, v] of Object.entries(cors)) outHeaders.set(k, v);
    outHeaders.set('Cache-Control', 'public, max-age=' + maxAge);

    // search/episodes 未命中缓存：走完上游后，把 API 返回的「番剧名->id」全部回填 D1（数据准确）：
    //   ① 搜索词 -> animes[0]（保证下次同搜索词必命中）
    //   ② 每个返回的 animeTitle -> 各自 id（满足「都写入」，且用准确番剧名搜索也命中）
    // 用读出的 body 返回（search 响应是 JSON、非流式，读取无副作用）。
    if (isSearchEpisodes && env.DB && resp.status >= 200 && resp.status < 300) {
      try {
        const text = await resp.text();
        let obj = null;
        try { obj = JSON.parse(text); } catch (e) {}
        if (obj && Array.isArray(obj.animes) && obj.animes.length >= 1) {
          const nq = normalizeQuery(url.searchParams.get('anime'));
          const pairs = [];  // [query, animeId, animeTitle]
          const seen = new Set();
          const push = (key, a) => {
            if (!a || a.animeId == null || key.length < 2 || seen.has(key)) return;
            seen.add(key);
            pairs.push([key, a.animeId, a.animeTitle || null]);
          };
          push(nq, obj.animes[0]);                                            // ① 搜索词 -> animes[0]
          for (const a of obj.animes) push(normalizeQuery(a.animeTitle), a);  // ② 每个番剧名 -> id
          if (pairs.length) {
            try {
              const stmt = env.DB.prepare('INSERT OR REPLACE INTO anime_id_cache (query, anime_id, anime_title) VALUES (?, ?, ?)');
              await env.DB.batch(pairs.map((p) => stmt.bind(p[0], p[1], p[2])));
            } catch (e) { /* 写缓存失败不影响响应 */ }
          }
        }
        const outHeaders2 = new Headers(resp.headers);
        for (const [k, v] of Object.entries(cors)) outHeaders2.set(k, v);
        outHeaders2.set('Cache-Control', 'public, max-age=' + maxAge);
        return new Response(text, { status: resp.status, headers: outHeaders2 });
      } catch (e) {
        return jsonResponse(502, { success: false, errorMessage: 'failed to read upstream', detail: String(e) }, env);
      }
    }

    // 透传响应体 + 状态（非 2xx 也透传，让脚本读到错误 JSON）
    return new Response(resp.body, { status: resp.status, headers: outHeaders });
  },
};
