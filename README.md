# 今天要来点弹幕吗？

在**任意网页视频**上叠加显示弹幕，支持 OpenList/Alist 同目录自动载入、弹弹play 在线搜索/智能匹配、**AI 全自动载入**（打开视频自动识番剧拉弹幕，零操作）、亮暗主题自适应。

## 原理

- 弹幕**数据**有三条来源：① OpenList 站点走其自身 `/api/fs/*` 同目录自动匹配；② 任意站点手动载入本地弹幕文件；③ **弹弹play 在线弹幕**——菜单里按关键词搜索番剧 / 按视频文件名智能匹配，选中剧集后远程拉取弹幕。在线弹幕经自部署的 Cloudflare Worker 代理（见下「弹弹play 在线弹幕」），AppId/密钥只存于 Worker 环境变量，不进脚本。
- 通过 `PlayerAdapter` 接口适配不同播放器：容器查找、控件栏查找、按钮样式、弹幕源都收到接口里，按站点/播放器自动分流。

## 安装和最佳食用指南

1. **浏览器先装 [Tampermonkey](https://www.tampermonkey.net/)**
2. **安装脚本**：在 Tampermonkey 面板中新建脚本，粘贴脚本全部内容，保存。或者直接把 `.user.js` 文件拖入 Tampermonkey。
3. 打开任意带有网页播放器的页面，看到播放器控件当中（如果是暂未适配的播放器也可能是网页右下方），多了一个弹幕按钮，点击后打开弹幕和配置菜单
4. 点击**通用设置**，开启 AI 开关并填写 AI 相关配置（地址、key、模型 ID，选轻量化的简单模型即可，AI 会自动提取番剧的名称和集数），启用**全自动载入**，刷新页面，插件之后将会自动为网页中当前番剧匹配并载入弹幕；
5.  自动匹配有误？您可以点击菜单中的**弹弹play 弹幕搜索**手动搜索番剧。
## 截图展示

<details>
<summary><b>📸 点击展开查看更多截图</b></summary>

| | |
|:---:|:---:|
| <img src="https://www.retr0.xyz/blog-img/20260626123308168.png" width="100%" alt="OpenList + ArtPlayer"><br><b>OpenList 使用展示</b> | <img src="https://www.retr0.xyz/blog-img/20260626202542928.png" width="100%" alt="ArtPlayer"><br><b>ArtPlayer 使用展示</b> |
| <img src="https://www.retr0.xyz/blog-img/1782447495887.png" width="100%" alt="Video.js"><br><b>Video.js 使用展示</b> | <img src="https://www.retr0.xyz/blog-img/20260626122847635.png" width="100%" alt="弹幕设置菜单"><br><b>弹幕设置菜单</b> |

</details>

## 适配的播放器 / 站点

脚本按 `createAdapter(video)` 自动分流：

| 适配器 | 触发条件 | 容器 | 控件栏按钮 | 自动载入 |
|---|---|---|---|---|
| **OpenListArtPlayerAdapter** | OpenList（端口 `5244` / localhost）+ ArtPlayer | `.art-video-player` | 注入 `.art-controls-right`（`.art-control` 样式，插最前） | ✅ OpenList `/api/fs/*` 同目录 |
| **ArtPlayerAdapter** | 任意站点的 ArtPlayer（`.art-video-player`） | `.art-video-player` | 同上 | ✅ 配置 AI 后可用 |
| **DPlayerAdapter** | DPlayer（`.dplayer`） | `.dplayer-video-wrap` | 注入 `.dplayer-icons-right`（原生 `.dplayer-icon` 样式，追加末尾） | ✅ 配置 AI 后可用 |
| **GenericAdapter** | 原生 `<video>` / 未知播放器 | `video.parentElement` | 探测控件栏命中则注入其中，否则右下浮层按钮 | ✅ 配置 AI 后可用 |

## 设置菜单

点击弹幕按钮打开设置菜单。所有设置自动保存到浏览器 localStorage，刷新/关闭后保留。

### 弹幕样式（菜单 Page 1）

| 设置项 | 说明 | 默认值 |
|---|---|---|
| 显示开关 | 开启/关闭弹幕渲染 | 开 |
| 字号 | 弹幕字体缩放（0.5× ~ 2.0×） | 1.0× |
| 透明度 | 弹幕整体透明度（20% ~ 100%） | 85% |
| 区域 | 弹幕占据屏幕高度比例（25% ~ 满屏） | 满屏 |
| 速度 | 弹幕滚动速度倍率 | 1.0× |
| 密度 | 同屏弹幕密度 | 1.0 |
| 时长 | 弹幕在屏停留秒数 | 4.5s |
| 上限 | 同屏最大弹幕条数（0=不限） | 300 |
| 速度同步 | 视频倍速时弹幕同速 | 开 |
| 加粗 | 弹幕文字加粗 | 开 |
| 描边 | 弹幕文字描边 | 关 |
| 防遮挡 | 避免弹幕遮挡视频主体 | 关 |

底部按钮：
- **「🌐 弹弹play 搜索弹幕」**：打开搜索弹窗，输入番剧名 → 选剧集 → 远程拉取弹幕
- **「✨ 智能匹配当前视频」**：按视频文件名自动匹配剧集（需在通用设置里开启 AI 才显示，见下）
- **「📂 载入本地弹幕文件」**：选择本地 `.xml` / `.json` / `.csv` 等弹幕文件
- **「🌓 切换主题」**：自动/亮色/暗色三态切换
- **「⚙ 通用设置」**：打开通用设置弹窗

### 高级设置（菜单 Page 2，点击「更多设置 →」）

| 设置项 | 说明 |
|---|---|
| 全屏同步 | 全屏时保持弹幕同步 |
| 顶部偏移 / 底部偏移 | 弹幕显示区域边距（px） |
| 最大长度 | 弹幕文字最大字符数 |
| 屏蔽类型 | 勾选即屏蔽：滚动/底部/顶部/逆向 |
| 屏蔽词 | 每行一个关键词或 `/正则/`，点「💾 保存并应用」生效 |
| DOM 回收 / 模型回收 / 拖拽视频 / 禁止缩小 | 引擎行为调节 |

### 通用设置弹窗

菜单 →「⚙ 通用设置」打开，分五个分区：

**① 配置管理**：重置所有设置 / 导出配置到文件 / 从文件导入

**② 弹弹play 代理**：

| 设置项 | 说明 | 默认值 |
|---|---|---|
| Worker URL | 自部署的 Cloudflare Worker 地址，留空用内置 | `ddplay.retr0.xyz` |
| Token | Worker 的防滥用口令，留空用内置 | （内置） |
| 简繁转换 | 弹弹play 远程弹幕的文字转换：转换为简体（默认）/ 不转换 / 转换为繁体 | 简体 |

> 默认值指向作者部署的 Worker，开箱即用。重度用户建议按 [worker/README.md](./worker/README.md) 自部署以避免流量集中触发配额。备份/恢复现在包含全部配置（弹幕设置 + 代理 + AI + 匹配缓存）。

**③ 匹配缓存**：「清空已匹配记录」按钮——匹配过的视频文件会被记住，下次打开直接命中，免重复请求。最多 200 条，LRU 淘汰。

**④ AI 配置**：

| 设置项 | 说明 |
|---|---|
| 启用 AI 开关 | **开启后「✨ 智能匹配」按钮才显示**，使用 AI 提取番剧名和集数 |
| 全自动载入开关 | 打开视频自动匹配标题→单结果自动载入弹幕（右下角显示 `⏳ 自动匹配中…` → `🎬 自动载入`），全程零操作 |
| API 地址 | OpenAI 兼容的 base URL，如 `https://api.deepseek.com/v1` |
| Key | 你的 API key（`sk-...`） |
| 模型 | 如 `deepseek-chat`、`gpt-4o-mini` 等轻量模型即可 |

> AI 从**网页标题**提取番剧名+集号，再用提取结果精确搜索。全自动载入：仅在搜索结果恰好 1 部作品的 1 集时自动载入，多结果静默等待手动操作。Key 存 localStorage，调用经 Worker `/llm` 转发（解决 CORS），不在 Worker 存储。

**⑤ 关于**：版本号 / 引擎信息 / 仓库地址 / 作者

### 全屏

全屏时脚本会把弹幕渲染层、菜单、浮层 UI 一并 re-parent 进全屏元素，退出时还原，三种适配器全屏均正常。

> **已知限制**：对裸 `<video>` 元素**自身**调 `requestFullscreen()`（全屏的就是 `<video>` 本身，而它是 replaced element 无法挂子层）时弹幕不显示。用容器级全屏（包一层 div 全屏该 div）则正常。画中画（PiP）下原页面的 DOM 层也会失效。

## 技术适配说明

脚本在多种播放环境里都能自动检测视频并注入弹幕，主要适配场景：

| 场景 | 检测方式 | 说明 |
|---|---|---|
| **OpenList/AList 切文件** | `<video>` 的 `src` 属性变化 + 重试扫描 | 同一播放器切换视频自动重新初始化 |
| **PJAX/SPA 导航** | 顶层窗口 `<title>` 变化 + `popstate` 事件 | B站/YT/巴哈等单页应用导航自动适配 |
| **iframe 内嵌播放器** | 自动取 `window.top.document.title` | 番剧站常把播放器嵌在 iframe 里，脚本自动取外层页面标题用于 AI 匹配 |
| **视频异步创建** | `loadstart` 事件 + 300ms 间隔重试（最多 5 次） | 覆盖 ArtPlayer 等异步初始化播放器 |

## 支持的弹幕文件格式

| 格式 | 扩展名 | 说明 |
|---|---|---|
| B 站弹幕 XML | `.xml` | `<d p="time,mode,size,color,...">text</d>`，支持 7 字段（毫秒）和 8 字段（秒）自动识别 |
| 弹弹 Play JSON | `.json` | `{"count":..., "comments":[{"time":秒,"content":"...","type":"top/scroll/...","color":"rgb(r,g,b)"}]}` |
| JSON 数组 | `.json` | `[{"text":"...","stime":毫秒,"mode":1,"size":25,"color":16777215}]` |
| JSONL | `.jsonl` `.ndjson` `.txt` | 每行一个 JSON 对象 |
| CSV | `.csv` | `stime,mode,size,color,text` 格式 |

## OpenList 自动载入匹配规则

仅 OpenList 站点启用。

### 命名要求

插件会查找**与视频文件同目录、且文件名「去扩展名后完全一致」的弹幕文件**。

```
正确 ✅：
  影视/CLANNAD/EP01.mkv
  影视/CLANNAD/EP01.xml        ← 同名 + 同目录，自动命中

错误 ❌：
  影视/CLANNAD/EP01.mkv
  影视/CLANNAD/EP01_danmaku.xml ← 多了「_danmaku」后缀，不会自动匹配
  Downloads/EP01.xml            ← 同文件名但不同目录，不会自动匹配
```

### 常见下载器命名 & 怎么让它匹配

不同的弹幕下载工具导出的文件名各不相同。以下是常见情况：

| 工具 | 导出文件名示例 | 是否自动匹配 | 怎么处理 |
|---|---|---|---|
| 弹弹 Play（macOS） | `CLANNAD AFTER STORY_danmaku_20260625_224201.xml` | ❌ 不会 | **重命名**：去掉 `_danmaku_时间戳` 后缀，改成与视频同名的 `.xml`。或**手动载入**：菜单 →「📂 载入本地弹幕文件」 |
| 某些 B 站下载器 | `视频标题.xml`（不含集数编号） | 取决于是否与视频文件同名 | 改成与视频文件完全一致的文件名 |
| 自己整理的弹幕 | `EP01.xml`（手动命名） | ✅ 会 | 无需处理 |

**推荐做法**：下载完弹幕后，**把文件名改成与视频文件完全一致**（只改扩展名），放到视频同目录。这样全自动，零操作。

### 匹配优先级

同目录有多个匹配文件时，按扩展名优先级选取第一个：

`.xml` → `.json` → `.jsonl` → `.csv`

例如同目录存在 `EP01.xml` 和 `EP01.json`，则优先加载 `.xml`。

## 弹弹play 在线弹幕（搜索 / 智能匹配）

> v0.6.0 新增。让没有同目录弹幕文件的视频也能有弹幕：直接联网搜弹弹play 弹幕库。

### 手动 / 智能匹配

脚本**内置默认 Worker**（`ddplay.retr0.xyz`），安装后无需配置：

| 方式 | 操作 | 适用场景 |
|---|---|---|
| **全自动载入** | 打开 AI + 全自动载入 开关 → 刷新页面即自动匹配 | 所有站点（推荐，零操作） |
| **手动搜索** | 菜单 →「🌐 弹弹play 搜索弹幕」→ 输入番剧名 → 选剧集 | 自动匹配未命中时 |
| **智能匹配** | 菜单 →「✨ 智能匹配当前视频」| 需开 AI 开关才显示按钮 |

> 载入后保留视频当前位置（不重置进度），整合第三方弹幕源（A/B/C 站，`withRelated=true`），弹幕文字默认转简体。**iframe 内嵌播放器**自动取外层页面标题用于匹配；**OpenList/AList** 取文件名；其他站点取网页标题。

### AI 智能匹配原理

AI 从**网页标题（iframe 内取顶层窗口标题）或视频文件名**中提取干净的番剧名+集号，再精确搜索弹弹play 弹幕库。相比直接拿杂乱文件名去匹配，成功率大幅提升。

> 开关开 → 智能匹配**必走 AI**，AI 提取失败不会回退到文件名匹配（用户明确选了用 AI）。开关关 → 按钮隐藏。LLM 调用经 Worker `/llm` 路由转发，支持所有 OpenAI 兼容端点（DeepSeek/OpenAI/OpenRouter/通义/智谱 等），有 20s 超时。Key 随请求带给 Worker、不在 Worker 存储。

### 为什么需要 Worker（安全）

弹弹play 开放平台 API 需要 AppId + AppSecret 鉴权。因此所有对 `api.dandanplay.net` 以及 LLM API 的请求先经 Cloudflare Worker 代理：密钥只存在于 Worker 的环境变量（Secrets）里，脚本侧只持有「Worker URL + 防滥用 token」。

脚本内置了默认 Worker（`ddplay.retr0.xyz`）及其 token，开箱即用，但若脚本被大量分发所有用户流量会集中打到默认 Worker，建议重度用户自部署。

### Worker 部署

Worker 代码在 [`userscript/worker/`](./worker/) 目录，核心文件：

| 文件 | 作用 |
|---|---|
| `dandanplay-proxy.js` | Worker 脚本：弹弹play 鉴权代理 + `/llm` LLM 转发 + CORS + 白名单 + 302 跟随 |
| `wrangler.toml` | Cloudflare 部署配置（name / main / vars） |
| `README.md` | 详细部署步骤 + 环境变量表 + 白名单接口表 |
| `.dev.vars.example` | 本地开发密钥模板（复制为 `.dev.vars` 填入真实值，gitignore） |
| `test-live.sh` | 一键验证脚本：对真实 API 跑三种鉴权模式 + 302 + 白名单 |
| `test-ai.sh` | 一键验证 AI 全链路：LLM 提取 → 弹弹play 搜索 |

部署要点（详见 [`worker/README.md`](./worker/README.md)）：

```bash
cd userscript/worker
npx wrangler secret put DDP_APP_ID       # 填 appid（见 调用信息.txt.rtf）
npx wrangler secret put DDP_APP_SECRET   # 填应用密钥1
npx wrangler secret put PROXY_TOKEN      # 可选：自定义随机字符（需与脚本设置一致）
npx wrangler deploy                      # 得到 https://xxx.workers.dev
```

> **v0.7.0+ 需要 `/llm` 路由**——已部署的 Worker 需重新 `npx wrangler deploy` 才会启用 LLM CORS 代理功能（弹幕搜索/匹配不受影响）。

放行的接口（白名单）：

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/v2/search/anime` | 关键词搜作品 |
| GET | `/api/v2/search/episodes` | 搜作品+剧集（支持 episode 过滤集号） |
| GET | `/api/v2/bangumi/{id}` | 作品详情 |
| GET | `/api/v2/comment/{id}` | 拉取弹幕（302→CDN，Worker 手动跟随） |
| POST | `/api/v2/match` | 按文件名匹配剧集 |
| POST | `/llm` | 转发 OpenAI 兼容 chat/completions（CORS 代理） |

### 鉴权与安全说明

- Worker 默认同时发送**凭证模式**（`X-AppId`+`X-AppSecret`）和**签名模式**（`X-AppId`+`X-Timestamp`+`X-Signature`，`X-Signature = base64(SHA256(AppId+Timestamp+Path+AppSecret))`，普通 SHA256 非 HMAC）两种鉴权，最大化兼容；可用环境变量 `DDP_AUTH_MODE` 切 `credential`/`signature`/`both`。
- 两个 AppSecret 是轮换密钥，任一有效。
- `GET /comment/{episodeId}` 会 302 跳转到弹幕加速 CDN——Worker 手动跟随，且**不**把鉴权头转发给 CDN，避免密钥泄露。
- 路径/方法白名单（仅放行搜索/详情/弹幕/匹配等只读接口）+ 可选 token + 搜索结果边缘缓存，应对 2026-06-25 起的分层配额与滥用检测。
- 不做 fileHash（前 16MB MD5）精确匹配：浏览器侧 CORS/大文件下载成本高；仅文件名模糊匹配，失败回退手动搜索。

## 常见问题

### 脚本不生效？
- 确认 Tampermonkey 中脚本已**启用**（绿色开关）
- 确认页面里有 `<video>` 元素
- F12 → Console 看有没有错误信息

### 菜单按钮没出现？
- 通用播放器：按钮优先注入播放器控件栏；若探测不到控件栏，会退到**右下角圆形浮层按钮**
- OpenList / ArtPlayer：按钮在播放器控件栏最前（弹幕图标）
- 播放器是全屏模式吗？非全屏下打开菜单后**再**全屏，菜单也会跟随。直接在**全屏模式下点击菜单按钮**开启
- F12 → Console 看有没有 `[titan-openlist]` 开头的日志

### 弹幕不显示？
- 确认菜单里「显示」开关是**开启**状态
- 确认屏蔽系统里没有误勾选屏蔽类型
- 确认视频确实在播放（暂停时弹幕也不动）

### 弹幕重复？
- 刷新页面即可，每次打开视频会自动清理旧弹幕

### 全屏时弹幕消失？
- 若是**裸 `<video>` 自身全屏**（全屏的就是 video 元素本身），弹幕无法显示（replaced element 限制）。改用容器级全屏即可。

### 弹幕比视频先播了 / 错位？
- 载入弹幕后脚本会同步触发视频播放并对齐状态。若仍有异常，确保视频处于播放状态；手动载入文件请通过菜单按钮（带用户手势，`play()` 通常放行）。

## 许可证

MIT

## 作者

[Retr0](https://www.retr0.xyz/) | [ded000@retr0.xyz](mailto:ded000@retr0.xyz)
