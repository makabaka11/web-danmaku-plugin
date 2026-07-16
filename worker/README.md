# 弹弹play 代理 Worker

为「今天要来点弹幕吗？」用户脚本代理 [弹弹play 开放平台 API v2](https://api.dandanplay.net) 请求，同时为 AI 智能匹配功能提供 LLM CORS 代理。

📦 仓库：[`makabaka11/web-danmaku-plugin`](https://github.com/makabaka11/web-danmaku-plugin/tree/master/userscript/worker)

**为什么需要它**：弹弹play API 需要 AppId/AppSecret 鉴权——不能硬编码进前端脚本（会泄露）。同样，浏览器直接调 LLM API 有 CORS 限制。这个 Worker 把密钥放在 Cloudflare 的环境变量（Secrets）里，并为 LLM 提供 CORS 透传：前端只持有「Worker URL + token」，密钥和 LLM 调用全走 Worker。

## 工作原理

- 脚本请求 `https://<你的worker>/api/v2/search/episodes?anime=...`
- Worker 注入 `X-AppId` / `X-AppSecret` / `X-Timestamp` / `X-Signature`（凭证+签名两种鉴权同时发，最大化兼容），转发到 `https://api.dandanplay.net/...`
- `GET /api/v2/comment/{episodeId}` 会 302 跳转到弹幕加速 CDN —— Worker 手动跟随，且**不**把鉴权头转发给 CDN
- 路径/方法白名单（只放行搜索/详情/弹幕/匹配等只读接口）+ 可选 `PROXY_TOKEN` 防滥用 + GET 走 Cloudflare 边缘缓存（降配额）
- 另提供 `POST /llm`：转发 OpenAI 兼容的 chat/completions 请求（解决浏览器 CORS），用于「智能匹配」时让 LLM 从文件名提取番剧名+集号。LLM key 由前端随请求带给 Worker、**不在 Worker 存储**，Worker 只做 CORS 透传 + 仅允许 http(s) 的 baseUrl（防 SSRF）。

## 鉴权算法（已核实自官方文档）

签名模式：`X-Signature = base64( SHA256( AppId + Timestamp + Path + AppSecret ) )`

> 注意是**普通 SHA256**，AppSecret 拼在串尾当盐，**不是 HMAC**；`Path` 只含路径、不含域名/query/method/body。

默认 `DDP_AUTH_MODE=both`（凭证+签名都发），可切 `credential` / `signature`。

## 部署

1. 装 wrangler：`npm i -g wrangler`（或用 `npx wrangler`）
2. 登录：`npx wrangler login`
3. 注入密钥（值见上级目录 `调用信息.txt.rtf`，**不要写进任何文件**）：

   ```bash
   npx wrangler secret put DDP_APP_ID       # 粘贴 appid
   npx wrangler secret put DDP_APP_SECRET   # 粘贴 应用密钥1
   npx wrangler secret put PROXY_TOKEN      # 可选：自定义一串随机字符当防滥用 token
   ```

4. 部署：`npx wrangler deploy` → 得到 `https://dandanplay-proxy.<你的子域>.workers.dev`

5. 把 Worker URL（以及 PROXY_TOKEN，若设了）填进用户脚本菜单 →「⚙ 通用设置」→「弹弹play 代理」分区。

## D1 搜索缓存（可选，推荐）

Worker 支持把搜过的「番剧名 -> animeId」存入 D1 数据库，下次同名搜索直接用 animeId 调 `bangumi/{id}` 取最新 episodes 返回，**省掉 search 调用、避开 search 滥用检测**。episodes 不缓存（连载会更新）。未配置 D1 时 Worker 自动回退原行为，不影响功能。

启用步骤：

1. 创建数据库（得到 `database_id`）：
   ```bash
   npx wrangler d1 create dandanplay-cache
   ```
2. 把输出的 `database_id` 填进 `wrangler.toml` 的 `[[d1_databases]]` 段。
3. 建表（代码首次请求也会 `CREATE TABLE IF NOT EXISTS` 兜底，但建议显式建一次）：
   ```bash
   # 远程（生产）
   npx wrangler d1 execute dandanplay-cache --remote --command "CREATE TABLE IF NOT EXISTS anime_id_cache (query TEXT PRIMARY KEY, anime_id INTEGER NOT NULL, anime_title TEXT, ts INTEGER DEFAULT (unixepoch()))"
   # 本地（wrangler dev）
   npx wrangler d1 execute dandanplay-cache --local --command "CREATE TABLE IF NOT EXISTS anime_id_cache (query TEXT PRIMARY KEY, anime_id INTEGER NOT NULL, anime_title TEXT, ts INTEGER DEFAULT (unixepoch()))"
   ```
4. `npx wrangler deploy`。

行为说明：

- **API 有结果即写入**：搜索词 -> `animes[0]`（保下次同搜索词命中）+ 每个返回的 `animeTitle` -> 各自 id（都写入，数据准确）。多结果也写。
- 命中缓存后走 `bangumi/{id}` 只返回单个（`animes[0]`），手动搜索多候选的第二次会变单结果；自动载入本就取 `animes[0]`，不受影响。Worker 端按 API 语义复现 `episode` 过滤（纯数字 -> 该集；`movie` -> 剧场版；其他 -> `episodeTitle` 包含）。
- D1 任何异常（未配置 / 读写出错 / bangumi 失败）均静默降级回 search，不阻断请求。

## 本地调试

```bash
cp .dev.vars.example .dev.vars   # 填入真实 AppId/Secret
npx wrangler dev                 # 默认 http://localhost:8787

# 测试搜索
curl -s "http://localhost:8787/api/v2/search/episodes?anime=孤独摇滚" | jq '.animes[0].animeTitle'
# 测试拉取弹幕（验证 302 已被跟随）
curl -s "http://localhost:8787/api/v2/comment/11961683" | jq '.count'
# 非白名单路径应 403
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:8787/api/v2/login"
```

## 环境变量

| 变量 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `DDP_APP_ID` | Secret | ✅ | 弹弹play AppId |
| `DDP_APP_SECRET` | Secret | ✅ | 应用密钥 1 或 2（轮换密钥，任一有效） |
| `PROXY_TOKEN` | Secret | ❌ | 防滥用 token；设了脚本须带 `X-Proxy-Token` |
| `DDP_AUTH_MODE` | var | ❌ | `both`(默认) / `credential` / `signature` |
| `ALLOWED_ORIGIN` | var | ❌ | CORS Origin，默认 `*` |

## 放行的接口（白名单）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/v2/search/anime` | 关键词搜作品 |
| GET | `/api/v2/search/episodes` | 关键词搜作品+剧集（主流程，支持 episode 过滤集号） |
| GET | `/api/v2/bangumi/{id}` | 作品详情+剧集 |
| GET | `/api/v2/comment/{id}` | 拉取弹幕（302→CDN） |
| POST | `/api/v2/match` | 按文件名匹配剧集 |
| POST | `/llm` | 转发 OpenAI 兼容 chat/completions（CORS 代理，key 随请求带、不存储） |

其余一律 403。需要登录态的接口（发弹幕/收藏/历史）不在范围。

> **升级提示**：v0.7.0 新增了 `/llm` 路由，已部署的 Worker 需重新 `npx wrangler deploy` 才能用 AI 智能匹配功能（弹幕搜索/匹配不受影响）。
