// ==UserScript==
// @name         今天要来点弹幕吗？
// @version      1.1.2
// @description  在任意网页视频上加载 B 站网页版同款弹幕引擎（Titan）；OpenList 同目录自动载入 / 本地手动载入 / 弹弹play 在线搜索+智能匹配（支持 AI 增强全自动载入）；
// @author       Retr0
// @match        *://*/*
// @include      http://*:5244/*
// @include      https://*:5244/*
// 注：@match *://*/* 匹配所有网页；脚本在任意带 <video> 的页面激活，由 createAdapter 按站点/播放器分流
// （OpenList:5244/localhost 自动识别为特例；@include 5244 仅为兼容旧油猴版本的显式声明，可省）
// @require      https://cdn.jsdelivr.net/gh/makabaka11/DFM-Next@master/titan-bundle.js
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @run-at       document-end
// @homepageURL  https://github.com/makabaka11/web-danmaku-plugin
// @supportURL   https://github.com/makabaka11/web-danmaku-plugin
// @license       MIT
// ==/UserScript==

/*!
 * web-danmaku-plugin.user.js
 *
 * 原理：
 *   Titan 单文件 bundle 把 core + 7 个 webpack chunk 焊成 11.4MB 自包含产物，
 *   window.nanoWidgetsJsonp + __webpack_require__ 直接可用，__wp.e(765) 命中预装。
 *   拿到 Engine 类后，挂弹幕层到 <video> 容器，用 video.currentTime 做时间同步。
 *
 * 适配器（PlayerAdapter）：
 *   createAdapter(video) 按站点/播放器自动选择：
 *     - OpenListArtPlayerAdapter：OpenList(5244/localhost) + .art-video-player → 容器/控件栏/按钮 + 同目录弹幕自动载入
 *     - ArtPlayerAdapter：任意站点的 .art-video-player → 同上但无自动载入
 *     - GenericAdapter：原生 <video> 或未知播放器 → 容器=video.parentElement、浮层按钮、无自动载入
 *   全屏由 attachFullscreenReparenter 统一接管：把渲染层/浮层 UI reparent 进 fullscreenElement，退出还原；
 *   裸 <video> 自身全屏因 replaced element 限制无法挂子层（已知限制）。
 *
 * 文件路径来源（OpenList 自动载入用，无需 React state）：
 *   artplayer url = raw_url = /p/<encoded path>?sign=...
 *   从 video.currentSrc decode URL.pathname 即可反推完整文件路径。
 *
 * 弹幕自动载入匹配规则（仅 OpenListArtPlayerAdapter）：
 *   视频去后缀: ep01.mkv → 候选 base = "ep01"
 *   同目录存在: ep01.xml | ep01.json | ep01.jsonl | ep01.ndjson | ep01.csv | ep01.txt
 *   任一命中即 fetch 载入。
 *
 * 控件注入：
 *   adapter.getControlsBar() 给出控件栏（ArtPlayer: .art-controls-right 回退链）→ 插入按钮；
 *   返回 null（GenericAdapter）→ 右下角浮层按钮兜底。点击展开下拉菜单，含：
 *     - 弹幕显示开关
 *     - 字号 / 透明度 / 区域 / 速度 / 密度 / 时长 / 上限
 *     - 速度同步 / 加粗 / 描边 / 防遮挡
 *     - 「📂 载入本地弹幕」按钮
 *   所有控件直接调 engine.setSetting(key, value)。
 *
 * 部署：
 *   1. 上传 dist/titan-bundle.js 到可 https 访问的位置（OpenList 自身某目录 / GitHub release+jsDelivr）
 *   2. 改 @require 实际 URL
 *   3. Tampermonkey 安装本脚本
 */
(function () {
  'use strict';

  // 激活范围：任意带 <video> 的网页。OpenList:5244 由 createAdapter 自动识别为特例（保留同目录自动载入等全部行为）；
  // 其它站点走 GenericAdapter（无自动载入，仅手动载入文件 + 浮层按钮）。
  // 注：titan-bundle 因 @require 已在 @match *://*/* 的每个页面加载，扩大激活不增加该开销。

  // ============= 配置 =============
  const DANMAKU_EXTS = ['.xml', '.json', '.jsonl', '.ndjson', '.csv', '.txt'];
  const OPENLIST_API = location.origin;
  // 页面标题快照：优先取顶层窗口标题（iframe 里脚本拿的是 iframe 的 title，真正番剧标题在 top）
  // 跨域 iframe 访问 top.document 会抛错，兜底用当前 document.title
  const _PAGE_TITLE_SNAPSHOT = (() => {
    try { if (window.top && window.top !== window) return (window.top.document.title || '').trim(); }
    catch (e) { /* 跨域 iframe，无权限访问 top */ }
    return (document.title || '').trim();
  })();

  // ============= 弹幕文件解析（4 种格式 + 通用入口） =============
  function parseBiliXml(text) {
    const dom = new DOMParser().parseFromString(text, 'text/xml');
    const ds = dom.getElementsByTagName('d');
    const list = [];
    for (let i = 0; i < ds.length; i++) {
      const p = ds[i].getAttribute('p');
      if (!p) continue;
      const parts = p.split(',');
      // B 站原版 XML：7 字段（毫秒）；系统下载导出：8 字段（秒）
      // 通过 parts.length 自动判断 time 单位
      const rawTime = parseFloat(parts[0]) || 0;
      const stime = parts.length >= 8 ? rawTime * 1000 : rawTime;
      list.push({
        text: ds[i].textContent || '',
        stime: stime,
        mode: +parts[1] || 1,
        size: +parts[2] || 25,
        color: +parts[3] || 16777215,
        dmid: parts[6] || ('xml-' + i),
      });
    }
    return list;
  }

  // 弹弹 play / 系统下载导出 JSON：{count, comments:[{time, content, type, color, isMe}]}
  // time 单位是秒，type 是英文（top/scroll/bottom/reverse），color 是 rgb(r,g,b) 字符串
  function parseDandanplayJson(text) {
    const obj = JSON.parse(text);
    if (!obj || !Array.isArray(obj.comments)) throw new Error('not dandanplay format');
    const typeToMode = { scroll: 1, top: 5, bottom: 4, reverse: 6 };
    return obj.comments.map((d, i) => {
      // rgb(r,g,b) → 十进制（与 B 站一致）
      let color = 16777215;
      const cm = /rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i.exec(d.color || '');
      if (cm) color = (+cm[1] << 16) | (+cm[2] << 8) | +cm[3];
      return {
        text: d.content || d.text || '',
        stime: (parseFloat(d.time) || 0) * 1000,  // 秒 → 毫秒
        mode: typeToMode[d.type] != null ? typeToMode[d.type] : (+d.type || 1),
        size: d.size || 25,
        color: color,
        dmid: d.id || d.dmid || ('ddp-' + i),
      };
    });
  }

  // 弹弹play 开放平台 API 返回格式（CommentResponseV2）：{count, comments:[{cid, p, m}]}
  // p = "出现时间(秒),模式(1普通/4底/5顶),颜色(十进制 R*65536+G*256+B),用户ID"；m = 弹幕内容
  // 注意：与上面的 parseDandanplayJson（文件导出格式 {time,content,type,color}）不同 ——
  //       API 直接返回 p/m 字段，必须专用解析；否则会被 parseDandanplayJson 误判成空内容。
  function parseDandanplayApi(text) {
    return ddpCommentsToList((JSON.parse(text) || {}).comments);
  }
  // 由 CommentResponseV2.comments 数组 → 引擎 list 项（供文件解析 parseDandanplayApi 与远程载入共用）
  function ddpCommentsToList(comments) {
    if (!Array.isArray(comments)) throw new Error('not dandanplay api format');
    // 仅当存在 p/m 结构才认作 API 格式（避免吞掉文件导出格式）
    if (comments.length && comments[0].p == null && comments[0].m == null) throw new Error('not dandanplay api format');
    return comments.map((d, i) => {
      const p = String(d.p || '').split(',');
      return {
        text: d.m || '',
        stime: (parseFloat(p[0]) || 0) * 1000,  // 秒 → 毫秒（与其它解析器一致）
        mode: +p[1] || 1,                         // 1滚/4底/5顶
        size: 25,
        color: +p[2] || 16777215,                 // 十进制颜色，与 B 站一致
        dmid: String(d.cid != null ? d.cid : ('ddpapi-' + i)),
      };
    });
  }

  function parseJsonArray(text) {
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) throw new Error('not an array');
    return arr.map((d, i) => ({
      text: d.text || d.content || '',
      stime: d.stime != null ? d.stime : (d.time != null ? d.time * 1000 : (d.progress != null ? d.progress : 0)),
      mode: d.mode != null ? d.mode : 1,
      size: d.size || d.fontsize || 25,
      color: d.color || 16777215,
      dmid: d.dmid || d.id || ('json-' + i),
    }));
  }

  function parseJsonl(text) {
    const list = [];
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    for (let i = 0; i < lines.length; i++) {
      try {
        const d = JSON.parse(lines[i]);
        list.push({
          text: d.text || d.content || '',
          stime: d.stime != null ? d.stime : (d.time != null ? d.time * 1000 : 0),
          mode: d.mode != null ? d.mode : 1,
          size: d.size || d.fontsize || 25,
          color: d.color || 16777215,
          dmid: d.dmid || d.id || ('jsonl-' + i),
        });
      } catch (e) { /* 跳过坏行 */ }
    }
    return list;
  }

  function parseCsv(text) {
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (!lines.length) return [];
    const start = /^stime/i.test(lines[0]) ? 1 : 0;
    const list = [];
    for (let i = start; i < lines.length; i++) {
      const m = lines[i].match(/^("?[^",]+"?,|)([^,]*),([^,]*),([^,]*),(.*)$/);
      if (!m) continue;
      list.push({
        stime: +(m[1].replace(/,$/, '').replace(/^"|"$/g, '')) || 0,
        mode: +m[2] || 1,
        size: +m[3] || 25,
        color: +m[4] || 16777215,
        text: m[5].replace(/^"|"$/g, ''),
        dmid: 'csv-' + i,
      });
    }
    return list;
  }

  function parseAny(text, name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    if (ext === 'xml') return parseBiliXml(text);
    if (ext === 'csv') return parseCsv(text);
    if (ext === 'jsonl' || ext === 'ndjson' || ext === 'txt') return parseJsonl(text);
    if (ext === 'json') {
      // 优先尝试弹弹play API 格式（comments[].p/.m），再 dandanplay 文件导出格式，再通用 JSON 数组
      // 注意：parseDandanplayJson 对 API 格式不会抛错但会产出空内容/0时刻，故 API 解析必须在前
      try { return parseDandanplayApi(text); } catch (e) {}
      try { return parseDandanplayJson(text); } catch (e) {}
      try { return parseJsonArray(text); } catch (e) { return parseJsonl(text); }
    }
    // 无扩展名兜底
    try { return parseDandanplayApi(text); } catch (e) {}
    try { return parseDandanplayJson(text); } catch (e) {}
    try { return parseJsonArray(text); } catch (e) { return parseJsonl(text); }
  }

  // ============= 从 video.src 反推完整文件路径 =============
  function filePathFromVideo(video) {
    const src = video.currentSrc || video.src || '';
    if (!src) return null;
    try {
      const u = new URL(src, location.origin);
      return decodeURIComponent(u.pathname).replace(/^\/p/, '') || null;
    } catch (e) { return null; }
  }

  // 从网页标题提取番剧信息。优先当前 document.title（SPA导航标题会变），
  // 仅当当前标题疑似被播放器库覆盖（太短/占位名）时回退脚本加载快照。
  function getPageTitle() {
    // 优先取顶层窗口标题（iframe 里的脚本拿 document.title 是 iframe 自己的 title）
    let live;
    try { live = (window.top && window.top !== window) ? (window.top.document.title || '').trim() : ''; }
    catch (e) { live = ''; }
    if (!live || live.length < 2) live = (document.title || '').trim();
    // 当前标题疑似被播放器库覆盖（太短/占位名）→ 用快照
    let t = live;
    if (live.length < 6 || /^(Artplayer|Video|Player|Media|Play|播放器?)$/i.test(live)) {
      t = _PAGE_TITLE_SNAPSHOT;
    }
    if (!t || t.length < 2) return '';
    // 只去掉明确的站点名后缀
    t = t.replace(/\s*[-–—|｜]\s*(bilibili|哔哩哔哩|YouTube|AcFun|巴哈姆特|動畫瘋|Netflix|Amazon\s*Prime|Hulu|Disney\+|Crunchyroll|Funimation|HIDIVE|iQIYI|爱奇艺|优酷|腾讯视频|芒果TV|B站)\s*$/i, '');
    return t.trim().length >= 2 ? t.trim() : '';
  }

  // ============= 列同目录找候选弹幕文件 =============
  async function findSiblingDanmaku(filePath) {
    const dir = filePath.replace(/\/[^/]+$/, '');
    const base = filePath.match(/([^/]+)\.[^.]+$/);
    if (!base) return null;
    const videoBase = base[1];
    const resp = await fetch(OPENLIST_API + '/api/fs/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: dir, password: '', page: 1, per_page: 0, refresh: false }),
    });
    const data = await resp.json();
    if (data.code !== 200) return null;
    const files = (data.data && data.data.content) || [];
    const sortedExts = ['.xml', '.json', '.jsonl', '.ndjson', '.csv', '.txt'];
    for (const ext of sortedExts) {
      const hit = files.find(f => !f.is_dir && f.name === videoBase + ext);
      if (hit) {
        const getResp = await fetch(OPENLIST_API + '/api/fs/get', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: dir + '/' + hit.name, password: '' }),
        });
        const getData = await getResp.json();
        if (getData.code === 200) {
          return { name: hit.name, rawUrl: getData.data.raw_url };
        }
      }
    }
    return null;
  }

  // ============= PlayerAdapter：把"容器/控件栏/按钮/弹幕源"的站点/播放器特化收到接口里 =============
  // 目标：任意带 <video> 的网页都能挂载。OpenList+ArtPlayer 自动识别为特例，其余走通用兜底。
  class PlayerAdapter {
    constructor(video) { this.video = video; }
    getContainer() { return null; }              // 挂 rollLayer/cmdWrap 的容器 Element
    getControlsBar() { return null; }            // 注入开关按钮的控件栏 Element | null（null → 浮层按钮兜底）
    buttonClass() { return ''; }                 // 按钮类名（ArtPlayer 复用 .art-control）
    insertButton(btn, bar) { bar.appendChild(btn); }  // 默认追加到控件栏末尾
    async findDanmaku() { return null; }         // 自动载入源 {name, rawUrl} | null
  }

  // ArtPlayer 系列：容器 = .art-video-player，控件栏 = .art-controls-right 回退链，按钮复用 .art-control
  class ArtPlayerAdapterBase extends PlayerAdapter {
    constructor(video, artRoot) { super(video); this.artRoot = artRoot; }
    getContainer() {
      // .art-video-player 是 ArtPlayer 根容器（非 video 自身——video 是 replaced element，
      // video.closest('[class*="art-"]') 会误匹配 video 自己的 .art-video class，
      // 导致 rollLayer 被塞到 <video> 内部被浏览器忽略）
      return this.artRoot || this.video.parentElement;
    }
    getControlsBar() {
      const cands = [
        document.querySelector('.art-controls-right'),
        document.querySelector('.art-controls'),
        document.querySelector('[class*="art-controls"]'),
        document.querySelector('[class*="Controls"]'),
      ];
      return cands.find(Boolean) || null;
    }
    buttonClass() { return 'art-control art-control-danmaku hint--rounded hint--top'; }
    insertButton(btn, bar) { bar.insertBefore(btn, bar.firstChild); }  // ArtPlayer：插到控件栏最前（左侧显眼）
  }

  // OpenList + ArtPlayer：在 ArtPlayer 之上叠加同目录弹幕自动载入（OpenList /api/fs/*）
  class OpenListArtPlayerAdapter extends ArtPlayerAdapterBase {
    async findDanmaku() {
      const filePath = filePathFromVideo(this.video);
      if (!filePath) return null;
      return await findSiblingDanmaku(filePath);
    }
  }

  // 任意其它站点的 ArtPlayer：同容器/控件栏/按钮，但无自动载入源
  class ArtPlayerAdapter extends ArtPlayerAdapterBase {}

  // 通用控件栏探测：覆盖常见播放器的控件栏 class，让原生/未知播放器也尽量把按钮注入进真实控件栏而非浮层。
  // 从 video.parentElement 向上最多 6 层逐个 querySelector 命中即返回。
  const GENERIC_CTRL_SELECTORS = [
    '.dplayer-controller', '.dplayer-icons',        // DPlayer
    '.vjs-control-bar',                              // Video.js
    '.plyr__controls',                               // Plyr
    '.mejs-controls',                                // MediaElement
    '.jw-controlbar',                                // JW Player
    '.clappr-controls',                              // Clappr
    '.shaka-controls-button-panel',                 // Shaka
    '.vcp-controls',                                 // vue-video-player
    '.op-controls',                                  // 其它
    '[class*="control-bar"]', '[class*="controls-bar"]', '[class*="ControlsBar"]',
  ];
  function findGenericControlsBar(video) {
    let p = video.parentElement;
    for (let depth = 0; p && depth < 6; depth++) {
      for (let i = 0; i < GENERIC_CTRL_SELECTORS.length; i++) {
        const hit = p.querySelector(GENERIC_CTRL_SELECTORS[i]);
        if (hit) return hit;
      }
      p = p.parentElement;
    }
    return null;
  }

  // 通用兜底：原生 <video> 或未知播放器。容器 = video.parentElement（设 relative 让 rollLayer inset:0 铺满）；
  // 控件栏靠 findGenericControlsBar 探测，命中则按钮注入真实控件栏（中性 __titan_dm_ctrlbtn__ 样式），
  // 探测不到才退回右下浮层按钮。无自动载入源。
  class GenericAdapter extends PlayerAdapter {
    getContainer() {
      const c = this.video.parentElement || this.video;
      if (c && c !== document.body && getComputedStyle(c).position === 'static') c.style.position = 'relative';
      return c;
    }
    getControlsBar() { return findGenericControlsBar(this.video); }
    buttonClass() { return '__titan_dm_ctrlbtn__'; }
  }

  // DPlayer：容器 = .dplayer-video-wrap（video 父级，relative + overflow:hidden，已含原版 .dplayer-danmaku）；
  // 控件栏按钮注入 .dplayer-icons-right（设置/全屏所在图标组），用原生 .dplayer-icon 样式。
  // ⚠️ 不能注入 .dplayer-controller：它持有绝对定位的图标组 + 进度条，流式追加按钮会落在左上角压住播放键。
  class DPlayerAdapter extends PlayerAdapter {
    getContainer() { return this.video.closest('.dplayer-video-wrap') || this.video.parentElement; }
    getControlsBar() {
      // 优先右侧图标组（贴近原生弹幕开关位置）；右组没有再退左组、最后退 controller
      return document.querySelector('.dplayer-icons-right')
        || document.querySelector('.dplayer-icons-left')
        || document.querySelector('.dplayer-controller')
        || null;
    }
    buttonClass() { return 'dplayer-icon'; }
    // 改写按钮内部为原生结构：<el class="dplayer-icon"><span class="dplayer-icon-content"><svg/></span></el>
    // + DPlayer 的 data-balloon tooltip（ArtPlayer 用 data-hint，这里换掉避免两套 tooltip 冲突）
    decorateButton(btn) {
      btn.removeAttribute('data-hint');
      btn.setAttribute('data-balloon', '弹幕');
      btn.setAttribute('data-balloon-pos', 'up');
      const svg = btn.querySelector('svg');
      btn.innerHTML = '';
      const span = document.createElement('span');
      span.className = 'dplayer-icon-content';
      if (svg) span.appendChild(svg);
      btn.appendChild(span);
    }
    insertButton(btn, bar) { bar.appendChild(btn); }
  }

  function createAdapter(video) {
    // 就近探测播放器类型（per-video，避免全局命中误判）
    if (video.closest('.dplayer')) return new DPlayerAdapter(video);
    const isOpenList = location.port === '5244' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    const artRoot = video.closest('.art-video-player') || document.querySelector('.art-video-player');
    if (artRoot && isOpenList) return new OpenListArtPlayerAdapter(video, artRoot);
    if (artRoot) return new ArtPlayerAdapter(video, artRoot);
    return new GenericAdapter(video);
  }

  // ============= FullscreenReparenter：全屏时把渲染层/浮层 UI 挪进全屏元素，退出时还原 =============
  // 旧代码只 reparent 了菜单；rollLayer/cmdWrap 仅因 ArtPlayer 全屏 .art-video-player（恰含两层）才幸免，
  // 换通用/原生全屏会丢失，这里统一接管（菜单定位逻辑仍复用 positionMenuGlobal）。
  function getTitanLayers() {
    return [
      '__titan_roll_layer__', '__titan_cmd_layer__', '__titan_dm_btn__',
      '__titan_dm_menu__', '__titan_dm_settings', '__titan_dm_modal_mask', '__titan_status__',
    ].map(id => document.getElementById(id)).filter(Boolean);
  }
  function attachFullscreenReparenter(onReparent) {
    const onFs = () => {
      const fs = document.fullscreenElement;
      if (fs && fs.tagName === 'VIDEO') return;   // 裸 video 全屏：replaced element 无法挂子层 → 已知限制
      const layers = getTitanLayers();
      if (fs) {
        for (const el of layers) {
          if (fs.contains(el)) continue;          // 已在全屏元素内（ArtPlayer：层/按钮在 .art-video-player）→ 跳过
          el.__titanHome = el.parentElement; fs.appendChild(el);
        }
      } else {
        for (const el of layers) {
          if (el.__titanHome) { el.__titanHome.appendChild(el); el.__titanHome = null; }
        }
      }
      if (onReparent) try { onReparent(fs); } catch (e) {}
    };
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }

  // ============= 拿到 Titan 引擎 =============
  async function getEngine(video, adapter) {
    if (!window.nanoWidgetsJsonp) throw new Error('titan-bundle 未加载（@require 失败？）');
    // 等待 webpack runtime 就绪：@require 是异步 fetch + 异步执行，SPA 导航路径下从列表直接点视频时
    // nanoWidgetsJsonp 可能存在但 .push 还没被 webpackJsonpCallback 改写（默认 Array.push 不调 callback）
    // 用"push 一个 fake chunk，callback 是否同步执行"作为就绪信号
    let __wp = null;
    for (let i = 0; i < 100; i++) {  // 最多 10s（100 × 100ms）
      const fakeChunkId = 99000 + (i % 1000);  // 每次不同的 chunkId 避免重复
      let called = false;
      try {
        window.nanoWidgetsJsonp.push([[fakeChunkId], { [fakeChunkId]: function () {} }, function (wp) { __wp = wp; called = true; }]);
      } catch (e) { /* push 还没被 hook */ }
      if (called && __wp) break;
      await new Promise(r => setTimeout(r, 100));
    }
    if (!__wp) throw new Error('titan-bundle 10s 内未就绪（@require 加载超时？）');
    await __wp.e(765);
    const Engine = __wp(7765).ZP;
    if (!Engine) throw new Error('7765.ZP 未导出');

    // 容器由 adapter 决定（ArtPlayer: .art-video-player；通用: video.parentElement）
    const artContainer = adapter.getContainer();
    const rollLayer = document.createElement('div');
    rollLayer.id = '__titan_roll_layer__';
    rollLayer.style.cssText = 'position:absolute;inset:0;overflow:hidden;font-family:SimHei,Arial,sans-serif;pointer-events:none;z-index:20;';
    artContainer.appendChild(rollLayer);
    const cmdWrap = document.createElement('div');
    cmdWrap.id = '__titan_cmd_layer__';
    cmdWrap.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
    artContainer.appendChild(cmdWrap);

    // 读取持久化设置（videoSpeed 不持久化 —— 跟随每个视频自身的 playbackRate，否则跨视频会出现错位）
    const { videoSpeed: _vs, ...saved } = loadSettings();
    const engine = new Engine({
      id: 'web-danmaku-plugin',
      container: rollLayer,
      dom: { insideWrap: cmdWrap },
      setting: {
        visible: true, opacity: 0.85,
        fontFamily: "SimHei, 'Microsoft JhengHei', Arial, Helvetica, sans-serif",
        bold: true, preventShade: false, speedPlus: 1, speedSync: true, fontBorder: 0,
        fontSize: 1, fullScreenSync: false, area: 100, videoSpeed: 1,
        isRecyclingDom: true, isRecyclingModel: false, canBindMove: true, forbidEvents: true, forbidShrinkState: true,
        ...saved,  // 持久化设置覆盖默认
      },
      fn: {
        timelineSync: function () { return video.currentTime || 0; },
        // 过滤逻辑完全在脚本里（filterDmList），引擎只接收"已过滤"list —— fn.filter 永远 false
        filter: function () { return false; },
      },
      modes: [],
    });

    const onPlay = () => engine.play();
    const onPause = () => engine.pause();
    const onSeek = () => { try { engine.seek(video.currentTime); } catch (e) {} };
    const onRate = () => { try { engine.setSetting('videoSpeed', video.playbackRate); } catch (e) {} };
    // 窗口尺寸变化：调 engine.resize() 让引擎用新尺寸算滚动起点
    const onResize = () => { try { engine.resize(); } catch (e) {} };
    // 全屏 re-parent：把渲染层/浮层 UI 挪进全屏元素，退出还原；reparent 完成后延后 resize 让引擎用新容器尺寸重算，
    // 菜单若打开则重定位（替代旧 onFullscreenChange 的菜单处理）
    const detachReparenter = attachFullscreenReparenter((fs) => {
      setTimeout(onResize, 0);
      const m = document.getElementById('__titan_dm_menu__');
      if (m && m.classList.contains('open')) positionMenuGlobal();
    });
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('seeking', onSeek);
    video.addEventListener('seeked', onSeek);
    video.addEventListener('ratechange', onRate);
    video.addEventListener('resize', onResize);
    window.addEventListener('resize', onResize);
    if (!video.paused) engine.play();
    engine.setSetting('videoSpeed', video.playbackRate || 1);
    // 初始化后延后调一次 resize（DOM 还没布局完时拿到的是 0）
    setTimeout(onResize, 100);
    setTimeout(onResize, 500);

    engine.__titanCleanup = function () {
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('seeking', onSeek);
      video.removeEventListener('seeked', onSeek);
      video.removeEventListener('ratechange', onRate);
      video.removeEventListener('resize', onResize);
      window.removeEventListener('resize', onResize);
      detachReparenter();
      try { engine.dispose(); } catch (e) {}
      try { rollLayer.remove(); } catch (e) {}
      try { cmdWrap.remove(); } catch (e) {}
    };
    return engine;
  }

  // ============= 载入后同步播放状态 =============
  // 修"载入弹幕后视频没播但弹幕已在播"的错位：载入成功后显式对齐视频与引擎的播放态。
  // startPlayback（自动/手动载入新弹幕）：尝试触发视频播放（onPlay→engine.play 已绑定），
  //   被自动播放策略拒（Promise reject）时让 engine 跟随视频真实 paused 态——视频没播就暂停引擎，避免弹幕跑在前面。
  // alignPlayback（重载/重过滤，保留视频当前位置与播放态）：不主动 play 视频，仅让 engine 对齐视频当前态。
  function startPlayback(engine, video) {
    const follow = () => { try { if (video.paused) engine.pause(); else engine.play(); } catch (e) {} };
    try {
      const p = video.play();
      if (p && typeof p.then === 'function') p.then(follow, follow);
      else follow();
    } catch (e) { follow(); }
  }
  function alignPlayback(engine, video) {
    try { if (video.paused) engine.pause(); else engine.play(); } catch (e) {}
  }

  // ============= 自动载入弹幕 =============
  async function autoLoad(engine, video, adapter) {
    const hit = await adapter.findDanmaku(video);
    if (!hit) {
      // 仅在有自动载入源的站点（OpenList）提示"同目录无匹配"；通用站点无此概念，静默
      if (adapter instanceof OpenListArtPlayerAdapter) showStatus('同目录无弹幕文件（菜单 → 手动载入）');
      return;
    }
    try {
      showStatus('载入 ' + hit.name + ' ...');
      const r = await fetch(hit.rawUrl);
      const text = await r.text();
      const rawList = parseAny(text, hit.name);
      const filtered = filterDmList(rawList, engine.config.setting);
      engine.clear();
      // 引擎只接收"已过滤"list（脚本自己处理过滤，引擎 fn.filter 永远 false）
      engine.addList(filtered);
      window.__titanLastDmList = rawList;  // 缓存**原始**list（过滤立即生效时重新过滤）
      showStatus('✓ ' + hit.name + ' · ' + filtered.length + ' / ' + rawList.length + ' 条');
      // 载入成功后同步触发播放：视频若未播则 play()（含 onPlay→engine.play）；被自动播放策略拒时
      // 让 engine 跟随视频 paused 态，避免"弹幕已在播但视频没播"的错位
      startPlayback(engine, video);
    } catch (e) {
      showStatus('载入失败: ' + e.message);
    }
  }

  // ============= 持久化（GM_setValue 跨站存储所有设置，不按 origin 隔离）=============
  const STORAGE_KEY = '__titan_dm_settings__';
  function loadSettings() {
    try { return JSON.parse(GM_getValue(STORAGE_KEY, '{}')) || {}; } catch (e) { return {}; }
  }
  function saveSettings(obj) {
    try { GM_setValue(STORAGE_KEY, JSON.stringify(obj)); } catch (e) {}
  }

  // ============= 主题（暗/亮，跟随页面或手动）=============
  // 主题存 GM 跨站存储：'auto'(默认，跟随页面/系统) | 'light' | 'dark'。
  // auto 时：优先取页面 body 背景亮度（很多站点亮色 = 白底）；取不到则退 prefers-color-scheme。
  const THEME_KEY = '__titan_dm_theme__';
  function loadTheme() {
    try { return GM_getValue(THEME_KEY, 'auto'); } catch (e) { return 'auto'; }
  }
  function saveTheme(t) {
    try { GM_setValue(THEME_KEY, t || 'auto'); } catch (e) {}
  }
  // 判断页面是否偏亮色（body 背景接近白）→ 返回 true=应亮色
  function pageIsLight() {
    try {
      const bg = getComputedStyle(document.body).backgroundColor;
      const m = bg.match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
      if (m) {
        const [r, g, b] = [+m[1], +m[2], +m[3]];
        // 感知亮度（Rec.709）；> 160 视为亮色背景
        return (0.2126 * r + 0.7152 * g + 0.0722 * b) > 160;
      }
    } catch (e) {}
    // 回退：系统 prefers-color-scheme
    try { return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches; } catch (e) {}
    return false;
  }
  function effectiveTheme() {
    const t = loadTheme();
    if (t === 'light' || t === 'dark') return t;
    return pageIsLight() ? 'light' : 'dark';
  }
  function applyTheme() {
    if (effectiveTheme() === 'light') document.documentElement.classList.add('__titan_dm_light__');
    else document.documentElement.classList.remove('__titan_dm_light__');
  }

  // ============= 弹弹play 集成（配置 + API 客户端，全部经自部署的 Cloudflare Worker 代理）=============
  // 安全模型：AppId/AppSecret 只存在于 Worker 的环境变量（Secrets）里；本脚本只持有
  //   「Worker URL + 可选防滥用 token」。两者内置默认值（作者自部署的 Worker），开箱即用；
  //   用户可在「⚙ 通用设置 → 弹弹play 代理」覆盖（留空即用默认）。脚本内不硬编码任何密钥。
  const DDP_KEY = '__titan_dm_ddp__';
  // 默认值：作者自部署的 Worker。token 是防滥用口令（非密钥），写死公开无碍——但若脚本被大量分发，
  // 所有用户流量会集中打到这个 Worker，可能触发弹弹play 分层配额（21.0.06-25 起）；建议重度用户自部署。
  const DEFAULT_DDP_WORKER_URL = 'https://ddplay.retr0.xyz';
  const DEFAULT_DDP_PROXY_TOKEN = '8TUf1AYTwQFjGv';
  const ddpCache = new Map();        // 会话内搜索结果缓存（keyword → SearchEpisodesResponse），降配额
  function loadDdpConfig() {
    try { return JSON.parse(GM_getValue(DDP_KEY, '{}')) || {}; } catch (e) { return {}; }
  }
  function saveDdpConfig(cfg) {
    try { GM_setValue(DDP_KEY, JSON.stringify(cfg || {})); } catch (e) {}
  }
  // 取实际生效的 Worker URL：用户在设置里填了就用填的（留空回退默认）；去尾斜杠、自动补协议
  function ddpWorkerUrl() {
    let u = (loadDdpConfig().workerUrl || DEFAULT_DDP_WORKER_URL).trim();
    if (!u) return '';
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;  // 用户只填了域名时自动补 https://
    return u.replace(/\/+$/, '');
  }
  function ddpProxyToken() {
    return (loadDdpConfig().proxyToken || DEFAULT_DDP_PROXY_TOKEN).trim();
  }
  function ddpReady() { return !!ddpWorkerUrl(); }

  // 底层：经 Worker 请求弹弹play API；返回 JSON（已做 HTTP + 业务层 errorCode 检查）
  async function ddpFetch(path, opts) {
    opts = opts || {};
    const base = ddpWorkerUrl();
    if (!base) throw new Error('未配置弹弹play 代理（菜单 → 通用设置 → 弹弹play 代理）');
    const qs = opts.query ? '?' + new URLSearchParams(opts.query).toString() : '';
    const headers = { 'Accept': 'application/json' };
    const token = ddpProxyToken();
    if (token) headers['X-Proxy-Token'] = token;
    let body;
    if (opts.method === 'POST' && opts.body != null) {
      body = JSON.stringify(opts.body);
      headers['Content-Type'] = 'application/json';
    }
    const r = await fetch(base + path + qs, { method: opts.method || 'GET', headers, body });
    const txt = await r.text();
    let obj = null;
    try { obj = txt ? JSON.parse(txt) : null; } catch (e) { obj = null; }
    if (!r.ok) {
      // 透传 Worker/upstream 的错误信息（如 401 token / 429 配额 / 弹弹play 业务错误）
      throw new Error((obj && (obj.errorMessage || obj.error)) || ('HTTP ' + r.status));
    }
    if (obj && obj.success === false) {  // 弹弹play 业务层错误：errorCode !== 0
      throw new Error(obj.errorMessage || ('errorCode ' + obj.errorCode));
    }
    return obj;
  }

  // 关键词搜作品+剧集（主流程：一次拿到 animes[].episodes[]，无需再查详情）
  // episode 可选：纯数字时 API 仅保留该集数结果（用于 AI 提取集号后精确定位）
  async function ddpSearchEpisodes(anime, episode) {
    const kw = (anime || '').trim();
    if (kw.length < 2) throw new Error('关键词至少 2 个字符');
    const cacheKey = kw + '|' + (episode || '');
    if (ddpCache.has(cacheKey)) return ddpCache.get(cacheKey);
    const query = { anime: kw };
    if (episode) query.episode = String(episode);
    const obj = await ddpFetch('/api/v2/search/episodes', { query });
    const res = obj || { animes: [] };
    ddpCache.set(cacheKey, res);
    return res;
  }

  // ============= AI 配置（LLM 清洗文件名，提取番剧名+集号）========================
  // 安全模型：用户的 LLM key 是个人 key（非项目密钥），存 GM 跨站存储。调用经 Worker 的 /llm
  //   端点转发（解决浏览器 CORS），key 随请求带给 Worker、不在 Worker 存储。
  const AI_KEY = '__titan_dm_ai__';
  function loadAiConfig() {
    try { return JSON.parse(GM_getValue(AI_KEY, '{}')) || {}; } catch (e) { return {}; }
  }
  function saveAiConfig(cfg) {
    try { GM_setValue(AI_KEY, JSON.stringify(cfg || {})); } catch (e) {}
  }
  // 用户是否在开关里显式开启了 AI 匹配（enabled 字段）。开关开 + 配置齐 → 才显示/走 AI。
  function aiEnabled() { return !!loadAiConfig().enabled; }
  function aiReady() {
    const c = loadAiConfig();
    return !!(c.enabled && c.baseUrl && c.model);
  }
  // 智能匹配按钮是否显示：仅当 AI 开关开启时（配置不全点开会提示去填）
  function aiMatchVisible() { return aiEnabled(); }
  // 全自动载入：开页面自动匹配→单结果自动载入，全程零操作
  function autoMatchEnabled() { return !!(loadAiConfig().autoMatch && aiReady()); }
  // 调用 LLM（经 Worker /llm 代理）提取文件名 → {title, episode}
  // prompt 要求只返回 JSON。失败返回 null（调用方回退到原 fileName 匹配）。
  const LLM_TIMEOUT_MS = 20000;
  const LLM_SYSTEM_PROMPT =
    '你是一个动漫视频文件名解析助手。输入一个视频文件名（可能含字幕组、分辨率、编码、集号等杂质）。' +
    '请提取出干净的番剧标题(title)和集号(episode，纯数字字符串，无"第/话/集"等字；剧场版填movie)。' +
    '只输出 JSON，不要解释，格式：{"title":"...","episode":"..."}。title 用原始语言（中文/日文/英文任一，取文件名里的主体名）。';
  async function llmExtractFileName(fileName) {
    const cfg = loadAiConfig();
    if (!aiReady()) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), LLM_TIMEOUT_MS);
    try {
      const workerUrl = ddpWorkerUrl();
      const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
      const token = ddpProxyToken();
      if (token) headers['X-Proxy-Token'] = token;
      const r = await fetch(workerUrl + '/llm', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          baseUrl: cfg.baseUrl.trim(),
          apiKey: cfg.apiKey.trim(),
          model: cfg.model.trim(),
          temperature: 0,
          messages: [
            { role: 'system', content: LLM_SYSTEM_PROMPT },
            { role: 'user', content: fileName },
          ],
        }),
        signal: ctrl.signal,
      });
      const txt = await r.text();
      if (!r.ok) throw new Error((JSON.parse(txt || '{}').errorMessage) || ('HTTP ' + r.status));
      const j = JSON.parse(txt);
      const content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (!content) return null;
      // 解析 LLM 输出（可能带 ```json 包裹或前后杂质）→ 提取 {...}
      const m = content.match(/\{[\s\S]*\}/);
      if (!m) return null;
      const parsed = JSON.parse(m[0]);
      const title = (parsed.title || '').trim();
      if (title.length < 2) return null;
      let episode = (parsed.episode || '').toString().trim();
      if (/movie/i.test(episode)) episode = '';
      episode = episode.replace(/[^\d]/g, '');  // 只留数字
      return { title, episode: episode || '' };
    } catch (e) {
      throw new Error('AI 提取失败: ' + e.message);
    } finally {
      clearTimeout(timer);
    }
  }

  // 拉取某 episodeId 的弹幕（CommentResponseV2）—— Worker 会自动跟随 302 到 CDN
  // chConvert 从用户设置读取：0=不转换 1=简体(默认) 2=繁体
  async function ddpGetComment(episodeId) {
    const ch = loadSettings().ddpChConvert;
    const chConvert = (ch != null && ch >= 0 && ch <= 2) ? ch : 1;
    return await ddpFetch('/api/v2/comment/' + encodeURIComponent(episodeId), {
      query: { withRelated: 'true', chConvert: String(chConvert) },
    });
  }

  // 按文件名智能匹配剧集（POST /match；跳过 fileHash 以免浏览器拉前 16MB）
  // 返回 { isMatched, matches:[{episodeId,animeTitle,episodeTitle,type,typeDescription,shift}] }
  async function ddpMatch(fileName, fileSize) {
    const obj = await ddpFetch('/api/v2/match', {
      method: 'POST',
      body: { fileName: fileName || '', fileSize: fileSize || 0 },
    });
    return obj || { isMatched: false, matches: [] };
  }

  // ============= 匹配结果持久化缓存（fileName → episodeId），下次打开同文件直接命中 ============
  // key 用"归一化的视频来源"：优先完整文件路径（OpenList 反推，跨目录稳定），否则用 currentSrc（同 URL 稳定）。
  // 这样换集（fileName 变）不串，但同一文件多次打开能命中。存 {episodeId,animeTitle,episodeTitle,ts}。
  // 仅缓存"用户已确认载入"的结果（isMatched 单命中确认 / 多候选用户选定某集）——避免缓存误判。
  const MATCH_CACHE_KEY = '__titan_dm_match_cache__';
  const MATCH_CACHE_MAX = 200;          // 最多记 200 条，超出按时间淘汰最旧
  function loadMatchCache() {
    try { return JSON.parse(GM_getValue(MATCH_CACHE_KEY, '{}')) || {}; } catch (e) { return {}; }
  }
  function saveMatchCache(map) {
    try { GM_setValue(MATCH_CACHE_KEY, JSON.stringify(map || {})); } catch (e) {}
  }
  // 视频来源 → 缓存 key（去 query/sign 等不稳定部分，避免 OpenList 的 ?sign= 变化导致命中率下降）
  function matchCacheKeyOf(video) {
    let key = '';
    try {
      const fp = filePathFromVideo(video);
      if (fp && fp.length >= 2 && !/^blob:/i.test(fp)) key = fp;       // 优先文件路径
      else key = (video.currentSrc || video.src || '').split('?')[0]; // 回退 URL 去掉 query
    } catch (e) { key = (video.currentSrc || video.src || '').split('?')[0]; }
    return key || '';
  }
  function getMatchCache(video) {
    const k = matchCacheKeyOf(video);
    if (!k) return null;
    return loadMatchCache()[k] || null;
  }
  // 记录一条匹配（用户已确认载入某集）。LRU 淘汰：超限时删最旧。
  function putMatchCache(video, entry) {
    const k = matchCacheKeyOf(video);
    if (!k || !entry || !entry.episodeId) return;
    const map = loadMatchCache();
    entry.ts = Date.now();
    map[k] = entry;
    const keys = Object.keys(map);
    if (keys.length > MATCH_CACHE_MAX) {
      keys.sort((a, b) => (map[a].ts || 0) - (map[b].ts || 0));
      for (let i = 0; i < keys.length - MATCH_CACHE_MAX; i++) delete map[keys[i]];
    }
    saveMatchCache(map);
  }
  function clearMatchCache() {
    try { GM_deleteValue(MATCH_CACHE_KEY); } catch (e) {}
  }

  // ============= 刷新恢复（屏蔽/过滤重载不稳 → 刷新页面，但记住位置+弹幕数据）=============
  // 引擎 reset() 清不干净调度池导致重载重复；改用刷新页面彻底重建引擎。
  // 刷新前存 {currentTime, rawList, label, episodeId} 到 GM；刷新后 tryInit 检测并恢复。
  const RESUME_KEY = '__titan_dm_resume__';
  function loadResume() {
    try { return JSON.parse(GM_getValue(RESUME_KEY, '{}')) || {}; } catch (e) { return {}; }
  }
  function saveResume(data) {
    try { GM_setValue(RESUME_KEY, JSON.stringify(data || {})); } catch (e) {}
  }
  function clearResume() {
    try { GM_deleteValue(RESUME_KEY); } catch (e) {}
  }


  // ============= 弹幕过滤（脚本自己处理，不依赖引擎 fn.filter） =============
  // 输入：完整弹幕 list + engine.config.setting（通过参数传入，不依赖闭包 engine 变量——
  // 该变量在 IIFE 顶层不存在，之前用 typeof engine 检测永远返回 undefined，导致过滤始终失效）
  // 输出：按当前 __numBlk（mode 数字）+ blockList（每行一个，/.../ 包正则）过滤后的 list
  function filterDmList(list, settings) {
    if (!list || !list.length) return list;
    const s = settings || {};
    const numBlk = s.__numBlk || [];
    const bl = s.blockList || [];
    if (!numBlk.length && !bl.length) return list;  // 没设置过滤，原样返回
    return list.filter(d => {
      if (!d) return false;
      if (numBlk.includes(d.mode)) return false;  // 屏蔽模式
      if (bl.length) {
        const text = d.text || '';
        for (let i = 0; i < bl.length; i++) {
          const w = bl[i]; if (!w) continue;
          try {
            if (w.length > 2 && w.charAt(0) === '/' && w.charAt(w.length - 1) === '/') {
              const re = new RegExp(w.slice(1, -1));
              if (re.test(text)) return false;
            } else if (text.indexOf(w) !== -1) {
              return false;
            }
          } catch (e) { /* 正则语法错误忽略 */ }
        }
      }
      return true;
    });
  }

  // ============= 菜单定位（IIFE 顶层，FullscreenReparenter 的 onReparent 需要访问） =============
  function positionMenuGlobal() {
    const m = document.getElementById('__titan_dm_menu__');
    const b = document.getElementById('__titan_dm_btn__');
    if (!m || !b) return;
    const r = b.getBoundingClientRect();
    const menuW = Math.min(320, window.innerWidth - 16);
    const menuH = Math.min(m.scrollHeight, window.innerHeight * 0.8, 560);
    let top = r.bottom + 8;
    let left = r.left + r.width / 2 - menuW / 2;
    if (top + menuH > window.innerHeight - 8) top = Math.max(8, r.top - menuH - 8);
    if (left < 8) left = 8;
    if (left + menuW > window.innerWidth - 8) left = window.innerWidth - menuW - 8;
    m.style.top = top + 'px';
    m.style.left = left + 'px';
  }
  // 全屏 re-parent 已由 getEngine 内的 attachFullscreenReparenter 统一接管（渲染层 + 浮层 UI + 菜单重定位）

  // ============= 控件注入：单个按钮 + 弹出菜单（含开关/设置/手动载入） =============
  function injectDanmakuControls(engine, video, adapter) {
    // 拦截 setSetting：每次调用后自动持久化到 GM 跨站存储
    const _origSetSetting = engine.setSetting.bind(engine);
    engine.setSetting = function (k, v) {
      _origSetSetting(k, v);
      saveSettings(engine.config.setting);
    };

    // 控件栏由 adapter 决定（ArtPlayer: .art-controls-right 回退链；通用: null → 浮层按钮兜底）
    const insertTo = adapter.getControlsBar();
    if (insertTo) console.log('[web-danmaku-plugin] 控件注入到: ' + insertTo.className);
    else console.log('[web-danmaku-plugin] 无控件栏，使用浮层按钮');

    // 注入 CSS（一次性）。按钮样式完全复用 ArtPlayer 自带 .art-control（位置/悬浮/高亮都一致），
    // 这里只写菜单和 .off 状态。
    if (!document.getElementById('__titan_dm_css__')) {
      const css = document.createElement('style');
      css.id = '__titan_dm_css__';
      css.textContent = `
        #__titan_dm_btn__.off{opacity:0.35}
        #__titan_dm_btn__.off:hover{opacity:0.6}
        /* 控件栏内按钮（GenericAdapter 命中 DPlayer/Video.js/Plyr 等控件栏时）：中性图标按钮，color 继承控件栏图标色 */
        #__titan_dm_btn__.__titan_dm_ctrlbtn__{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;cursor:pointer;color:inherit;flex-shrink:0;opacity:.85;background:transparent;border:0;padding:0;margin:0 2px;transition:opacity .15s ease,color .15s ease}
        #__titan_dm_btn__.__titan_dm_ctrlbtn__:hover{opacity:1;color:#00a1d6}
        /* 浮层按钮兜底（GenericAdapter：无控件栏时挂 body，右下角圆形） */
        #__titan_dm_btn__.__titan_dm_floatbtn__{position:fixed;right:16px;bottom:64px;width:40px;height:40px;border-radius:50%;background:rgba(0,0,0,0.6);color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:2147483647;box-shadow:0 2px 8px rgba(0,0,0,0.4);transition:transform .12s ease,background .12s ease}
        #__titan_dm_btn__.__titan_dm_floatbtn__:hover{transform:scale(1.08);background:rgba(0,0,0,0.8)}
        /* 菜单：opacity/visibility 切换实现淡入动画，max-height + overflow-y 实现滚动，控件栏下方展开避免顶部溢出 */
        #__titan_dm_menu__{position:fixed;top:0;left:0;transform:translateY(-6px) scale(0.96);transform-origin:top center;background:linear-gradient(180deg,rgba(30,30,36,0.98),rgba(18,18,22,0.98));border:1px solid rgba(255,255,255,0.1);border-radius:10px;padding:14px 16px;min-width:290px;max-width:320px;width:max-content;max-height:min(80vh,560px);overflow-y:auto;overflow-x:hidden;color:#eee;font-size:12px;box-shadow:0 12px 40px rgba(0,0,0,0.6),inset 0 1px 0 rgba(255,255,255,0.06);z-index:2147483647;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;user-select:none;opacity:0;visibility:hidden;pointer-events:none;transition:opacity .18s ease,transform .18s cubic-bezier(.4,0,.2,1),visibility 0s linear .18s;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,0.2) transparent}
        #__titan_dm_menu__.open{opacity:1;visibility:visible;pointer-events:auto;transform:translateY(0) scale(1);transition:opacity .18s ease,transform .18s cubic-bezier(.4,0,.2,1),visibility 0s linear 0s}
        #__titan_dm_menu__::-webkit-scrollbar{width:6px}
        #__titan_dm_menu__::-webkit-scrollbar-track{background:transparent}
        #__titan_dm_menu__::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.2);border-radius:3px}
        #__titan_dm_menu__::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,0.3)}
        #__titan_dm_menu__ .row{display:flex;align-items:center;gap:8px;margin:6px 0;padding:2px 4px;border-radius:4px;transition:background .12s}
        #__titan_dm_menu__ .row:hover{background:rgba(255,255,255,0.04)}
        #__titan_dm_menu__ .row>label{flex:0 0 54px;color:#aaa;font-size:11px}
        #__titan_dm_menu__ .row input[type=range]{flex:1;min-width:0;height:4px;accent-color:#00a1d6;cursor:pointer}
        #__titan_dm_menu__ .row input[type=number]{width:60px;background:#222;color:#eee;border:1px solid #444;border-radius:4px;padding:2px 6px;font-size:12px;transition:border-color .12s}
        #__titan_dm_menu__ .row input[type=number]:focus{outline:none;border-color:#00a1d6}
        #__titan_dm_menu__ .row .val{flex:0 0 40px;text-align:right;color:#9cf;font-family:Menlo,monospace;font-size:11px}
        #__titan_dm_menu__ .row .check{flex:1}
        #__titan_dm_menu__ .title{font-size:13px;font-weight:600;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid rgba(255,255,255,0.08);color:#fff;display:flex;align-items:center;justify-content:space-between}
        #__titan_dm_menu__ .title .ttl{flex:1;min-width:0}
        #__titan_dm_menu__ .title .dm-close{flex:0 0 auto;margin-left:8px;font-size:18px;line-height:1;color:#888;cursor:pointer;padding:0 2px;transition:color .12s}
        #__titan_dm_menu__ .title .dm-close:hover{color:#fff}
        #__titan_dm_menu__ .title .hint{font-size:10px;color:#888;font-weight:400;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        #__titan_dm_menu__ .switch,#__titan_dm_settings .switch{position:relative;display:inline-block;width:42px;height:22px;background:#555;border-radius:11px;cursor:pointer;transition:background .2s ease,box-shadow .2s ease;flex:0 0 auto}
        #__titan_dm_menu__ .switch::after,#__titan_dm_settings .switch::after{content:'';position:absolute;left:3px;top:3px;width:16px;height:16px;background:#fff;border-radius:50%;transition:transform .25s cubic-bezier(.4,0,.2,1),left .25s cubic-bezier(.4,0,.2,1)}
        #__titan_dm_menu__ .switch.on,#__titan_dm_settings .switch.on{background:#00c6ff;box-shadow:0 0 10px rgba(0,198,255,0.45)}
        #__titan_dm_menu__ .switch.on::after,#__titan_dm_settings .switch.on::after{transform:translateX(20px)}
        #__titan_dm_menu__ .sep{height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.12),transparent);margin:8px -16px}
        #__titan_dm_menu__ .btn-file{display:block;width:100%;padding:9px;background:linear-gradient(180deg,#00b4e8,#0098d6);color:#fff;border:0;border-radius:6px;cursor:pointer;font-size:12px;text-align:center;font-weight:500;transition:background .12s,transform .08s}
        #__titan_dm_menu__ .btn-file:hover{background:linear-gradient(180deg,#1ac5ff,#00a1d6)}
        #__titan_dm_menu__ .btn-file:active{transform:scale(0.98)}
        #__titan_dm_menu__ .btn-more{display:block;width:100%;padding:7px;background:transparent;color:#9cf;border:1px solid rgba(255,255,255,0.15);border-radius:6px;cursor:pointer;font-size:12px;transition:all .12s}
        #__titan_dm_menu__ .btn-more:hover{background:rgba(0,161,214,0.12);border-color:rgba(0,161,214,0.5);color:#fff}
        #__titan_dm_menu__ .btn-back{background:transparent;color:#9cf;border:1px solid rgba(0,161,214,0.3);cursor:pointer;font-size:12px;padding:3px 10px;border-radius:4px;transition:all .12s}
        #__titan_dm_menu__ .btn-back:hover{background:rgba(0,161,214,0.15);color:#fff;border-color:rgba(0,161,214,0.6)}
        #__titan_dm_menu__ .dm-page{display:none;animation:dmPageIn .2s ease}
        #__titan_dm_menu__ .dm-page.active{display:block}
        @keyframes dmPageIn{from{opacity:0;transform:translateX(8px)}to{opacity:1;transform:translateX(0)}}
        #__titan_dm_menu__ .title-bar{display:flex;align-items:center;gap:8px;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid rgba(255,255,255,0.08)}
        #__titan_dm_menu__ .title-bar .title-text{font-size:13px;font-weight:600;color:#fff;flex:1}
        #__titan_dm_menu__ .check-group{display:flex;gap:8px;flex:1;font-size:11px;color:#ccc;flex-wrap:wrap}
        #__titan_dm_menu__ .check-group label{display:flex;align-items:center;gap:3px;flex:0 0 auto;cursor:pointer}
        #__titan_dm_menu__ .check-group label:hover{color:#fff}
        #__titan_dm_menu__ textarea{background:#222;color:#eee;border:1px solid #444;border-radius:4px;padding:6px 8px;font-size:11px;width:100%;resize:vertical;font-family:Menlo,monospace;min-height:50px;transition:border-color .12s}
        #__titan_dm_menu__ textarea:focus{outline:none;border-color:#00a1d6}
        #__titan_dm_menu__ input[type=checkbox]{cursor:pointer;accent-color:#00a1d6}
        #__titan_dm_menu__ .btn-save{display:block;width:100%;padding:6px;background:rgba(0,161,214,0.15);color:#9cf;border:1px solid rgba(0,161,214,0.4);border-radius:4px;cursor:pointer;font-size:11px;margin-bottom:6px;transition:all .12s}
        #__titan_dm_menu__ .btn-save:hover{background:rgba(0,161,214,0.25);color:#fff}
        /* 通用设置弹窗（独立浮层） */
        #__titan_dm_modal_mask{position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:2147483646;opacity:0;visibility:hidden;pointer-events:none;transition:opacity .2s ease,visibility 0s linear .2s;backdrop-filter:blur(2px)}
        #__titan_dm_modal_mask.open{opacity:1;visibility:visible;pointer-events:auto;transition:opacity .2s ease,visibility 0s linear 0s}
        #__titan_dm_settings{position:fixed;top:50%;left:50%;transform:translate(-50%,-48%) scale(0.96);width:min(360px,calc(100vw - 32px));max-height:min(80vh,560px);overflow-y:auto;background:linear-gradient(180deg,rgba(30,30,36,0.98),rgba(18,18,22,0.98));border:1px solid rgba(255,255,255,0.12);border-radius:12px;padding:20px 22px;color:#eee;font-size:12px;box-shadow:0 20px 60px rgba(0,0,0,0.7),inset 0 1px 0 rgba(255,255,255,0.06);z-index:2147483647;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;opacity:0;visibility:hidden;pointer-events:none;transition:opacity .2s ease,transform .2s cubic-bezier(.4,0,.2,1),visibility 0s linear .2s;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,0.2) transparent}
        #__titan_dm_settings.open{opacity:1;visibility:visible;pointer-events:auto;transform:translate(-50%,-50%) scale(1);transition:opacity .2s ease,transform .2s cubic-bezier(.4,0,.2,1),visibility 0s linear 0s}
        #__titan_dm_settings .modal-title{font-size:14px;font-weight:600;margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid rgba(255,255,255,0.1);color:#fff}
        #__titan_dm_settings .modal-section{font-size:11px;font-weight:600;color:#888;margin:14px 0 8px;text-transform:uppercase;letter-spacing:0.5px}
        #__titan_dm_settings .row{display:flex;align-items:center;gap:8px;margin:8px 0}
        #__titan_dm_settings .row>label{flex:0 0 80px;color:#aaa;font-size:12px}
        #__titan_dm_settings .btn{display:block;flex:1;padding:7px 12px;background:rgba(255,255,255,0.06);color:#eee;border:1px solid rgba(255,255,255,0.12);border-radius:5px;cursor:pointer;font-size:12px;transition:all .12s}
        #__titan_dm_settings .btn:hover{background:rgba(255,255,255,0.1);border-color:rgba(255,255,255,0.2)}
        #__titan_dm_settings .btn-primary{background:linear-gradient(180deg,#00b4e8,#0098d6);color:#fff;border-color:transparent;font-weight:500}
        #__titan_dm_settings .btn-primary:hover{background:linear-gradient(180deg,#1ac5ff,#00a1d6)}
        #__titan_dm_settings .btn-danger{background:rgba(245,80,80,0.15);color:#f88;border-color:rgba(245,80,80,0.3)}
        #__titan_dm_settings .btn-danger:hover{background:rgba(245,80,80,0.25);color:#faa;border-color:rgba(245,80,80,0.5)}
        #__titan_dm_settings .about{background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.06);border-radius:6px;padding:10px 12px;margin:6px 0;font-size:11px;line-height:1.6;color:#bbb}
        #__titan_dm_settings .about-brand{color:#fff}
        #__titan_dm_settings .about p{margin:3px 0}
        #__titan_dm_settings .about code{background:rgba(255,255,255,0.06);padding:1px 5px;border-radius:3px;font-family:Menlo,monospace;font-size:10px;color:#9cf}
        #__titan_dm_settings .about a{color:#9cf;text-decoration:none}
        #__titan_dm_settings .about a:hover{text-decoration:underline}
        #__titan_dm_settings .hint{color:#666;font-size:10px;margin-top:2px}
        /* 弹弹play 搜索弹窗（复用 settings 调色，更宽更高、flex 列布局） */
        #__titan_dm_ddp_search{position:fixed;top:50%;left:50%;transform:translate(-50%,-48%) scale(0.96);width:min(440px,calc(100vw - 32px));max-height:min(85vh,640px);display:flex;flex-direction:column;background:linear-gradient(180deg,rgba(30,30,36,0.98),rgba(18,18,22,0.98));border:1px solid rgba(255,255,255,0.12);border-radius:12px;color:#eee;font-size:12px;box-shadow:0 20px 60px rgba(0,0,0,0.7),inset 0 1px 0 rgba(255,255,255,0.06);z-index:2147483647;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;opacity:0;visibility:hidden;pointer-events:none;transition:opacity .2s ease,transform .2s cubic-bezier(.4,0,.2,1),visibility 0s linear .2s;overflow:hidden}
        #__titan_dm_ddp_search.open{opacity:1;visibility:visible;pointer-events:auto;transform:translate(-50%,-50%) scale(1);transition:opacity .2s ease,transform .2s cubic-bezier(.4,0,.2,1),visibility 0s linear 0s}
        #__titan_dm_ddp_mask{position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:2147483646;opacity:0;visibility:hidden;pointer-events:none;transition:opacity .2s ease,visibility 0s linear .2s;backdrop-filter:blur(2px)}
        #__titan_dm_ddp_mask.open{opacity:1;visibility:visible;pointer-events:auto;transition:opacity .2s ease,visibility 0s linear 0s}
        #__titan_dm_ddp_search .ddp-head{display:flex;align-items:center;gap:8px;padding:14px 16px 10px;border-bottom:1px solid rgba(255,255,255,0.08)}
        #__titan_dm_ddp_search .ddp-title{font-size:14px;font-weight:600;color:#fff;flex:1}
        #__titan_dm_ddp_search .ddp-close{background:transparent;border:0;color:#888;cursor:pointer;font-size:20px;line-height:1;padding:0 4px}
        #__titan_dm_ddp_search .ddp-close:hover{color:#fff}
        #__titan_dm_ddp_search .btn-back{background:transparent;color:#9cf;border:1px solid rgba(0,161,214,0.3);cursor:pointer;font-size:11px;padding:3px 10px;border-radius:4px;transition:all .12s}
        #__titan_dm_ddp_search .btn-back:hover{background:rgba(0,161,214,0.15);color:#fff}
        #__titan_dm_ddp_search .ddp-search{padding:10px 16px;border-bottom:1px solid rgba(255,255,255,0.06)}
        #__titan_dm_ddp_search .ddp-search-row{display:flex;gap:8px}
        #__titan_dm_ddp_search .ddp-search input{flex:1;min-width:0;background:#222;color:#eee;border:1px solid #444;border-radius:6px;padding:8px 10px;font-size:12px;transition:border-color .12s}
        #__titan_dm_ddp_search .ddp-search input:focus{outline:none;border-color:#00a1d6}
        #__titan_dm_ddp_search .ddp-btn{padding:8px 16px;background:linear-gradient(180deg,#00b4e8,#0098d6);color:#fff;border:0;border-radius:6px;cursor:pointer;font-size:12px;font-weight:500;transition:background .12s}
        #__titan_dm_ddp_search .ddp-btn:hover{background:linear-gradient(180deg,#1ac5ff,#00a1d6)}
        #__titan_dm_ddp_search .ddp-btn:disabled{opacity:0.5;cursor:default}
        #__titan_dm_ddp_search .ddp-match-btn{display:block;width:100%;margin-top:8px;padding:7px;background:rgba(0,161,214,0.1);color:#9cf;border:1px solid rgba(0,161,214,0.3);border-radius:6px;cursor:pointer;font-size:11px;transition:all .12s}
        #__titan_dm_ddp_search .ddp-match-btn:hover{background:rgba(0,161,214,0.2);color:#fff}
        #__titan_dm_ddp_search .ddp-list{flex:1;overflow-y:auto;overflow-x:hidden;padding:6px 10px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,0.2) transparent}
        #__titan_dm_ddp_search .ddp-list::-webkit-scrollbar{width:6px}
        #__titan_dm_ddp_search .ddp-list::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.2);border-radius:3px}
        #__titan_dm_ddp_search .ddp-anime{display:flex;gap:10px;padding:7px;border-radius:8px;cursor:pointer;transition:background .12s;align-items:center}
        #__titan_dm_ddp_search .ddp-anime:hover{background:rgba(0,161,214,0.12)}
        #__titan_dm_ddp_search .ddp-anime img{width:40px;height:56px;object-fit:cover;border-radius:4px;flex-shrink:0;background:#333}
        #__titan_dm_ddp_search .ddp-anime .meta{flex:1;min-width:0}
        #__titan_dm_ddp_search .ddp-anime .ttl{color:#fff;font-weight:500;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        #__titan_dm_ddp_search .ddp-anime .sub{color:#888;font-size:11px;margin-top:3px}
        #__titan_dm_ddp_search .ddp-ep{display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:6px;cursor:pointer;transition:background .12s}
        #__titan_dm_ddp_search .ddp-ep:hover{background:rgba(0,161,214,0.14)}
        #__titan_dm_ddp_search .ddp-ep .no{flex:0 0 34px;color:#9cf;font-family:Menlo,monospace;font-size:11px}
        #__titan_dm_ddp_search .ddp-ep .ttl{flex:1;color:#ddd;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        #__titan_dm_ddp_search .ddp-ep .load{font-size:10px;color:#666}
        #__titan_dm_ddp_search .ddp-status{padding:8px 16px 12px;color:#9cf;font-size:11px;min-height:18px;border-top:1px solid rgba(255,255,255,0.06);display:flex;align-items:center;gap:8px}
        #__titan_dm_ddp_search .ddp-status .ddp-spin{flex:0 0 auto;width:13px;height:13px;border:2px solid rgba(0,161,214,0.25);border-top-color:#00a1d6;border-radius:50%;animation:ddpSpin .7s linear infinite;display:none}
        #__titan_dm_ddp_search .ddp-status.loading .ddp-spin{display:block}
        @keyframes ddpSpin{to{transform:rotate(360deg)}}
        /* list 区加载遮罩：请求进行中覆盖，禁止误点 */
        #__titan_dm_ddp_search .ddp-list-wrap{position:relative;flex:1;min-height:0;overflow:hidden}
        #__titan_dm_ddp_search .ddp-list{height:100%;overflow-y:auto;overflow-x:hidden;padding:6px 10px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,0.2) transparent}
        #__titan_dm_ddp_search .ddp-list::-webkit-scrollbar{width:6px}
        #__titan_dm_ddp_search .ddp-list::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.2);border-radius:3px}
        #__titan_dm_ddp_search .ddp-loading{position:absolute;inset:0;display:none;align-items:center;justify-content:center;flex-direction:column;gap:10px;background:rgba(18,18,22,0.55);backdrop-filter:blur(1px);z-index:2}
        #__titan_dm_ddp_search .ddp-loading.show{display:flex}
        #__titan_dm_ddp_search .ddp-loading .big-spin{width:34px;height:34px;border:3px solid rgba(0,161,214,0.2);border-top-color:#00a1d6;border-radius:50%;animation:ddpSpin .8s linear infinite}
        #__titan_dm_ddp_search .ddp-loading .big-txt{color:#9cf;font-size:12px}
        #__titan_dm_ddp_search .ddp-empty{padding:28px 16px;text-align:center;color:#666;font-size:12px}
        /* ============= 亮色模式（跟随页面主题，html.__titan_dm_light__ 时生效）=============
           暗色为默认（上面那套）。亮色仅覆盖"面板背景/文字/边框/输入框"等主题敏感色，
           accent(#00a1d6 蓝) 与按钮渐变两种模式通用不动，保证辨识一致。
           零特异性 :where() 不影响原规则优先级，仅覆盖颜色。 */
        html.__titan_dm_light__ #__titan_dm_menu__{background:linear-gradient(180deg,#fff,#f4f6f8);color:#222;border-color:rgba(0,0,0,0.1);box-shadow:0 12px 40px rgba(0,0,0,0.18),inset 0 1px 0 rgba(255,255,255,0.6)}
        html.__titan_dm_light__ #__titan_dm_menu__ .row>label{color:#666}
        html.__titan_dm_light__ #__titan_dm_menu__ .row:hover{background:rgba(0,0,0,0.04)}
        html.__titan_dm_light__ #__titan_dm_menu__ .row input[type=number]{background:#fff;color:#222;border-color:#ccc}
        html.__titan_dm_light__ #__titan_dm_menu__ .row .val{color:#0070a8}
        html.__titan_dm_light__ #__titan_dm_menu__ .title{color:#111;border-color:rgba(0,0,0,0.08)}
        html.__titan_dm_light__ #__titan_dm_menu__ .title .dm-close{color:#999}
        html.__titan_dm_light__ #__titan_dm_menu__ .title .dm-close:hover{color:#000}
        html.__titan_dm_light__ #__titan_dm_menu__ .title .hint{color:#888}
        html.__titan_dm_light__ #__titan_dm_menu__ .title-bar{border-color:rgba(0,0,0,0.08)}
        html.__titan_dm_light__ #__titan_dm_menu__ .title-bar .title-text{color:#111}
        html.__titan_dm_light__ #__titan_dm_menu__ .check-group{color:#444}
        html.__titan_dm_light__ #__titan_dm_menu__ .check-group label:hover{color:#000}
        html.__titan_dm_light__ #__titan_dm_menu__ textarea{background:#fff;color:#222;border-color:#ccc}
        html.__titan_dm_light__ #__titan_dm_menu__ .switch,html.__titan_dm_light__ #__titan_dm_settings .switch{background:#ccc}
        html.__titan_dm_light__ #__titan_dm_menu__ .switch.on,html.__titan_dm_light__ #__titan_dm_settings .switch.on{background:#00b4e8;box-shadow:0 0 8px rgba(0,180,232,0.4)}
        html.__titan_dm_light__ #__titan_dm_menu__ .sep{background:linear-gradient(90deg,transparent,rgba(0,0,0,0.1),transparent)}
        html.__titan_dm_light__ #__titan_dm_menu__ .btn-more{color:#0070a8;border-color:rgba(0,0,0,0.15)}
        html.__titan_dm_light__ #__titan_dm_menu__ .btn-more:hover{color:#000;border-color:rgba(0,161,214,0.5)}
        html.__titan_dm_light__ #__titan_dm_menu__ .btn-back{color:#0070a8;border-color:rgba(0,161,214,0.3)}
        html.__titan_dm_light__ #__titan_dm_menu__ .btn-back:hover{color:#000}
        html.__titan_dm_light__ #__titan_dm_menu__ .btn-save{color:#0070a8;background:rgba(0,161,214,0.1);border-color:rgba(0,161,214,0.3)}
        html.__titan_dm_light__ #__titan_dm_menu__ .btn-save:hover{color:#000}
        /* 通用设置弹窗 */
        html.__titan_dm_light__ #__titan_dm_settings{background:linear-gradient(180deg,#fff,#f4f6f8);color:#222;border-color:rgba(0,0,0,0.12);box-shadow:0 20px 60px rgba(0,0,0,0.2),inset 0 1px 0 rgba(255,255,255,0.6)}
        html.__titan_dm_light__ #__titan_dm_settings .modal-title{color:#111;border-color:rgba(0,0,0,0.08)}
        html.__titan_dm_light__ #__titan_dm_settings .modal-section{color:#888}
        html.__titan_dm_light__ #__titan_dm_settings .row>label{color:#666}
        html.__titan_dm_light__ #__titan_dm_settings select{background:#fff;color:#222;border-color:#ccc}
        html.__titan_dm_light__ #__titan_dm_settings .btn{background:rgba(0,0,0,0.04);color:#222;border-color:rgba(0,0,0,0.12)}
        html.__titan_dm_light__ #__titan_dm_settings .btn:hover{background:rgba(0,0,0,0.08);border-color:rgba(0,0,0,0.2)}
        html.__titan_dm_light__ #__titan_dm_settings .btn-danger{background:rgba(220,50,50,0.08);color:#c33;border-color:rgba(220,50,50,0.25)}
        html.__titan_dm_light__ #__titan_dm_settings .about{background:rgba(0,0,0,0.03);border-color:rgba(0,0,0,0.06);color:#555}
        html.__titan_dm_light__ #__titan_dm_settings .about-brand{color:#111}
        html.__titan_dm_light__ #__titan_dm_settings .about code{background:rgba(0,0,0,0.06);color:#0070a8}
        html.__titan_dm_light__ #__titan_dm_settings .about a{color:#0070a8}
        html.__titan_dm_light__ #__titan_dm_settings .hint{color:#999}
        /* 弹弹play 搜索弹窗 */
        html.__titan_dm_light__ #__titan_dm_ddp_search{background:linear-gradient(180deg,#fff,#f4f6f8);color:#222;border-color:rgba(0,0,0,0.12);box-shadow:0 20px 60px rgba(0,0,0,0.2),inset 0 1px 0 rgba(255,255,255,0.6)}
        html.__titan_dm_light__ #__titan_dm_ddp_search .ddp-title{color:#111}
        html.__titan_dm_light__ #__titan_dm_ddp_search .ddp-close{color:#888}
        html.__titan_dm_light__ #__titan_dm_ddp_search .ddp-close:hover{color:#000}
        html.__titan_dm_light__ #__titan_dm_ddp_search .ddp-head{border-color:rgba(0,0,0,0.08)}
        html.__titan_dm_light__ #__titan_dm_ddp_search .ddp-search{border-color:rgba(0,0,0,0.06)}
        html.__titan_dm_light__ #__titan_dm_ddp_search .ddp-search input{background:#fff;color:#222;border-color:#ccc}
        html.__titan_dm_light__ #__titan_dm_ddp_search .btn-back{color:#0070a8}
        html.__titan_dm_light__ #__titan_dm_ddp_search .btn-back:hover{color:#000}
        html.__titan_dm_light__ #__titan_dm_ddp_search .ddp-match-btn{color:#0070a8;background:rgba(0,161,214,0.06);border-color:rgba(0,161,214,0.25)}
        html.__titan_dm_light__ #__titan_dm_ddp_search .ddp-match-btn:hover{color:#000}
        html.__titan_dm_light__ #__titan_dm_ddp_search .ddp-anime:hover{background:rgba(0,161,214,0.08)}
        html.__titan_dm_light__ #__titan_dm_ddp_search .ddp-anime img{background:#eee}
        html.__titan_dm_light__ #__titan_dm_ddp_search .ddp-anime .ttl{color:#111}
        html.__titan_dm_light__ #__titan_dm_ddp_search .ddp-anime .sub{color:#888}
        html.__titan_dm_light__ #__titan_dm_ddp_search .ddp-ep:hover{background:rgba(0,161,214,0.1)}
        html.__titan_dm_light__ #__titan_dm_ddp_search .ddp-ep .no{color:#0070a8}
        html.__titan_dm_light__ #__titan_dm_ddp_search .ddp-ep .ttl{color:#333}
        html.__titan_dm_light__ #__titan_dm_ddp_search .ddp-ep .load{color:#999}
        html.__titan_dm_light__ #__titan_dm_ddp_search .ddp-status{color:#0070a8;border-color:rgba(0,0,0,0.06)}
        html.__titan_dm_light__ #__titan_dm_ddp_search .ddp-loading{background:rgba(255,255,255,0.55)}
        html.__titan_dm_light__ #__titan_dm_ddp_search .ddp-loading .big-txt{color:#0070a8}
        html.__titan_dm_light__ #__titan_dm_ddp_search .ddp-empty{color:#999}
        /* 主题切换按钮（菜单底部，通用设置弹窗内也可手动切）*/
        #__titan_dm_menu__ .btn-theme{display:block;width:100%;padding:6px;background:transparent;color:#9cf;border:1px solid rgba(255,255,255,0.15);border-radius:4px;cursor:pointer;font-size:11px;margin-top:6px;transition:all .12s}
        #__titan_dm_menu__ .btn-theme:hover{background:rgba(0,161,214,0.12);color:#fff}
        html.__titan_dm_light__ #__titan_dm_menu__ .btn-theme{color:#0070a8;border-color:rgba(0,0,0,0.15)}
        html.__titan_dm_light__ #__titan_dm_menu__ .btn-theme:hover{color:#000}
      `;
      document.head.appendChild(css);
    }
    // 应用主题（首次注入即生效；之后 toggle 切换）
    applyTheme();

    if (document.getElementById('__titan_dm_btn__')) return;
    const $ = (id) => document.getElementById(id);

    // 按钮：类名/插入位置由 adapter 给（ArtPlayer 复用 .art-control 插到最前；DPlayer 走原生 .dplayer-icon 进右图标组；
    // 通用控件栏走中性样式追加末尾；无控件栏时退回右下浮层按钮）。菜单定位统一复用 #__titan_dm_btn__ rect。
    const btn = document.createElement('div');
    btn.id = '__titan_dm_btn__';
    btn.setAttribute('data-hint', '弹幕设置');
    btn.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V6h16v12zM6 10h2v2H6v-2zm0 4h8v2H6v-2zm10 0h2v2h-2v-2zm-6-4h8v2h-8v-2z"/></svg>';
    if (insertTo) {
      // adapter 可改写按钮内部结构/属性以贴近原生控件（DPlayer 包 .dplayer-icon-content + data-balloon）
      if (typeof adapter.decorateButton === 'function') adapter.decorateButton(btn);
      btn.className = adapter.buttonClass();
      adapter.insertButton(btn, insertTo);
    } else {
      // 无控件栏：浮层按钮挂 body（右下角圆形）
      btn.className = '__titan_dm_floatbtn__';
      document.body.appendChild(btn);
    }

    // 菜单
    const menu = document.createElement('div');
    menu.id = '__titan_dm_menu__';
    menu.innerHTML = `
      <!-- Page 1: 常用设置 -->
      <div class="dm-page active" data-page="1">
        <div class="title"><span class="ttl">弹幕设置 <span class="hint dm-status"></span></span><span class="dm-close" id="__dm_menu_close__" title="关闭">×</span></div>
        <div class="row"><label>显示</label><div id="__dm_switch__" class="switch on"></div></div>
        <div class="sep"></div>
        <div class="row"><label>字号</label><input type=range id=__dm_font__ min=50 max=200 value=100 step=5><span class=val id=__dm_fontv__>1.0×</span></div>
        <div class="row"><label>透明度</label><input type=range id=__dm_op__ min=20 max=100 value=85 step=5><span class=val id=__dm_opv__>85%</span></div>
        <div class="row"><label>区域</label><input type=range id=__dm_area__ min=25 max=100 value=100 step=5><span class=val id=__dm_areav__>满屏</span></div>
        <div class="row"><label>速度</label><input type=range id=__dm_speed__ min=25 max=300 value=100 step=25><span class=val id=__dm_speedv__>1.0×</span></div>
        <div class="row"><label>密度</label><input type=range id=__dm_dens__ min=10 max=100 value=100 step=10><span class=val id=__dm_densv__>1.0</span></div>
        <div class="row"><label>时长</label><input type=range id=__dm_dur__ min=20 max=120 value=45 step=5><span class=val id=__dm_durv__>4.5s</span></div>
        <div class="row"><label>上限</label><input type=number id=__dm_limit__ value=300 min=0 step=50></div>
        <div class="sep"></div>
        <div class="row"><label>速度同步</label><input type=checkbox class=check id=__dm_sync__ checked></div>
        <div class="row"><label>加粗</label><input type=checkbox class=check id=__dm_bold__ checked></div>
        <div class="row"><label>描边</label><input type=checkbox class=check id=__dm_border__></div>
        <div class="row"><label>防遮挡</label><input type=checkbox class=check id=__dm_shade__></div>
        <div class="sep"></div>
        <button class="btn-more" data-go-page="2">更多设置 →</button>
      </div>
      <!-- Page 2: 高级设置 -->
      <div class="dm-page" data-page="2">
        <div class="title-bar">
          <button class="btn-back" data-go-page="1">← 返回</button>
          <span class="title-text">高级设置</span>
          <span class="hint dm-status"></span>
        </div>
        <div class="row"><label>全屏同步</label><input type=checkbox class=check id=__dm_fssync__></div>
        <div class="row"><label>顶部偏移</label><input type=number id=__dm_offtop__ value=0 step=1 style="width:60px"></div>
        <div class="row"><label>底部偏移</label><input type=number id=__dm_offbot__ value=0 step=1 style="width:60px"></div>
        <div class="row"><label>最大长度</label><input type=number id=__dm_maxlen__ value=50 min=0 step=10 style="width:60px"></div>
        <div class="sep"></div>
        <div class="row"><label>屏蔽类型</label>
          <div class="check-group">
            <label><input type=checkbox class=check id=__dm_blk_1__>滚动</label>
            <label><input type=checkbox class=check id=__dm_blk_4__>底部</label>
            <label><input type=checkbox class=check id=__dm_blk_5__>顶部</label>
            <label><input type=checkbox class=check id=__dm_blk_6__>逆向</label>
          </div>
        </div>
        <div class="row" style="flex-direction:column;align-items:stretch;gap:4px">
          <label>屏蔽词（每行一个，/正则/ 或子串）</label>
          <button class="btn-save" id="__dm_save_blocklist__">💾 保存并应用</button>
          <textarea id=__dm_blocklist__ rows=3 placeholder="如：广告&#10;/^.*剧透.*$/"></textarea>
        </div>
        <div class="sep"></div>
        <div class="row"><label>DOM 回收</label><input type=checkbox class=check id=__dm_recdom__ checked></div>
        <div class="row"><label>模型回收</label><input type=checkbox class=check id=__dm_recmdl__></div>
        <div class="row"><label>拖拽视频</label><input type=checkbox class=check id=__dm_bindmove__ checked></div>
        <div class="row"><label>禁止缩小</label><input type=checkbox class=check id=__dm_shrink__ checked></div>
      </div>
      <div class="sep"></div>
      <button class="btn-more" id="__dm_ddp_search__">🌐 弹弹play 搜索弹幕</button>
      <button class="btn-more" id="__dm_ddp_match__" style="margin-top:6px">✨ 智能匹配当前视频</button>
      <button class="btn-file" id="__dm_load_file__" style="margin-top:10px">📂 载入本地弹幕文件</button>
      <button class="btn-theme" id="__dm_toggle_theme__">🌓 切换主题（当前：自动）</button>
      <button class="btn-more" id="__dm_open_settings__" style="margin-top:6px">⚙ 通用设置</button>
    `;
    // 菜单挂到 body（脱开 art-video-player 的 overflow: hidden 裁切），用 position: fixed 手动定位到 btn 旁边
    document.body.appendChild(menu);

    // 通用设置弹窗（独立的浮层 + 遮罩），也挂到 body
    const settingsModal = document.createElement('div');
    settingsModal.id = '__titan_dm_settings';
    settingsModal.innerHTML = `
      <div class="modal-title">⚙ 通用设置</div>
      <div class="modal-section">配置管理</div>
      <div class="row"><label>重置所有</label><button class="btn btn-danger" id="__dm_reset_all__">清空所有存储</button></div>
      <div class="row"><label>导出</label><button class="btn" id="__dm_export__">下载 settings.json</button></div>
      <div class="row"><label>导入</label><button class="btn" id="__dm_import__">选择 JSON 文件</button></div>
      <input type="file" id="__dm_import_file" accept=".json" style="display:none">
      <div class="modal-section">弹弹play 代理</div>
      <div class="row"><label>Worker URL</label><input type="text" id="__dm_ddp_url__" placeholder="留空用默认内置 API" style="flex:1;min-width:0;background:#222;color:#eee;border:1px solid #444;border-radius:5px;padding:7px 10px;font-size:12px"></div>
      <div class="row"><label>Token</label><input type="text" id="__dm_ddp_token__" placeholder="留空用默认" style="flex:1;min-width:0;background:#222;color:#eee;border:1px solid #444;border-radius:5px;padding:7px 10px;font-size:12px"></div>
      <div class="row"><label>简繁转换</label><select id="__dm_chconvert__" style="flex:1;min-width:0;background:#222;color:#eee;border:1px solid #444;border-radius:5px;padding:7px 10px;font-size:12px;cursor:pointer"><option value="1">转换为简体（默认）</option><option value="0">不转换</option><option value="2">转换为繁体</option></select></div>
      <div class="row"><button class="btn btn-primary" id="__dm_ddp_save__">保存代理配置</button></div>
      <div class="row"><label>匹配缓存</label><button class="btn btn-danger" id="__dm_ddp_clear_match__">清空已匹配记录</button></div>
      <p class="hint">部署自己的 Worker 见 <code style="font-size:10px">userscript/worker/README.md</code>；匹配过的视频会记住，下次「智能匹配」直接命中，免重复请求。</p>
      <div class="modal-section">AI 配置（智能匹配增强）</div>
      <div class="row"><label>启用 AI</label><div id="__dm_ai_switch__" class="switch"></div><span class="hint" style="margin:0 0 0 8px">开启后「✨ 智能匹配」用 LLM 提取文件名</span></div>
      <div class="row"><label>全自动载入</label><div id="__dm_auto_match__" class="switch"></div><span class="hint" style="margin:0 0 0 8px">打开视频自动匹配标题→单结果自动载入弹幕（零操作）</span></div>
      <div class="row"><label>API 地址</label><input type="text" id="__dm_ai_url__" placeholder="https://api.deepseek.com/v1" style="flex:1;min-width:0;background:#222;color:#eee;border:1px solid #444;border-radius:5px;padding:7px 10px;font-size:12px"></div>
      <div class="row"><label>Key</label><input type="text" id="__dm_ai_key__" placeholder="sk-...（OpenAI 兼容）" style="flex:1;min-width:0;background:#222;color:#eee;border:1px solid #444;border-radius:5px;padding:7px 10px;font-size:12px"></div>
      <div class="row"><label>模型</label><input type="text" id="__dm_ai_model__" placeholder="deepseek-chat / gpt-4o-mini 等" style="flex:1;min-width:0;background:#222;color:#eee;border:1px solid #444;border-radius:5px;padding:7px 10px;font-size:12px"></div>
      <div class="row"><button class="btn btn-primary" id="__dm_ai_save__">保存 AI 配置</button></div>
      <p class="hint">开启后显示「✨ 智能匹配当前视频」，使用AI提取番剧名+集号再搜索；关闭则该按钮隐藏。</p>
      <div class="modal-section">关于</div>
      <div class="about">
        <p><b class="about-brand"> 今天要来点弹幕吗？</b></p>
        <p>脚本版本：<code id="__dm_ver_script__">1.1.2</code></p>
        <p>引擎：B 站原版 <code>bili-danmaku-x</code>代号[Titan]</p>
        <p>Bundle：<a href="https://cdn.jsdelivr.net/gh/makabaka11/DFM-Next@master/titan-bundle.js" target="_blank">jsDelivr</a>（11.4 MB）</p>
        <p>仓库：<a href="https://github.com/makabaka11/web-danmaku-plugin" target="_blank">github.com/makabaka11/web-danmaku-plugin</a></p>
        <p>作者：Retr0</p>
        <p class="hint">本脚本仅供个人研究学习使用</p>
      </div>
      <div class="sep" style="height:1px;background:rgba(255,255,255,0.08);margin:16px -22px"></div>
      <button class="btn btn-primary" id="__dm_close_settings__">关闭</button>
    `;
    document.body.appendChild(settingsModal);
    const settingsMask = document.createElement('div');
    settingsMask.id = '__titan_dm_modal_mask';
    document.body.appendChild(settingsMask);

    // ============= 弹弹play 搜索 / 匹配 UI =============
    // 搜索弹窗：关键词搜作品 → 选作品 → 列剧集 → 点剧集经 Worker 拉弹幕载入引擎
    const ddpModal = document.createElement('div');
    ddpModal.id = '__titan_dm_ddp_search';
    ddpModal.innerHTML = `
      <div class="ddp-head">
        <button class="btn-back" id="__ddp_back__" style="display:none">← 作品</button>
        <span class="ddp-title">弹弹play 弹幕搜索</span>
        <button class="ddp-close" id="__ddp_close__">×</button>
      </div>
      <div class="ddp-search">
        <div class="ddp-search-row">
          <input type="text" id="__ddp_kw__" placeholder="番剧名（中文/日文/罗马音/英文，≥2 字）" />
          <button class="ddp-btn" id="__ddp_go__">搜索</button>
        </div>
        <button class="ddp-match-btn" id="__ddp_match2__">✨ 智能匹配当前视频文件名</button>
      </div>
      <div class="ddp-list-wrap">
        <div class="ddp-list" id="__ddp_list__">
          <div class="ddp-empty">输入关键词后回车搜索</div>
        </div>
        <div class="ddp-loading" id="__ddp_loading__">
          <div class="big-spin"></div>
          <div class="big-txt" id="__ddp_loading_txt__">加载中…</div>
        </div>
      </div>
      <div class="ddp-status" id="__ddp_status__"><span class="ddp-spin"></span><span class="ddp-status-txt"></span></div>
    `;
    document.body.appendChild(ddpModal);
    const ddpMask = document.createElement('div');
    ddpMask.id = '__titan_dm_ddp_mask';
    document.body.appendChild(ddpMask);

    let ddpLastResults = null;     // 上次 SearchEpisodesResponse（重开弹窗复显）
    let ddpCurrentAnime = null;    // 当前展开到剧集视图的作品

    // 状态条 + 加载控制：opts.loading=true 显示 spinner + 遮罩 + 禁用搜索按钮（请求进行中）
    function ddpSetStatus(t, isErr, opts) {
      opts = opts || {};
      const el = $('__ddp_status__');
      const txt = el.querySelector('.ddp-status-txt');
      if (txt) txt.textContent = t || '';
      el.classList.toggle('loading', !!opts.loading);
      el.style.color = isErr ? '#f88' : '#9cf';
      // 遮罩 + 禁用按钮
      const loading = $('__ddp_loading__');
      if (loading) {
        loading.classList.toggle('show', !!opts.loading);
        if (opts.loading) $('__ddp_loading_txt__').textContent = t || '加载中…';
      }
      const goBtn = $('__ddp_go__');
      if (goBtn) { goBtn.disabled = !!opts.loading; }
    }
    function escapeHtml(s) {
      return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    }
    const DDP_TYPE_LABEL = { tvseries: 'TV', tvspecial: 'SP', ova: 'OVA', movie: '剧场版', musicvideo: 'MV', web: 'WEB', other: '其它', jpmovie: '日影', jpdrama: '日剧', tmdbtv: 'TMDB剧', tmdbmovie: 'TMDB影', unknown: '未知' };
    function animeTypeLabel(t) { return DDP_TYPE_LABEL[t] || t || ''; }

    // 视图①：作品列表（点击进入该剧剧集）
    function renderDdpAnimes(res) {
      const animes = (res && res.animes) || [];
      ddpLastResults = res;
      const list = $('__ddp_list__');
      if (!animes.length) { list.innerHTML = '<div class="ddp-empty">无结果，换个关键词试试</div>'; return; }
      list.innerHTML = animes.map((a, i) => `
        <div class="ddp-anime" data-i="${i}">
          ${a.imageUrl ? `<img src="${escapeHtml(a.imageUrl)}" alt="" onerror="this.style.visibility='hidden'">` : '<img alt="" style="visibility:hidden">'}
          <div class="meta">
            <div class="ttl">${escapeHtml(a.animeTitle || ('#' + a.animeId))}</div>
            <div class="sub">${animeTypeLabel(a.type)} · ${((a.episodes || []).length)} 集${a.startDate ? ' · ' + String(a.startDate).slice(0, 10) : ''}</div>
          </div>
        </div>`).join('');
      list.querySelectorAll('.ddp-anime').forEach(el => {
        el.addEventListener('click', () => renderDdpEpisodes(animes[+el.dataset.i]));
      });
    }

    // 视图②：某作品的剧集列表（点击 → 经 Worker 拉弹幕载入引擎）
    function renderDdpEpisodes(a) {
      ddpCurrentAnime = a;
      const eps = a.episodes || [];
      $('__ddp_back__').style.display = '';
      ddpSetStatus((a.animeTitle || '') + ' · ' + eps.length + ' 集 — 点击载入弹幕');
      const list = $('__ddp_list__');
      list.innerHTML = eps.length ? eps.map((e, i) => `
        <div class="ddp-ep" data-i="${i}">
          <span class="no">${escapeHtml(e.episodeNumber || (i + 1))}</span>
          <span class="ttl">${escapeHtml(e.episodeTitle || '')}</span>
          <span class="load">载入 →</span>
        </div>`).join('') : '<div class="ddp-empty">该剧无剧集数据</div>';
      list.querySelectorAll('.ddp-ep').forEach(el => {
        el.addEventListener('click', () => {
          const idx = +el.dataset.i;
          const e = eps[idx];
          const label = (a.animeTitle || '') + ' ' + (e.episodeTitle || ('第' + (e.episodeNumber || (idx + 1)) + '集'));
          // 传 meta：用户通过搜索选定某集，也记入匹配缓存（下次智能匹配可命中）
          loadDandanplayComment(e.episodeId, label, { episodeId: e.episodeId, animeTitle: a.animeTitle, episodeTitle: e.episodeTitle });
        });
      });
    }

    // 经 Worker 拉某 episodeId 的弹幕并载入引擎（复用 applyDanmakuList，保留视频当前位置）
    // 载入成功后顺带记入匹配缓存（用户通过搜索/多候选选定的集也会被记住，下次智能匹配可命中）
    async function loadDandanplayComment(episodeId, label, meta) {
      if (!ddpReady()) { ddpSetStatus('未配置代理，请先在通用设置填写 Worker URL', true); return; }
      try {
        ddpSetStatus('拉取弹幕中… ' + label, false, { loading: true });
        const obj = await ddpGetComment(episodeId);   // Worker 已跟随 302 到 CDN
        const rawList = ddpCommentsToList(obj && obj.comments);
        if (!rawList.length) { ddpSetStatus('该集暂无弹幕', true); return; }
        applyDanmakuList(rawList, label, { seekTo: video.currentTime || 0 });
        ddpSetStatus('✓ 已载入 ' + label + ' · ' + rawList.length + ' 条（弹幕可关）');
        // 记录匹配缓存（有 meta 就用，没有也至少存 episodeId + label 解析出的标题）
        if (meta && meta.episodeId) putMatchCache(video, meta);
        else if (video) putMatchCache(video, { episodeId, animeTitle: meta && meta.animeTitle, episodeTitle: meta && meta.episodeTitle });
      } catch (e) { ddpSetStatus('载入失败: ' + e.message, true); }
    }

    async function doDdpSearch() {
      const kw = $('__ddp_kw__').value.trim();
      if (kw.length < 2) { ddpSetStatus('关键词至少 2 个字符', true); return; }
      if (!ddpReady()) { ddpSetStatus('未配置代理，请先在通用设置填写 Worker URL', true); return; }
      try {
        ddpSetStatus('搜索中…', false, { loading: true });
        const res = await ddpSearchEpisodes(kw);
        ddpCurrentAnime = null;
        $('__ddp_back__').style.display = 'none';
        renderDdpAnimes(res);
        ddpSetStatus('找到 ' + (((res && res.animes) || []).length) + ' 部作品');
      } catch (e) { ddpSetStatus('搜索失败: ' + e.message, true); }
    }

    // 智能匹配：优先用网页标题（更通用，非 OpenList 站点也能提取番剧信息），
    // 回退到视频文件名；再经 AI（开）/match（关）定位剧集。
    async function doDdpMatch() {
      if (!ddpReady()) { ddpSetStatus('未配置代理，请先在通用设置填写 Worker URL', true); return; }
      // ① 主信息源：网页标题（含番剧名+集号，适用于 B站/YT/巴哈等）
      const pageTitle = getPageTitle() || '';
      // ② 回退信息源：视频文件名（OpenList 同目录场景）
      let fileName = '';
      try { const fp = filePathFromVideo(video) || ''; fileName = (fp.split(/[\\/]/).pop() || fp).replace(/\.[^.]+$/, ''); } catch (e) {}
      // 优先用网页标题（更通用、信息更全），没有再用文件名
      const matchText = pageTitle || fileName;
      const src = video.currentSrc || video.src || '';
      if (!matchText || matchText.length < 2) {
        ddpSetStatus('当前视频无可用匹配信息（网页标题/文件名均空），请改用关键词搜索', true);
        return;
      }
      // ③ 持久化缓存命中：之前匹配过并确认载入过这个文件 → 直接建议载入
      const cached = getMatchCache(video);
      if (cached && cached.episodeId) {
        const label = (cached.animeTitle || '') + ' ' + (cached.episodeTitle || '');
        ddpSetStatus('⚡ 命中缓存：上次匹配到 ' + label);
        if (confirm('⚡ 命中历史匹配：\n' + label + '\n（来自上次匹配记录）\n\n载入该集弹幕？')) {
          loadDandanplayComment(cached.episodeId, label);
        } else {
          ddpSetStatus('已取消缓存结果，可重新匹配');
          const k = matchCacheKeyOf(video);
          if (k) { const m = loadMatchCache(); delete m[k]; saveMatchCache(m); }
        }
        return;
      }
      let fileSize = 0;
      try { const head = await fetch(src, { method: 'HEAD' }); const cl = head.headers.get('Content-Length'); if (cl) fileSize = +cl; } catch (e) {}

      // ④ AI 提取（开关开启时一定走 AI）：用 matchText（优先标题）经 LLM 清洗 → {title, episode} → 搜索
      if (aiEnabled()) {
        if (!aiReady()) {
          ddpSetStatus('🤖 AI 已开启但配置不全（缺 API 地址/模型），请到通用设置填写', true);
          if (confirm('AI 智能匹配已开启，但 LLM 配置不完整（需 API 地址 + 模型）。\n\n去「⚙ 通用设置 → AI 配置」填写？')) {
            closeDdpModal(); openSettingsModal();
          }
          return;
        }
        try {
          ddpSetStatus('🤖 AI 提取中… ' + matchText.slice(0, 50), false, { loading: true });
          const ext = await llmExtractFileName(matchText);
          if (ext && ext.title) {
            ddpSetStatus('🤖 AI 提取: ' + ext.title + (ext.episode ? ' 第' + ext.episode + '集' : '（剧场版）') + '，搜索中…', false, { loading: true });
            const res = await ddpSearchEpisodes(ext.title, ext.episode);
            const animes = (res && res.animes) || [];
            if (animes.length) {
              ddpLastResults = res;
              ddpCurrentAnime = null;
              $('__ddp_back__').style.display = 'none';
              renderDdpAnimes(res);
              ddpSetStatus('🤖 AI 命中 ' + animes.length + ' 部作品' + (ext.episode ? '（已定位第' + ext.episode + '集）' : '') + '，点击载入');
              return;
            }
            ddpSetStatus('🤖 AI 提取到「' + ext.title + '」但未搜到作品，请调整关键词', true);
            $('__ddp_kw__').value = ext.title;
            return;
          }
          ddpSetStatus('🤖 AI 未能从信息提取，请改用关键词搜索', true);
          return;
        } catch (e) {
          ddpSetStatus('🤖 AI 提取失败: ' + e.message + '（开关已开，不回退文件名匹配）', true);
          return;
        }
      }

      // ⑤ AI 未开启：有文件名走 /match，否则用网页标题/文件名搜索
      try {
        // 如果有文件名（且非 blob），优先用精确匹配接口
        if (fileName && fileName.length >= 2 && !/^blob:/i.test(src)) {
          ddpSetStatus('匹配中… ' + fileName, false, { loading: true });
          const res = await ddpMatch(fileName, fileSize);
          const matches = (res && res.matches) || [];
          if (!matches.length) {
            // /match 无结果：用文件名搜索
            ddpSetStatus('未匹配到，已用文件名搜索', true);
            $('__ddp_kw__').value = fileName;
            doDdpSearch();
            return;
          }
          if (res.isMatched && matches.length === 1) {
            const m = matches[0];
            const label = (m.animeTitle || '') + ' ' + (m.episodeTitle || '');
            if (confirm('智能匹配到：\n' + label + '\n\n载入该集弹幕？')) {
              loadDandanplayComment(m.episodeId, label);
              putMatchCache(video, { episodeId: m.episodeId, animeTitle: m.animeTitle, episodeTitle: m.episodeTitle });
            } else ddpSetStatus('已取消');
          } else {
            ddpLastResults = {
              animes: [{
                animeId: 0, animeTitle: '匹配候选（' + matches.length + '）', type: '', startDate: null,
                episodes: matches.map(m => ({ episodeId: m.episodeId, episodeTitle: ((m.animeTitle ? m.animeTitle + ' ' : '') + (m.episodeTitle || '')), episodeNumber: '' })),
              }],
            };
            renderDdpEpisodes(ddpLastResults.animes[0]);
            ddpSetStatus('匹配到 ' + matches.length + ' 个候选，请选择');
          }
        } else {
          // 无可用文件名（流媒体/非 OpenList 站点）：用网页标题直接搜索
          ddpSetStatus('搜索中… ' + matchText.slice(0, 30), false, { loading: true });
          $('__ddp_kw__').value = matchText;
          doDdpSearch();
        }
      } catch (e) { ddpSetStatus('匹配失败: ' + e.message, true); }
    }

    function openDdpModal(prefillKw) {
      ddpModal.classList.add('open');
      ddpMask.classList.add('open');
      closeMenu();
      ddpCurrentAnime = null;
      $('__ddp_back__').style.display = 'none';
      if (prefillKw != null) $('__ddp_kw__').value = prefillKw;
      if (ddpLastResults) renderDdpAnimes(ddpLastResults);
      else { $('__ddp_list__').innerHTML = '<div class="ddp-empty">输入关键词后回车搜索</div>'; ddpSetStatus(''); }
      refreshAiMatchVisibility();  // 搜索弹窗内的「智能匹配」按钮按 AI 开关显隐
      setTimeout(() => $('__ddp_kw__').focus(), 60);
    }
    function closeDdpModal() {
      ddpModal.classList.remove('open');
      ddpMask.classList.remove('open');
    }

    // 全自动载入：页面加载时自动取标题→AI提取→搜索→单结果自动载入，全程零操作
    async function tryAutoMatch() {
      if (!autoMatchEnabled()) return;
      const title = getPageTitle();
      if (!title || title.length < 2) { showStatus('⚠️ 自动匹配：未获取到可用标题', 6000); return; }
      showStatus('⏳ 自动匹配中…', 0);  // 持续显示，直到结果出来
      try {
        const ext = await llmExtractFileName(title);
        if (!ext || !ext.title) { showStatus('⚠️ 自动匹配：AI 未能从标题提取番剧信息（' + title.slice(0,30) + '…）', 6000); return; }
        const res = await ddpSearchEpisodes(ext.title, ext.episode);
        const animes = (res && res.animes) || [];
        const single = animes.length === 1 && animes[0].episodes && animes[0].episodes.length === 1;
        if (!single) {
          if (animes.length > 1) showStatus('⚠️ 自动匹配：搜索到 ' + animes.length + ' 部作品（' + ext.title + '），无法自动选定，请手动搜索', 8000);
          else showStatus('⚠️ 自动匹配：未搜到「' + ext.title + (ext.episode ? ' 第' + ext.episode + '集' : '') + '」，请手动搜索', 8000);
          return;
        }
        const a = animes[0]; const e = a.episodes[0];
        const label = (a.animeTitle || '') + ' ' + (e.episodeTitle || ('第' + (e.episodeNumber || 1) + '集'));
        let comments;
        try { comments = (await ddpGetComment(e.episodeId)).comments || []; }
        catch (err) { showStatus('⚠️ 自动匹配：拉取弹幕失败（' + err.message + '）', 8000); return; }
        const rawList = ddpCommentsToList(comments);
        if (!rawList.length) { showStatus('⚠️ 自动匹配：' + label + ' 该集暂无弹幕', 6000); return; }
        applyDanmakuList(rawList, label, { seekTo: video.currentTime || 0 });
        putMatchCache(video, { episodeId: e.episodeId, animeTitle: a.animeTitle, episodeTitle: e.episodeTitle });
        showStatus('🎬 自动载入: ' + label + ' · ' + rawList.length + ' 条');
      } catch (e) { showStatus('⚠️ 自动匹配失败: ' + (e && e.message ? e.message : e), 8000); }
    }
    // 注册到 engine 上，供 tryInit 在 autoLoad 后调用
    engine.__titanAutoMatch = tryAutoMatch;

    $('__ddp_close__').addEventListener('click', closeDdpModal);
    ddpMask.addEventListener('click', closeDdpModal);
    $('__ddp_back__').addEventListener('click', () => {
      ddpCurrentAnime = null;
      $('__ddp_back__').style.display = 'none';
      if (ddpLastResults) renderDdpAnimes(ddpLastResults);
      ddpSetStatus(ddpLastResults ? ('找到 ' + (((ddpLastResults && ddpLastResults.animes) || []).length) + ' 部作品') : '');
    });
    $('__ddp_go__').addEventListener('click', doDdpSearch);
    $('__ddp_kw__').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doDdpSearch(); } });
    $('__ddp_match2__').addEventListener('click', doDdpMatch);
    // Esc 关弹弹play 弹窗（onKey 仅菜单打开时注册，模态弹窗各自接管；挂在 modal 上，焦点在弹窗内时生效）
    ddpModal.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeDdpModal(); } });

    // 弹幕数据缓存（autoLoad 已存到 window.__titanLastDmList，这里读全局）
    // 通用「把一段 rawList 载入引擎」管线：reload / 本地文件 / 弹弹play 远程拉取 都走它，
    // 保证三者行为一致：过滤 → 清 DOM → clear 渲染池 → reset 调度池 → 分块 addList → seek 对齐 → 对齐播放态 → 缓存原始 list → 提示。
    // opts.seekTo：传则 engine.seek 到该时间（保留位置/从 0 开始）；不传则不 seek。
    // opts.startPlayback：true 走 startPlayback（手动载入有用户手势，video.play 易放行）；否则 alignPlayback。
    function applyDanmakuList(rawList, label, opts) {
      opts = opts || {};
      const filtered = filterDmList(rawList, engine.config.setting);
      const rl = document.getElementById('__titan_roll_layer__');
      if (rl) rl.innerHTML = '';          // 1) 清空 DOM（保留 rollLayer 容器）
      engine.clear();                     // 2) clear 清渲染池
      engine.reset();                     // 3) reset 清调度池（消除旧条目残留，避免重载重复）
      for (let i = 0; i < filtered.length; i += 150) {  // 4) 分块 addList（大列表分批，与 reload/file 一致）
        engine.addList(filtered.slice(i, i + 150));
      }
      if (opts.seekTo != null) { try { engine.seek(opts.seekTo); } catch (e) {} }  // 5) 恢复内部时间
      if (opts.startPlayback) startPlayback(engine, video); else alignPlayback(engine, video);  // 6) 播放态
      window.__titanLastDmList = rawList;  // 7) 缓存**原始**list（过滤立即生效时重新过滤）
      setStatus('✓ ' + label + ' · ' + filtered.length + ' / ' + rawList.length + ' 条');
      return filtered.length;
    }

    // 重载弹幕：保留 video.currentTime（不重置 video），但**必须**彻底清空旧数据
    // 之前只 engine.clear() 一次不够 —— 调度池残留导致重载后大量重复弹幕
    // engine.clear() 只清渲染池，**不**清调度池 —— 多次 reload 会导致调度池累积、弹幕重复，
    // 且旧过滤的条目残留在调度池里、toggle off 过滤后"回不到初始值"
    // → 必须 engine.reset() 彻底清空调度池 + engine.seek(curT) 恢复时间
    // 重载弹幕：engine.reset() 清不干净调度池（重载后弹幕重复/过滤回不去），
    // 改为刷新页面彻底重建引擎。刷新前把播放位置+弹幕数据存 GM，刷新后自动恢复。
    function reloadDanmakuPreserveTime() {
      const rawList = window.__titanLastDmList;
      if (!rawList || !rawList.length) { setStatus('尚无弹幕可重载（请先载入）'); return; }
      // 存恢复数据：位置 + 弹幕原始数据 + 标签（供刷新后载入提示）
      saveResume({
        currentTime: video.currentTime || 0,
        rawList: rawList,
        label: '重载',
        ts: Date.now(),
      });
      setStatus('⏳ 正在刷新以应用过滤…');
      // 用 history 滚动位置 hash 触发刷新，保留 SPA 路由（部分站点 pushState 会丢，兜底 location.reload）
      try { location.reload(); } catch (e) { /* 极少数情况 reload 失败，静默 */ }
    }

    // 全局唯一的隐藏 file input
    if (!$('__titan_file_input__')) {
      const fi = document.createElement('input');
      fi.id = '__titan_file_input__';
      fi.type = 'file';
      fi.accept = '.xml,.json,.jsonl,.ndjson,.csv,.txt';
      fi.style.cssText = 'display:none';
      document.body.appendChild(fi);
      fi.addEventListener('change', (e) => {
        const f = e.target.files[0];
        if (!f) return;
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const rawList = parseAny(reader.result, f.name);
            // 复用通用管线：手动载入重置视频到 0、startPlayback（用户手势易放行）
            video.currentTime = 0;
            applyDanmakuList(rawList, f.name, { seekTo: 0, startPlayback: true });
          } catch (err) { setStatus('解析失败: ' + err.message); }
        };
        reader.readAsText(f);
        fi.value = '';
      });
    }

    // engine → UI
    function syncUI() {
      const s = engine.config && engine.config.setting;
      if (!s) return;
      $('__dm_switch__').classList.toggle('on', !!s.visible);
      btn.classList.toggle('off', !s.visible);
      $('__dm_font__').value = Math.round((s.fontSize || 1) * 100);
      $('__dm_fontv__').textContent = (s.fontSize || 1).toFixed(1) + '×';
      $('__dm_op__').value = Math.round((s.opacity || 0.85) * 100);
      $('__dm_opv__').textContent = Math.round((s.opacity || 0.85) * 100) + '%';
      $('__dm_area__').value = s.area || 100;
      $('__dm_areav__').textContent = (s.area || 100) >= 100 ? '满屏' : (s.area + '%');
      $('__dm_speed__').value = Math.round((s.speedPlus || 1) * 100);
      $('__dm_speedv__').textContent = (s.speedPlus || 1).toFixed(2) + '×';
      $('__dm_dens__').value = Math.round((s.density || 1) * 100);
      $('__dm_densv__').textContent = (s.density || 1).toFixed(1);
      $('__dm_dur__').value = Math.round((s.duration || 4.5) * 10);
      $('__dm_durv__').textContent = (s.duration || 4.5).toFixed(1) + 's';
      $('__dm_limit__').value = s.limit || 300;
      $('__dm_sync__').checked = !!s.speedSync;
      $('__dm_bold__').checked = !!s.bold;
      $('__dm_border__').checked = !!s.fontBorder;
      $('__dm_shade__').checked = !!s.preventShade;
      // Page 2 高级
      $('__dm_fssync__').checked = !!s.fullScreenSync;
      $('__dm_offtop__').value = s.offsetTop || 0;
      $('__dm_offbot__').value = s.offsetBottom || 0;
      $('__dm_maxlen__').value = s.maxLength || 50;
      const blk = s.noDanmakuXTypes || [];
      // 优先从我们存的数字列表读（精确匹配 mode 数字），**不**做 fallback
      // （之前 fallback 把 [1,4,5,6] 全推，导致持久化里只有 noDanmakuXTypes 没有 __numBlk 时菜单全勾选）
      const numBlk = s.__numBlk || [];
      // 勾选 = 屏蔽（直白语义）
      $('__dm_blk_1__').checked = numBlk.includes(1);
      $('__dm_blk_4__').checked = numBlk.includes(4);
      $('__dm_blk_5__').checked = numBlk.includes(5);
      $('__dm_blk_6__').checked = numBlk.includes(6);
      const bl = s.blockList || [];
      $('__dm_blocklist__').value = Array.isArray(bl) ? bl.join('\n') : '';
      $('__dm_recdom__').checked = !!s.isRecyclingDom;
      $('__dm_recmdl__').checked = !!s.isRecyclingModel;
      $('__dm_bindmove__').checked = !!s.canBindMove;
      $('__dm_shrink__').checked = !!s.forbidShrinkState;
    }

    function setStatus(txt) {
      menu.querySelectorAll('.dm-status').forEach(el => {
        el.textContent = txt;
        clearTimeout(el.__t);
        el.__t = setTimeout(() => { el.textContent = ''; }, 4000);
      });
    }

    // UI → engine 绑定
    $('__dm_switch__').addEventListener('click', () => {
      const v = !engine.config.setting.visible;
      engine.setSetting('visible', v);
      $('__dm_switch__').classList.toggle('on', v);
      btn.classList.toggle('off', !v);
    });
    $('__dm_font__').addEventListener('input', e => { const v = +e.target.value; $('__dm_fontv__').textContent = (v/100).toFixed(1) + '×'; engine.setSetting('fontSize', v/100); });
    $('__dm_op__').addEventListener('input', e => { const v = +e.target.value; $('__dm_opv__').textContent = v + '%'; engine.setSetting('opacity', v/100); });
    $('__dm_area__').addEventListener('input', e => { const v = +e.target.value; $('__dm_areav__').textContent = v >= 100 ? '满屏' : v + '%'; engine.setSetting('area', v); });
    $('__dm_speed__').addEventListener('input', e => { const v = +e.target.value; $('__dm_speedv__').textContent = (v/100).toFixed(2) + '×'; engine.setSetting('speedPlus', v/100); });
    $('__dm_dens__').addEventListener('input', e => { const v = +e.target.value; $('__dm_densv__').textContent = (v/100).toFixed(1); engine.setSetting('density', v/100); });
    $('__dm_dur__').addEventListener('input', e => { const v = +e.target.value; $('__dm_durv__').textContent = (v/10).toFixed(1) + 's'; engine.setSetting('duration', v/10); });
    $('__dm_limit__').addEventListener('change', e => { engine.setSetting('limit', +e.target.value || 0); });
    $('__dm_sync__').addEventListener('change', e => { engine.setSetting('speedSync', e.target.checked); });
    $('__dm_bold__').addEventListener('change', e => { engine.setSetting('bold', e.target.checked); });
    $('__dm_border__').addEventListener('change', e => { engine.setSetting('fontBorder', e.target.checked ? 1 : 0); });
    $('__dm_shade__').addEventListener('change', e => { engine.setSetting('preventShade', e.target.checked); });
    // Page 2 高级
    $('__dm_fssync__').addEventListener('change', e => { engine.setSetting('fullScreenSync', e.target.checked); });
    $('__dm_offtop__').addEventListener('change', e => { engine.setSetting('offsetTop', +e.target.value || 0); });
    $('__dm_offbot__').addEventListener('change', e => { engine.setSetting('offsetBottom', +e.target.value || 0); });
    $('__dm_maxlen__').addEventListener('change', e => { engine.setSetting('maxLength', +e.target.value || 0); });
    // 屏蔽类型的 change 在下方统一绑定（带 reloadDanmakuPreserveTime）
    $('__dm_blocklist__').addEventListener('input', e => {
      // 实时解析（不持久化）让 filter 看到最新词，但需点保存才重载
      const arr = e.target.value.split('\n').map(s => s.trim()).filter(Boolean);
      engine.config.setting.blockList = arr;  // 直接写（不让 setSetting 持久化半成品）
    });
    $('__dm_save_blocklist__').addEventListener('click', () => {
      const arr = $('__dm_blocklist__').value.split('\n').map(s => s.trim()).filter(Boolean);
      engine.setSetting('blockList', arr);  // 持久化 + 触发重载
      reloadDanmakuPreserveTime();
    });
    // 屏蔽类型 change：自动立即重载（用户要求）
    // 注意：原版 Titan 引擎的 noDanmakuXTypes 接受**字符串类别**（"common"/"interact"/"special"），
    // 但源码证实 mode 1/4/5/6（滚动/底/顶/逆向）**全归 "common"**（M[g] 都为 true）—— 勾任何一个就屏蔽全部 common
    // → 放弃 setSetting('noDanmakuXTypes')，**完全**用 fn.filter 数字 mode 精确过滤
    ['blk_1','blk_4','blk_5','blk_6'].forEach(k => $('__dm_' + k + '__').addEventListener('change', () => {
      // 勾选 = 屏蔽
      const numBlk = [];
      if ($('__dm_blk_1__').checked) numBlk.push(1);  // 滚动
      if ($('__dm_blk_4__').checked) numBlk.push(4);  // 底
      if ($('__dm_blk_5__').checked) numBlk.push(5);  // 顶
      if ($('__dm_blk_6__').checked) numBlk.push(6);  // 逆向
      // fn.filter 通过 __numBlk 字段查（精确按 mode 数字匹配）
      engine.config.setting.__numBlk = numBlk;
      // 显式设空 noDanmakuXTypes（避免之前 ["common"] 误屏蔽全部）
      engine.setSetting('noDanmakuXTypes', []);
      reloadDanmakuPreserveTime();
    }));
    $('__dm_recdom__').addEventListener('change', e => { engine.setSetting('isRecyclingDom', e.target.checked); });
    $('__dm_recmdl__').addEventListener('change', e => { engine.setSetting('isRecyclingModel', e.target.checked); });
    $('__dm_bindmove__').addEventListener('change', e => { engine.setSetting('canBindMove', e.target.checked); });
    $('__dm_shrink__').addEventListener('change', e => { engine.setSetting('forbidShrinkState', e.target.checked); });
    // 页面切换
    menu.addEventListener('click', e => {
      const btn = e.target.closest('[data-go-page]');
      if (!btn) return;
      const p = btn.getAttribute('data-go-page');
      menu.querySelectorAll('.dm-page').forEach(d => d.classList.toggle('active', d.dataset.page === p));
    });
    $('__dm_load_file__').addEventListener('click', () => $('__titan_file_input__').click());
    $('__dm_open_settings__').addEventListener('click', () => {
      // 关菜单，开通用设置弹窗
      closeMenu();
      openSettingsModal();
    });
    // 主题切换：auto → light → dark → auto（手动切换会持久化，覆盖自动检测）
    $('__dm_toggle_theme__').addEventListener('click', () => {
      const t = loadTheme();
      let next;
      if (t === 'auto') next = effectiveTheme() === 'light' ? 'dark' : 'light';  // auto 时：切到"另一个"
      else if (t === 'light') next = 'dark';
      else next = 'auto';
      saveTheme(next);
      applyTheme();
      // 更新按钮文案
      const eff = effectiveTheme();
      const label = next === 'auto' ? ('🌓 自动（当前' + (eff === 'light' ? '亮' : '暗') + '）') : (eff === 'light' ? '🌙 亮色（点击切暗）' : '🌑 暗色（点击切自动）');
      $('__dm_toggle_theme__').textContent = label;
    });
    // 弹弹play 搜索 / 匹配 菜单按钮（未配置代理时引导去设置）
    $('__dm_ddp_search__').addEventListener('click', () => {
      if (!ddpReady()) { closeMenu(); openSettingsModal(); return; }
      openDdpModal();
    });
    $('__dm_ddp_match__').addEventListener('click', () => {
      if (!ddpReady()) { closeMenu(); openSettingsModal(); return; }
      openDdpModal();
      doDdpMatch();
    });
    // 弹弹play 代理配置保存（留空字段会回退到内置默认值 ddplay.retr0.xyz）
    $('__dm_ddp_save__').addEventListener('click', () => {
      saveDdpConfig({
        workerUrl: $('__dm_ddp_url__').value.trim(),
        proxyToken: $('__dm_ddp_token__').value.trim(),
      });
      alert(ddpReady() ? ('弹弹play 代理配置已保存 ✓\n当前生效 Worker：' + ddpWorkerUrl()) : '已保存，但 Worker URL 仍为空，功能不可用。');
    });
    // 清空匹配缓存
    $('__dm_ddp_clear_match__').addEventListener('click', () => {
      if (confirm('清空所有「智能匹配」的历史记录？下次匹配会重新请求弹弹play。（不影响已加载的弹幕）')) {
        clearMatchCache();
        alert('已清空匹配缓存。');
      }
    });
    // AI 开关切换：保存 enabled 字段 + 实时刷新两个「智能匹配」按钮的显隐
    function refreshAiMatchVisibility() {
      const show = aiMatchVisible();
      const m1 = $('__dm_ddp_match__'); if (m1) m1.style.display = show ? '' : 'none';
      const m2 = $('__ddp_match2__'); if (m2) m2.style.display = show ? '' : 'none';
      // 开关 UI 同步
      const sw = $('__dm_ai_switch__'); if (sw) sw.classList.toggle('on', aiEnabled());
      const am = $('__dm_auto_match__'); if (am) am.classList.toggle('on', autoMatchEnabled());
    }
    $('__dm_ai_switch__').addEventListener('click', () => {
      const cfg = loadAiConfig();
      cfg.enabled = !cfg.enabled;
      saveAiConfig(cfg);
      refreshAiMatchVisibility();
    });
    // 全自动载入开关
    $('__dm_auto_match__').addEventListener('click', () => {
      const cfg = loadAiConfig();
      cfg.autoMatch = !cfg.autoMatch;
      saveAiConfig(cfg);
      refreshAiMatchVisibility();
    });
    // AI 配置保存（保留开关状态）
    $('__dm_ai_save__').addEventListener('click', () => {
      const old = loadAiConfig();
      saveAiConfig({
        enabled: !!old.enabled,
        autoMatch: !!old.autoMatch,
        baseUrl: $('__dm_ai_url__').value.trim(),
        apiKey: $('__dm_ai_key__').value.trim(),
        model: $('__dm_ai_model__').value.trim(),
      });
      refreshAiMatchVisibility();
      const cfg = loadAiConfig();
      if (!cfg.enabled) alert('AI 配置已保存 ✓\n但「启用 AI」开关未开，「智能匹配」按钮不显示。请先打开开关。');
      else if (aiReady()) alert('AI 配置已保存 ✓ 且可用 ✓\n模型：' + cfg.model + '\n现在「✨ 智能匹配」按钮会显示。');
      else alert('已保存，但 API 地址/模型为空，AI 不可用。请补全后重试。');
    });
    // 简繁转换：下拉改即存（弹弹play comment 接口的 chConvert 参数）
    $('__dm_chconvert__').addEventListener('change', () => {
      const v = parseInt($('__dm_chconvert__').value, 10);
      const s = loadSettings();
      s.ddpChConvert = (v >= 0 && v <= 2) ? v : 1;
      saveSettings(s);
    });

    // 通用设置弹窗：open / close
    function openSettingsModal() {
      settingsModal.classList.add('open');
      settingsMask.classList.add('open');
      // 同步弹弹play 代理配置：显示用户自定义值（留空则回退默认，故输入框留空 + placeholder 提示默认）
      const cfg = loadDdpConfig();
      $('__dm_ddp_url__').value = cfg.workerUrl || '';
      $('__dm_ddp_token__').value = cfg.proxyToken != null ? cfg.proxyToken : '';
      // 同步简繁转换
      const ch = loadSettings().ddpChConvert;
      $('__dm_chconvert__').value = (ch != null && ch >= 0 && ch <= 2) ? String(ch) : '1';
      // 同步 AI 配置 + 开关
      const ai = loadAiConfig();
      $('__dm_ai_url__').value = ai.baseUrl || '';
      $('__dm_ai_key__').value = ai.apiKey || '';
      $('__dm_ai_model__').value = ai.model || '';
      $('__dm_ai_switch__').classList.toggle('on', !!ai.enabled);
      $('__dm_auto_match__').classList.toggle('on', !!ai.autoMatch);
    }
    function closeSettingsModal() {
      settingsModal.classList.remove('open');
      settingsMask.classList.remove('open');
    }
    $('__dm_close_settings__').addEventListener('click', closeSettingsModal);
    settingsMask.addEventListener('click', closeSettingsModal);
    // 弹窗内按钮
    $('__dm_reset_all__').addEventListener('click', () => {
      if (confirm('确定要清空所有设置？此操作不可撤销。（含弹幕样式设置、弹弹play 代理配置、匹配缓存、AI 配置）')) {
        [STORAGE_KEY, DDP_KEY, MATCH_CACHE_KEY, AI_KEY, RESUME_KEY].forEach(k => { try { GM_deleteValue(k); } catch (e) {} });
        alert('已清空。刷新页面后生效。');
      }
    });
    $('__dm_export__').addEventListener('click', () => {
      const data = {
        settings: loadSettings(),
        ddp: loadDdpConfig(),
        ai: loadAiConfig(),
        matchCache: loadMatchCache(),
      };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'web-danmaku-plugin-backup.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    $('__dm_import__').addEventListener('click', () => $('__dm_import_file').click());
    $('__dm_import_file').addEventListener('change', (e) => {
      const f = e.target.files[0]; if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const obj = JSON.parse(reader.result);
          if (obj.settings) saveSettings(obj.settings);
          if (obj.ddp) saveDdpConfig(obj.ddp);
          if (obj.ai) saveAiConfig(obj.ai);
          if (obj.matchCache) saveMatchCache(obj.matchCache);
          // 兼容旧格式（导出的是裸 settings 对象而不是包装的）
          if (!obj.settings && !obj.ddp && !obj.ai && !obj.matchCache) saveSettings(obj);
          alert('导入成功！' + (obj.settings ? '弹幕设置 + 代理 + AI + 匹配缓存已恢复' : '弹幕设置已恢复'));
        } catch (err) { alert('导入失败：' + err.message); }
        e.target.value = '';
      };
      reader.readAsText(f);
    });

    // 打开/关闭
    let menuOpen = false;
    // 点击不在 #__titan_dm_btn__ 和 #__titan_dm_menu__ 容器内才关闭
    // （菜单挂到 document.body 而非 btn，所以必须同时检查两个容器）
    const onDocClick = (e) => { if (!e.target.closest('#__titan_dm_btn__, #__titan_dm_menu__')) closeMenu(); };
    // Esc 关弹窗（优先）或菜单（onKey 仅在菜单打开期间注册）
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (settingsModal.classList.contains('open')) closeSettingsModal();
      else if (menuOpen) closeMenu();
    };
    const positionMenu = positionMenuGlobal;  // 用全局版本（fullscreenchange 监听需要访问）
    const onWinResize = () => { if (menuOpen) positionMenuGlobal(); };
    function openMenu() {
      syncUI();
      // 同步主题按钮文案（auto/light/dark + 当前实际生效）
      const t = loadTheme();
      const eff = effectiveTheme();
      const label = t === 'auto' ? ('🌓 自动（当前' + (eff === 'light' ? '亮' : '暗') + '）') : (eff === 'light' ? '🌙 亮色（点击切暗）' : '🌑 暗色（点击切自动）');
      const tb = $('__dm_toggle_theme__'); if (tb) tb.textContent = label;
      refreshAiMatchVisibility();  // 按 AI 开关显隐菜单里的「智能匹配」按钮
      positionMenuGlobal();
      menu.classList.add('open');
      menuOpen = true;
      setTimeout(() => document.addEventListener('click', onDocClick), 0);
      document.addEventListener('keydown', onKey);
      window.addEventListener('resize', onWinResize);
      window.addEventListener('scroll', onWinResize, true);
    }
    function closeMenu() {
      menu.classList.remove('open');
      menuOpen = false;
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onWinResize);
      window.removeEventListener('scroll', onWinResize, true);
    }
    btn.addEventListener('click', (e) => { e.stopPropagation(); if (menuOpen) closeMenu(); else openMenu(); });
    // 菜单标题栏右上角 [×] 关闭按钮（stopPropagation 避免 onDocClick 误判）
    const mc = $('__dm_menu_close__');
    if (mc) mc.addEventListener('click', (e) => { e.stopPropagation(); closeMenu(); });

    // 初始化按钮可见态
    btn.classList.toggle('off', !engine.config.setting.visible);

    // 暴露 setStatus 给 console 调试
    if (window.__titan) window.__titan.setStatus = setStatus;
  }

  // 右下角状态提示。durationMs=0 表示不自动消失（持续显示直到下次调用覆盖）。
  function showStatus(msg, durationMs) {
    let el = document.getElementById('__titan_status__');
    if (!el) {
      el = document.createElement('div');
      el.id = '__titan_status__';
      el.style.cssText = 'position:fixed;right:24px;bottom:80px;background:rgba(0,0,0,0.85);color:#9cf;font-size:12px;padding:6px 10px;border-radius:4px;z-index:2147483646;font-family:Menlo,monospace;max-width:400px;word-break:break-all;pointer-events:none';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.display = 'block';
    clearTimeout(el.__t);
    if (durationMs == null) durationMs = 4000;
    if (durationMs > 0) el.__t = setTimeout(() => { el.style.display = 'none'; }, durationMs);
  }

  // ============= 主流程：MutationObserver 监听 video 出现 =============
  let activeEngine = null;

  // 清理当前活跃引擎 + 所有 UI 元素（换集/PJAX 导航时调用）
  function cleanupEngine() {
    if (activeEngine) {
      try { activeEngine.__titanCleanup(); } catch (e) {}
      activeEngine = null;
    }
    ['__titan_dm_btn__','__titan_dm_menu__','__titan_dm_settings','__titan_dm_modal_mask','__titan_dm_ddp_search','__titan_dm_ddp_mask','__titan_roll_layer__','__titan_cmd_layer__','__titan_status__']
      .forEach(id => { const e = document.getElementById(id); if (e) e.remove(); });
  }

  function watchVideo() {
    const tryInit = async (video) => {
      if (video.__titanBound) return;
      // 如果已有活跃引擎（上一个视频），先清理
      cleanupEngine();
      video.__titanBound = true;
      try {
        const adapter = createAdapter(video);
        const engine = await getEngine(video, adapter);
        engine.__titanAdapter = adapter;
        activeEngine = engine;
        if (window.__titan) { window.__titan.engine = engine; window.__titan.adapter = adapter; }
        injectDanmakuControls(engine, video, adapter);
        // 刷新恢复：屏蔽/过滤重载时存的 rawList + 位置 → 直接恢复，跳过 autoLoad/autoMatch
        const resume = loadResume();
        const isFresh = resume.ts && (Date.now() - resume.ts < 60000);  // 60s 内才算有效恢复
        if (isFresh && resume.rawList && resume.rawList.length) {
          try {
            const ct = resume.currentTime || 0;
            // 内联载入逻辑（applyDanmakuList 在 injectDanmakuControls 闭包内，这里跨闭包调不到，
            //   直接用 tryInit 闭包的 engine/video + 模块级 filterDmList/startPlayback）
            const filtered = filterDmList(resume.rawList, engine.config.setting);
            const rl = document.getElementById('__titan_roll_layer__');
            if (rl) rl.innerHTML = '';
            engine.clear(); engine.reset();
            for (let i = 0; i < filtered.length; i += 150) engine.addList(filtered.slice(i, i + 150));
            try { engine.seek(ct); } catch (e) {}
            window.__titanLastDmList = resume.rawList;  // 缓存原始 list（供再次重载）
            alignPlayback(engine, video);
            // 恢复视频播放位置：等 loadedmetadata 再设（刷新后视频可能还在加载）
            const seekVideo = () => { try { video.currentTime = ct; } catch (e) {} };
            if (video.readyState >= 1) seekVideo();
            else video.addEventListener('loadedmetadata', seekVideo, { once: true });
            showStatus('✓ 已恢复弹幕与播放位置（' + ct.toFixed(0) + 's）');
          } catch (e) { showStatus('⚠️ 恢复失败: ' + e.message); }
          clearResume();
        } else {
          await autoLoad(engine, video, adapter);
          // 全自动载入：同目录弹幕没命中时才走远程 AI 匹配
          if (!window.__titanLastDmList && engine.__titanAutoMatch) {
            engine.__titanAutoMatch();
          }
          if (resume.ts) clearResume();  // 清掉过期恢复标记
        }
      } catch (e) {
        console.error('[web-danmaku-plugin] init failed:', e);
        showStatus('Titan 初始化失败: ' + e.message);
      }
    };

    // 扫描页面所有未绑定的 <video>，逐个 init。
    // retries：SPA 页面 video 可能是异步创建的（如 ArtPlayer 动态挂载），
    //   没扫到就每隔 300ms 重试，最多 5 次（1.5s 窗口覆盖异步初始化）。
    const scanVideos = (retries) => {
      let found = false;
      document.querySelectorAll('video').forEach(v => {
        if (!v.__titanBound && (v.currentSrc || v.src)) { tryInit(v); found = true; }
      });
      if (!found && (retries == null || retries > 0)) {
        setTimeout(() => scanVideos((retries != null ? retries : 5) - 1), 300);
      }
    };

    // 初始扫描（带重试）
    scanVideos(5);

    // ① body DOM 变化（新 video 插入 + src 属性变化 = 覆盖 OpenList 同元素换源情况）
    const bodyObs = new MutationObserver((mutations) => {
      let hasNewVideo = false, hasSrcChange = false;
      for (const m of mutations) {
        if (m.type === 'childList' && m.addedNodes.length) hasNewVideo = true;
        if (m.type === 'attributes' && m.target.tagName === 'VIDEO' && m.attributeName === 'src') {
          m.target.__titanBound = false; hasSrcChange = true;
        }
      }
      if (hasNewVideo) scanVideos(5);
      if (hasSrcChange) { cleanupEngine(); setTimeout(() => scanVideos(3), 300); }
    });
    bodyObs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
    // 兜底：video 的 loadstart 事件（覆盖 src 通过属性而非 DOM 属性设置的情况，以及异步播放器初始化）
    document.addEventListener('loadstart', (e) => {
      const v = e.target;
      if (v && v.tagName === 'VIDEO' && !v.__titanBound && (v.currentSrc || v.src)) {
        setTimeout(() => { if (!v.__titanBound) tryInit(v); }, 100);
      }
    }, true);

    // ② PJAX/AJAX 页面导航检测：监听顶层窗口 <title> 文本变化
    //    标题变化时清理旧引擎 + 清 __titanBound 标记 + 重新扫描。
    //    iframe 场景下取顶层窗口 title（脚本在 iframe 里运行时 document.title 是 iframe 自己的）。
    let topWin, topDoc, titleEl;
    try { topWin = window.top || window; topDoc = (topWin !== window) ? topWin.document : document; }
    catch (e) { topWin = window; topDoc = document; }
    let lastTitle = topDoc.title || '';
    titleEl = topDoc.querySelector('title');
    if (titleEl) {
      const titleObs = new MutationObserver(() => {
        if (topDoc.title !== lastTitle) {
          lastTitle = topDoc.title;
          document.querySelectorAll('video').forEach(v => { v.__titanBound = false; });
          cleanupEngine();
          setTimeout(() => scanVideos(5), 200);
        }
      });
      titleObs.observe(titleEl, { childList: true, characterData: true, subtree: true });
    }
    // ③ history API 导航兜底（popstate，监听顶层窗口。部分 PJAX 框架用）
    topWin.addEventListener('popstate', () => {
      document.querySelectorAll('video').forEach(v => { v.__titanBound = false; });
      cleanupEngine();
      setTimeout(() => scanVideos(5), 300);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', watchVideo);
  } else {
    watchVideo();
  }

  // 暴露核心函数供 dev/test 端到端验证（生产环境无害，单一命名空间）
  window.__titan = { injectControls: injectDanmakuControls, getEngine, createAdapter, parseAny, parseDandanplayApi, ddpCommentsToList, filePathFromVideo, getPageTitle, loadDdpConfig, saveDdpConfig, ddpSearchEpisodes, ddpGetComment, ddpMatch, loadMatchCache, saveMatchCache, getMatchCache, putMatchCache, clearMatchCache, matchCacheKeyOf, loadAiConfig, saveAiConfig, aiReady, aiEnabled, autoMatchEnabled, llmExtractFileName, loadResume, saveResume, clearResume, pageTitleSnapshot: _PAGE_TITLE_SNAPSHOT, engine: null, adapter: null, setStatus: null };
})();
