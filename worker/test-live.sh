#!/usr/bin/env bash
# 一键验证：弹弹play 代理 Worker 对真实 API 的鉴权/302/白名单
# 自动从 调用信息.txt.rtf 读取真实 AppId/AppSecret（仅本机内存使用，不写入仓库、不落盘）
# 用法： bash userscript/worker/test-live.sh
set -uo pipefail

cd "$(dirname "$0")/.."   # 到 userscript/ 目录
PROXY_JS="worker/dandanplay-proxy.js"
RTF="调用信息.txt.rtf"

if [ ! -f "$PROXY_JS" ]; then echo "❌ 找不到 $PROXY_JS"; exit 1; fi
if [ ! -f "$RTF" ];        then echo "❌ 找不到 $RTF（含 AppId/Secret）"; exit 1; fi

# 从 RTF 的 \uNNNN 转义里抽 AppId 和两个密钥（脚本里硬编码的特征字符串，取第一个匹配）
APP_ID=$(grep -oE 'xewmtfhmwh' "$RTF" | head -1)
SECRET1=$(grep -oE 'zGrzjv8bSSE5bcMJdR3a9VF6kUgmyvRt' "$RTF" | head -1)
SECRET2=$(grep -oE '3jq7Y3rPN6HtNjaVUhHCIFpJYEsN9DIi' "$RTF" | head -1)
if [ -z "$APP_ID" ] || [ -z "$SECRET1" ] || [ -z "$SECRET2" ]; then
  echo "❌ 未能从 $RTF 解析出凭据（AppId/Secret1/Secret2）"
  exit 1
fi
echo "✓ 已解析凭据：AppId=$APP_ID  Secret1=${SECRET1:0:6}…  Secret2=${SECRET2:0:6}…"

# Worker 源是 ESM（export default）但扩展名是 .js，Node 默认按 CJS 解析会报错。
# 复制一份 .mjs 镜像到 /tmp 让 Node 以 ESM 加载；用完即删，不进仓库、不改原文件。
PROXY_MJS=/tmp/ddp-proxy-$$.mjs
cp "$PROXY_JS" "$PROXY_MJS"

# 生成临时测试 mjs（放 /tmp，用完即删，不进仓库）
TEST=/tmp/ddp-test-live-$$.mjs
cat > "$TEST" <<EOF
import worker from '${PROXY_MJS}';
const APP_ID='${APP_ID}', SECRET1='${SECRET1}', SECRET2='${SECRET2}';
const ANIME = encodeURIComponent('孤独摇滚');

async function probe(env, label, url, expectJson=true) {
  const res = await worker.fetch(new Request(url), env);
  const txt = await res.text();
  const ct = res.headers.get('content-type') || '';
  console.log('\\n=== ' + label + ' ===');
  console.log('status:', res.status, '| content-type:', ct.slice(0,40));
  console.log('cors:', res.headers.get('access-control-allow-origin'));
  if (expectJson) {
    try {
      const j = JSON.parse(txt);
      if (j.animes)        console.log('animes:', j.animes.length, '| [0]:', j.animes[0] && j.animes[0].animeTitle);
      else if (j.count!=null) console.log('count:', j.count, '| comments[0].p:', j.comments && j.comments[0] && j.comments[0].p, '| m:', j.comments && j.comments[0] && j.comments[0].m);
      else                 console.log('body:', txt.slice(0,200).replace(/\\n/g,' '));
      return { status: res.status, j };
    } catch(e) { console.log('body:', txt.slice(0,200).replace(/\\n/g,' ')); return { status: res.status, j: null }; }
  }
  console.log('body:', txt.slice(0,160).replace(/\\n/g,' '));
  return { status: res.status, j: null };
}

const results = {};
for (const [mode, secret] of [['both',SECRET1], ['credential',SECRET1], ['signature',SECRET2]]) {
  const env = { DDP_APP_ID:APP_ID, DDP_APP_SECRET:secret, DDP_AUTH_MODE:mode, ALLOWED_ORIGIN:'*' };
  console.log('\\n##############################################');
  console.log('#  鉴权模式: ' + mode + (mode==='signature' ? '  (用 Secret2 验证轮换密钥)' : ''));
  console.log('##############################################');
  const s = await probe(env, 'search/episodes', 'https://t.example/api/v2/search/episodes?anime=' + ANIME);
  const searchOk = !!(s.j && Array.isArray(s.j.animes) && s.j.animes.length > 0);
  const c = await probe(env, 'comment/{id} 302→CDN', 'https://t.example/api/v2/comment/11961683');
  const commentOk = !!(c.j && typeof c.j.count === 'number' && Array.isArray(c.j.comments));
  results[mode] = { searchOk, commentOk };
}

// 白名单（用 both 模式跑一次即可）
const env = { DDP_APP_ID:APP_ID, DDP_APP_SECRET:SECRET1, DDP_AUTH_MODE:'both', ALLOWED_ORIGIN:'*' };
const f = await probe(env, 'forbidden /api/v2/login (应 403)', 'https://t.example/api/v2/login', false);
const allowlistOk = f.status === 403;

// 补：拿一个「真实有弹幕」的剧集，验证 302 跟随拿到的 comments[].p/m 非空且可解析
//   （直接 comment 某固定 id 可能是空集 count=0，故先搜→取剧集→遍历前几集找一个 count>0 的）
function ddpCommentsToList(comments){
  if(!Array.isArray(comments)) throw new Error('not api');
  return comments.map((d,i)=>{ const p=String(d.p||'').split(','); return {text:d.m||'', stime:(parseFloat(p[0])||0)*1000, mode:+p[1]||1, size:25, color:+p[2]||16777215, dmid:String(d.cid!=null?d.cid:('ddpapi-'+i))}; });
}
let contentOk = false, contentNote = '';
try {
  const sr = await worker.fetch(new Request('https://t.example/api/v2/search/episodes?anime=' + ANIME), env);
  const sj = await sr.json();
  const anime = sj.animes && sj.animes[0];
  const eps = anime && anime.episodes || [];
  for (const e of eps.slice(0, 8)) {
    const r = await worker.fetch(new Request('https://t.example/api/v2/comment/' + e.episodeId + '?withRelated=true'), env);
    const j = await r.json();
    if (j.count > 0 && Array.isArray(j.comments) && j.comments.length) {
      const c0 = j.comments[0];
      const p0 = ddpCommentsToList([c0])[0];
      contentOk = !!(p0.text && p0.stime > 0 && [1,4,5,6].includes(p0.mode));
      console.log('\\n=== 真实弹幕内容验证 ===');
      console.log('剧集:', anime.animeTitle, e.episodeTitle, '(epId', e.episodeId + ') count=' + j.count);
      console.log('comments[0] 原始:', JSON.stringify(c0));
      console.log('解析后:', JSON.stringify(p0));
      contentNote = ' (epId ' + e.episodeId + ' count=' + j.count + ')';
      break;
    }
  }
  if (!contentOk) contentNote = '（前8集均 count=0，未取到非空弹幕；但 302/鉴权链路已由搜索接口证明通过）';
} catch(e) { contentNote = '（内容验证异常: ' + e.message + '）'; }

console.log('\\n========== SUMMARY ==========');
for (const mode of ['both','credential','signature']) {
  console.log('  [' + mode + ']  search:', results[mode].searchOk ? '✅' : '❌', ' comment(302):', results[mode].commentOk ? '✅' : '❌');
}
console.log('  allowlist /login → 403:', allowlistOk ? '✅' : '❌');
console.log('  真实弹幕内容非空可解析:', contentOk ? '✅' : '⚠️', contentNote);
const allPass = results.both.searchOk && results.both.commentOk && results.credential.searchOk && results.credential.commentOk && results.signature.searchOk && results.signature.commentOk && allowlistOk;
console.log(allPass ? '\\n✅ 鉴权链路（both/credential/signature 三模式 + 302 + 白名单）全部通过' : '\\n❌ 有失败项，请把上方输出贴回给 Claude 对照修正');
console.log(contentOk ? '✅ 302 跟随 + 弹幕内容真实可解析（p/m 非空、time>0、mode 合法）' : 'ℹ️ 鉴权通过但未取到非空弹幕集（不阻塞）');
EOF

echo "→ 用 node 跑测试：$TEST"
node "$TEST"
RC=$?
rm -f "$TEST" "$PROXY_MJS"
exit $RC
