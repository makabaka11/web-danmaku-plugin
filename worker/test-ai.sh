#!/usr/bin/env bash
# 一键验证：AI 智能匹配全链路（LLM 提取文件名 → 弹弹play 搜索）
#
# 用法：
#   AI_URL=https://api.deepseek.com/v1 AI_KEY=sk-xxx AI_MODEL=deepseek-chat bash worker/test-ai.sh
# （也可不带环境变量运行，会交互式提示输入）
#
# 前提：Worker 已重新部署（含 /llm 路由）。
# 验证：① /llm 真实调用 LLM 提取 {title,episode} ② 用提取结果搜弹弹play ③ 定位剧集。
# LLM key 仅本机内存使用，不写入仓库。
set -uo pipefail
cd "$(dirname "$0")/.."   # userscript/

AI_URL="${AI_URL:-}"; AI_KEY="${AI_KEY:-}"; AI_MODEL="${AI_MODEL:-}"
[ -z "$AI_URL" ]   && read -rp "LLM API 地址 (如 https://api.deepseek.com/v1): " AI_URL
[ -z "$AI_KEY" ]   && read -rp "API Key: " AI_KEY
[ -z "$AI_MODEL" ] && read -rp "模型 (如 deepseek-chat): " AI_MODEL
if [ -z "$AI_URL" ] || [ -z "$AI_KEY" ] || [ -z "$AI_MODEL" ]; then echo "❌ 三项不能为空"; exit 1; fi

PROXY_MJS=/tmp/ddp-proxy-$$.mjs
cp worker/dandanplay-proxy.js "$PROXY_MJS"
TEST=/tmp/test-ai-$$.mjs
# 测试用文件名（含字幕组/分辨率等杂质）
FILENAME="[ANi]_Bocchi_the_Rock!_01_[1080p][BDRip][x265][FLAC]"
cat > "$TEST" <<EOF
import worker from '${PROXY_MJS}';
const WORKER = 'https://ddplay.retr0.xyz';
const TOKEN = '8TUf1AYTwQFjGv';
const AI_URL = '${AI_URL}', AI_KEY = '${AI_KEY}', AI_MODEL = '${AI_MODEL}';
const FILENAME = '${FILENAME}';
const SYSTEM = '你是一个动漫视频文件名解析助手。输入一个视频文件名（可能含字幕组、分辨率、编码、集号等杂质）。请提取出干净的番剧标题(title)和集号(episode，纯数字字符串，无"第/话/集"等字；剧场版填movie)。只输出 JSON，不要解释，格式：{"title":"...","episode":"..."}。title 用原始语言。';

console.log('文件名:', FILENAME);
// ① 调 Worker /llm 提取
console.log('\\n--- ① AI 提取 (/llm) ---');
const lr = await fetch(WORKER + '/llm', {
  method: 'POST', headers: { 'Content-Type':'application/json', 'X-Proxy-Token': TOKEN },
  body: JSON.stringify({ baseUrl: AI_URL, apiKey: AI_KEY, model: AI_MODEL, temperature: 0,
    messages: [{role:'system',content:SYSTEM},{role:'user',content:FILENAME}] }),
});
const lt = await lr.text();
console.log('status:', lr.status);
if (!lr.ok) { console.log('❌ /llm 失败:', lt.slice(0,200)); process.exit(1); }
const lj = JSON.parse(lt);
const content = lj.choices && lj.choices[0] && lj.choices[0].message && lj.choices[0].message.content;
console.log('LLM 输出:', JSON.stringify(content));
const m = content && content.match(/\{[\s\S]*\}/);
if (!m) { console.log('❌ LLM 输出无 JSON'); process.exit(1); }
const ext = JSON.parse(m[0]);
const title = (ext.title||'').trim(); let episode = (ext.episode||'').toString().trim();
if (/movie/i.test(episode)) episode=''; episode = episode.replace(/[^\d]/g,'');
console.log('解析:', { title, episode });

// ② 用提取结果搜弹弹play（经 Worker）
console.log('\\n--- ② 弹弹play 搜索 (anime=title, episode=集号) ---');
const qp = new URLSearchParams({ anime: title });
if (episode) qp.set('episode', episode);
const sr = await fetch(WORKER + '/api/v2/search/episodes?' + qp.toString(), { headers: { 'X-Proxy-Token': TOKEN } });
const sj = await sr.json();
const animes = sj.animes || [];
console.log('status:', sr.status, '| 作品数:', animes.length);
if (animes.length) console.log('作品[0]:', animes[0].animeTitle, '| 剧集数:', (animes[0].episodes||[]).length);
if (episode && animes.length) {
  const eps = animes[0].episodes || [];
  console.log('episode过滤后剧集:', eps.map(e=>e.episodeNumber+'='+e.episodeTitle).join(' | '));
}
const ok = title.length>=2 && animes.length>0;
console.log(ok ? '\\n✅ AI 智能匹配全链路通过（LLM 提取 → 搜索定位作品/剧集）' : '\\n⚠️ 提取成功但搜索无结果（可能番剧名需调整）');
EOF
node "$TEST"
RC=$?
rm -f "$TEST" "$PROXY_MJS"
exit $RC
