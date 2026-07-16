// ==UserScript==
// @name         今天要来点弹幕吗？
// @version      1.2.1
// @description  在任意网页视频上加载 B 站网页版同款弹幕引擎（Titan）；OpenList 同目录自动载入 / 本地手动载入 / 弹弹play 在线搜索+智能匹配（支持 AI 增强全自动载入）；
// @author       Retr0
// @match        *://*/*
// @include      http://*:5244/*
// @include      https://*:5244/*
// 注：@match *://*/* 匹配所有网页；脚本在任意带 <video> 的页面激活，由 createAdapter 按站点/播放器分流
// （OpenList:5244/localhost 自动识别为特例；@include 5244 仅为兼容旧油猴版本的显式声明，可省）
// @require      https://cdn.jsdelivr.net/gh/makabaka11/web-danmaku-plugin@master/dist/titan-bundle.js
// @icon         https://www.bilibili.com/favicon.ico
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
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
 *     - 字号 / 不透明度 / 区域 / 速度 / 密度 / 时长 / 上限
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
      '__titan_roll_layer__', '__titan_cmd_layer__', '__titan_rotate_layer__', '__titan_dm_btn__',
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

  // ============= 引擎 bundle 回退加载 ============
  // @require 主源（jsdelivr）若因网络/地区拉取失败，运行时按序动态注入备用源。
  // 注：多个 @require 会被油猴全部加载（非回退、可能重复初始化 webpack），故用运行时回退。
  const BUNDLE_URLS = [
    'https://cdn.jsdelivr.net/gh/makabaka11/web-danmaku-plugin@master/dist/titan-bundle.js',
    'https://gitee.com/ded_retr0/web-danmaku-plugin/raw/master/dist/titan-bundle.js',
  ];
  let _bundleEnsured = null;
  function ensureBundle() {
    if (_bundleEnsured) return _bundleEnsured;
    _bundleEnsured = (async () => {
      if (window.nanoWidgetsJsonp) return true;
      for (const url of BUNDLE_URLS) {
        try {
          await new Promise((res, rej) => {
            const s = document.createElement('script');
            s.src = url;
            s.onload = res;
            s.onerror = rej;
            document.head.appendChild(s);
            setTimeout(rej, 12000);  // 单源 12s 超时
          });
          // 等待 bundle 初始化 nanoWidgetsJsonp
          for (let i = 0; i < 30; i++) {
            if (window.nanoWidgetsJsonp) return true;
            await new Promise(r => setTimeout(r, 100));
          }
        } catch (e) { /* 该源失败，试下一个 */ }
      }
      return false;
    })();
    return _bundleEnsured;
  }

  // ============= 拿到 Titan 引擎 =============
  async function getEngine(video, adapter) {
    if (!window.nanoWidgetsJsonp) {
      // @require 主源可能未加载（网络/地区），运行时回退到备用源
      const ok = await ensureBundle();
      if (!ok) throw new Error('titan-bundle 加载失败（jsdelivr/gitee 均不可达）');
    }
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
    // rotateDom：引擎内部会访问 dom.rotateDom（旋转弹幕层），缺失会导致引擎内部 null.addEventListener
    const rotateDom = document.createElement('div');
    rotateDom.id = '__titan_rotate_layer__';
    rotateDom.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;';
    artContainer.appendChild(rotateDom);

    // 读取持久化设置（videoSpeed 不持久化 —— 跟随每个视频自身的 playbackRate，否则跨视频会出现错位）
    const { videoSpeed: _vs, ...saved } = loadSettings();
    const engine = new Engine({
      id: 'web-danmaku-plugin',
      container: rollLayer,
      dom: { insideWrap: cmdWrap, rotateDom: rotateDom },
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
      try { rotateDom.remove(); } catch (e) {}
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
    window.__titanLastDmList = null;  // 清陈旧数据（上一个视频留下的），避免误判"已载入"跳过自动匹配
    const hit = await adapter.findDanmaku(video);
    if (!hit) {
      // 仅在有自动载入源的站点（OpenList）提示"同目录无匹配"；通用站点无此概念，静默
      if (adapter instanceof OpenListArtPlayerAdapter) showStatus('同目录无弹幕文件（菜单 -> 手动载入）');
      return false;
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
      startPlayback(engine, video);
      return true;
    } catch (e) {
      showStatus('载入失败: ' + e.message);
      return false;
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
    '你是一个动漫视频文件名/网页标题解析助手。输入文本可能含字幕组、分辨率、编码、集号等杂质。请提取干净的番剧标题(title)和集号(episode)。\n' +
    '重要：区分「季度」与「集号」\n' +
    '- 季度信息（Season N / 第N季 / Nst Season / S2 / 2nd / II 等）属于 title 的一部分，绝不要当成 episode。例：Yuru Camp Season 3 中的 "Season 3" 是季度，episode 不是 3。\n' +
    '- episode 只取真正的集号标签，如 [01]、[12]、[OVA01]、[SP1]、[OAD1]。\n' +
    'episode 规则（务必遵守，匹配错误会加载错弹幕）：\n' +
    '- TV 正片：纯数字，去前导0。如 "1"、"12"；"01"->"1"。\n' +
    '- 剧场版/电影：填 "movie"。\n' +
    '- 特殊篇（SP/OVA/OAD/OP/ED 等）：保留类型前缀+数字，去前导0。如 "SP1"、"OVA1"；"OVA01"->"OVA1"。无数字只填前缀。\n' +
    '- 若没有明确集号标签（仅有季度或片名），episode 填 ""。\n' +
    '- 关键：SP1/OVA1/OAD1 是特殊篇不是第1集；Season 3 / S2 是季度不是第3/2集。\n' +
    '示例：\n' +
    '- "[Airota&VCB-Studio] Yuru Camp Season 3 [OVA01][Ma10p_1080p][x265_flac].mkv" -> {"title":"Yuru Camp Season 3","episode":"OVA1"}\n' +
    '- "[Sub] Anime S2 [05][1080p].mkv" -> {"title":"Anime S2","episode":"5"}\n' +
    '- "[Group] 番名 第二季 [SP2].mkv" -> {"title":"番名 第二季","episode":"SP2"}\n' +
    '只输出 JSON，不要解释：{"title":"...","episode":"..."}。title 用原始语言（中文/日文/英文，取主体名）。';

  // ============= 集号解析与特殊篇匹配 =============
  // 规范化 LLM 返回的 episode：前缀大写、数字去前导0；保留特殊篇前缀（SP/OVA/OAD…），不再粗暴去非数字
  function normalizeEpisode(ep) {
    ep = (ep == null ? '' : ep).toString().trim();
    if (!ep) return '';
    if (/movie/i.test(ep)) return 'movie';
    // 字母前缀（特殊篇）+ 可选分隔 + 可选数字
    let m = ep.match(/^([A-Za-z]+)[^0-9]*0*(\d*)$/);
    if (m && m[1] && !/^\d+$/.test(ep)) {
      return m[1].toUpperCase() + (m[2] !== '' ? String(parseInt(m[2], 10)) : '');
    }
    // 纯数字
    m = ep.match(/^0*(\d+)$/);
    if (m) return String(parseInt(m[1], 10));
    return ep;
  }
  // 把规范化 episode 解析为 {kind, prefix, num}：kind='main'|'movie'|'special'|'unknown'
  function parseWantEpisode(ep) {
    ep = (ep || '').trim();
    if (!ep) return { kind: 'unknown' };
    if (ep === 'movie') return { kind: 'movie' };
    const m = ep.match(/^([A-Za-z]+)(\d*)$/);
    if (m && m[1]) {
      let prefix = m[1].toUpperCase();
      if (prefix === 'SPECIAL' || prefix === 'S') prefix = 'SP';
      return { kind: 'special', prefix, num: m[2] ? parseInt(m[2], 10) : null };
    }
    const n = ep.match(/^(\d+)$/);
    if (n) return { kind: 'main', num: parseInt(n[1], 10) };
    return { kind: 'unknown', text: ep };
  }
  // 在某作品的剧集列表里按特殊篇定位最匹配的一集；返回 {ep, score} 或 null
  // score: 100=类型+集号完全匹配；50=仅类型匹配（未指定集号）；10=类型匹配但标题无数字
  function pickSpecialEpisode(episodes, want) {
    if (!episodes || !episodes.length || !want || want.kind !== 'special') return null;
    const prefix = want.prefix;
    const num = want.num;
    const isSp = (prefix === 'SP');
    const scored = [];
    for (const ep of episodes) {
      const title = ep.episodeTitle || '';
      const up = title.toUpperCase();
      if (/剧场版|劇場版|MOVIE/.test(up)) continue;  // 跳过剧场版
      // 类型匹配（SP 兼容 dandanplay 的 S1/S2 命名，以及 SPECIAL/特别篇/番外/特典）
      let typeOk = false;
      if (isSp) typeOk = /(^|[^A-Z])SP([^A-Z]|$)/.test(up) || /(^|[^A-Z])S\d+([^A-Z]|$)/.test(up) || up.includes('SPECIAL') || /特别篇|特別篇|番外|特典/.test(title);
      else typeOk = up.includes(prefix);
      if (!typeOk) continue;
      // 标题里的数字
      const nm = title.match(/(\d+)/);
      const epNum = nm ? parseInt(nm[1], 10) : null;
      if (num != null && epNum === num) scored.push({ ep, score: 100 });
      else if (num == null) scored.push({ ep, score: 50 });
      else if (epNum == null) scored.push({ ep, score: 10 });
      // 类型匹配但集号不同 -> 不选
    }
    if (!scored.length) return null;
    scored.sort((a, b) => b.score - a.score);
    return scored[0];
  }
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
      if (!r.ok) {
        // HTTP 错误：优先取 Worker/LLM 的 errorMessage，取不到用原文（可能是 "error code: 1003" 这种纯文本）
        let msg = '';
        try { const ej = JSON.parse(txt || '{}'); msg = ej.errorMessage || ej.error?.message || ej.message || ''; } catch (e) {}
        if (!msg) msg = (txt || '').slice(0, 200) || ('HTTP ' + r.status);
        throw new Error(msg + '（HTTP ' + r.status + '）');
      }
      // LLM 成功响应体：必须是 JSON（choices[].message.content）。非 JSON 时给清晰提示
      let j;
      try { j = JSON.parse(txt); } catch (e) {
        // Worker 透传了 LLM 的非 JSON 响应（如纯文本 "error code: 1003"）
        throw new Error('LLM 返回非 JSON 响应（' + (txt || '').slice(0, 120) + '），请检查模型/API 地址');
      }
      const content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (!content) return null;
      // 解析 LLM 输出（可能带 ```json 包裹或前后杂质）→ 提取 {...}
      const m = content.match(/\{[\s\S]*\}/);
      if (!m) return null;
      let parsed;
      try { parsed = JSON.parse(m[0]); } catch (e) { return null; }  // LLM 输出的 JSON 格式错误，视为提取失败
      const title = (parsed.title || '').trim();
      if (title.length < 2) return null;
      const episode = normalizeEpisode(parsed.episode || '');  // 保留特殊篇前缀（SP1/OVA1…），不再去非数字
      return { title, episode };
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
  // 拉取某作品的全部剧集（BangumiDetails.episodes，含 episodeNumber）-- 用于「获取全部剧集」
  async function ddpGetBangumi(animeId) {
    const obj = await ddpFetch('/api/v2/bangumi/' + encodeURIComponent(animeId));
    return (obj && obj.bangumi) || null;
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

  // ============= 全自动载入黑名单 =============
  // 部分网页不需要全自动载入（AI 提取标题搜番剧），按 URL 规则屏蔽。
  // 开关开启后：① 通用设置「配置管理」区显示「管理黑名单」入口；② 新站点首次触发全自动载入前
  //   弹窗询问是否加入；③ 命中规则的站点整体不注入弹幕（不显示图标/消息，watchVideo 直接返回）。
  const BLACKLIST_KEY = '__titan_dm_blacklist__';
  function loadBlacklist() {
    try {
      const o = JSON.parse(GM_getValue(BLACKLIST_KEY, '{}')) || {};
      if (!Array.isArray(o.patterns)) o.patterns = [];
      return o;
    } catch (e) { return { enabled: false, patterns: [] }; }
  }
  function saveBlacklist(o) {
    try { GM_setValue(BLACKLIST_KEY, JSON.stringify(o || { enabled: false, patterns: [] })); } catch (e) {}
  }
  function blacklistEnabled() { return !!loadBlacklist().enabled; }
  // 追加规则（去重）
  function addBlacklistPatterns(patterns) {
    if (!patterns || !patterns.length) return;
    const cfg = loadBlacklist();
    const set = new Set(cfg.patterns || []);
    patterns.forEach(p => { if (p) set.add(p); });
    cfg.patterns = Array.from(set);
    saveBlacklist(cfg);
  }

  // 已访问站点（按根域名记），用于「新站点」判定。仅黑名单开关开启后才记录/查询，
  // 故开关关闭期间访问的站点在首次开启后仍会被视作新站点（符合「从未打开过」的发现语义）。
  const SEEN_SITES_KEY = '__titan_dm_seen_sites__';
  function loadSeenSites() {
    try { const a = JSON.parse(GM_getValue(SEEN_SITES_KEY, '[]')); return Array.isArray(a) ? a : []; }
    catch (e) { return []; }
  }
  function saveSeenSites(arr) {
    try { GM_setValue(SEEN_SITES_KEY, JSON.stringify(arr || [])); } catch (e) {}
  }
  function markSiteSeen(root) {
    if (!root) return;
    const a = loadSeenSites();
    if (!a.includes(root)) { a.push(root); saveSeenSites(a); }
  }

  // 根域名（eTLD+1 近似）：无公共后缀表，用常见两段 TLD 启发表兜底。
  //   www.bilibili.com -> bilibili.com；a.b.example.co.uk -> example.co.uk；
  //   IP / localhost / IPv6 原样返回。
  const TWO_PART_TLDS = new Set([
    'co.uk','org.uk','ac.uk','gov.uk','co.jp','ne.jp','or.jp','ac.jp','com.cn','net.cn','org.cn','gov.cn','edu.cn',
    'com.hk','com.tw','com.au','net.au','org.au','co.nz','co.kr','com.br','com.mx','com.ar','co.in','org.in','net.in',
    'com.sg','com.my','com.ph','com.vn','com.tr','co.za','com.ua','com.pl','co.id'
  ]);
  function getRootDomain(hostname) {
    if (!hostname) return '';
    hostname = hostname.toLowerCase();
    if (hostname === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(hostname) || /^[0-9a-f:]+$/i.test(hostname)) return hostname;
    const parts = hostname.split('.');
    if (parts.length <= 2) return hostname;
    const last2 = parts.slice(-2).join('.');
    const last3 = parts.slice(-3).join('.');
    if (TWO_PART_TLDS.has(last2) && parts.length >= 3) return last3;
    if (TWO_PART_TLDS.has(last3) && parts.length >= 4) return parts.slice(-4).join('.');
    return last2;
  }

  // URL 规则 -> 正则：* 转 .*，其余字符转义；用 ^...$ 锚定整串。
  function patternToRegex(pattern) {
    if (!pattern) return null;
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    try { return new RegExp('^(?:' + escaped + ')$'); } catch (e) { return null; }
  }
  // 命中判定：同时拿 location.href 和 hostname 试，兼容 *://*.x.com/*（URL 写法）与 *.x.com（域名写法）。
  function isUrlBlacklisted(href, hostname) {
    const bl = loadBlacklist();
    if (!bl.enabled || !bl.patterns || !bl.patterns.length) return false;
    const h = href || location.href;
    const host = hostname || location.hostname;
    for (const p of bl.patterns) {
      const re = patternToRegex(p);
      if (!re) continue;
      if (re.test(h) || re.test(host)) return true;
    }
    return false;
  }
  function isNewSite() {
    const root = getRootDomain(location.hostname);
    if (!root) return false;
    return !loadSeenSites().includes(root);
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
  // ============= 样式注入（引擎无关，脚本启动即注入；任意页面通用设置 UI 都依赖它）=============
  function injectCSS() {
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
        #__titan_dm_menu__{position:fixed;top:0;left:0;transform:translateY(-6px) scale(0.96);transform-origin:top center;background:linear-gradient(180deg,rgba(30,30,36,0.98),rgba(18,18,22,0.98));border:1px solid rgba(255,255,255,0.1);border-radius:10px;width:340px;max-width:340px;max-height:min(80vh,560px);display:flex;flex-direction:column;overflow:hidden;color:#eee;font-size:12px;box-shadow:0 12px 40px rgba(0,0,0,0.6),inset 0 1px 0 rgba(255,255,255,0.06);z-index:2147483647;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;user-select:none;opacity:0;visibility:hidden;pointer-events:none;transition:opacity .18s ease,transform .18s cubic-bezier(.4,0,.2,1),visibility 0s linear .18s}
        /* 横版滑动双面板 */
        #__titan_dm_menu__ .dm-panel-move{display:flex;flex:1;min-height:0;transition:transform .25s cubic-bezier(.4,0,.2,1)}
        #__titan_dm_menu__ .dm-panel-move.slide{transform:translateX(-340px)}
        #__titan_dm_menu__ .dm-panel{width:340px;flex-shrink:0;overflow-y:auto;overflow-x:hidden;padding:14px 16px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,0.2) transparent}
        #__titan_dm_menu__ .dm-panel::-webkit-scrollbar{width:6px}
        #__titan_dm_menu__ .dm-panel::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.2);border-radius:3px}
        /* 底部固定区（独有功能按钮，不随面板滑动）*/
        #__titan_dm_menu__ .dm-footer{flex-shrink:0;border-top:1px solid rgba(255,255,255,0.08);padding:10px 16px;display:flex;flex-direction:column;gap:6px}
        /* 按类型过滤图标块 */
        #__titan_dm_menu__ .filter-type-group{display:flex;justify-content:space-around;gap:2px}
        #__titan_dm_menu__ .filter-type{display:flex;flex-direction:column;align-items:center;gap:2px;padding:5px 8px;border:0;border-radius:6px;cursor:pointer;transition:background .12s;position:relative;flex:0 0 auto}
        #__titan_dm_menu__ .filter-type svg{width:20px;height:20px;fill:#888;transition:fill .12s}
        #__titan_dm_menu__ .filter-type span{font-size:10px;color:#888;transition:color .12s}
        #__titan_dm_menu__ .filter-type input{position:absolute;opacity:0;pointer-events:none}
        #__titan_dm_menu__ .filter-type:hover{background:rgba(255,255,255,0.08)}
        #__titan_dm_menu__ .filter-type:hover svg{fill:#fff}
        #__titan_dm_menu__ .filter-type:hover span{color:#fff}
        #__titan_dm_menu__ .filter-type:has(input:checked) svg,#__titan_dm_menu__ .filter-type:has(input:checked) span{color:#00a1d6;fill:#00a1d6}
        #__titan_dm_menu__ .filter-type:has(input:checked):hover{background:rgba(0,161,214,0.12)}
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
        /* 标题下方的弹幕信息行（持久显示 + 保存弹幕入口；换行不撑宽菜单） */
        #__titan_dm_menu__ .dm-info{margin:-4px 0 8px;font-size:11px;line-height:1.5;word-break:break-all;color:#9cf}
        #__titan_dm_menu__ .dm-info .dm-save{font-size:10px;color:#888;text-decoration:underline;cursor:pointer;margin-left:6px;white-space:nowrap}
        #__titan_dm_menu__ .dm-info .dm-save:hover{color:#9cf}
        #__titan_dm_menu__ .dm-info .dm-save[hidden]{display:none}
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
        /* 描边类型单选组（按钮式）+ 弹幕字体下拉 */
        #__titan_dm_menu__ .radio-group{display:flex;gap:6px}
        #__titan_dm_menu__ .radio-group input{display:none}
        #__titan_dm_menu__ .radio-group label{flex:1;text-align:center;padding:6px 4px;border:1px solid rgba(255,255,255,0.15);border-radius:5px;cursor:pointer;font-size:11px;color:#999;transition:all .12s;user-select:none}
        #__titan_dm_menu__ .radio-group input:checked + label{background:rgba(0,161,214,0.18);border-color:#00a1d6;color:#fff}
        #__titan_dm_menu__ .radio-group label:hover{border-color:rgba(0,161,214,0.4);color:#fff}
        #__titan_dm_menu__ select{outline:none}
        #__titan_dm_menu__ select:focus{border-color:#00a1d6}
        /* 通用设置弹窗（独立浮层） */
        #__titan_dm_modal_mask,#__titan_dm_bl_mask{position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:2147483646;opacity:0;visibility:hidden;pointer-events:none;transition:opacity .2s ease,visibility 0s linear .2s;backdrop-filter:blur(2px)}
        #__titan_dm_modal_mask.open,#__titan_dm_bl_mask.open{opacity:1;visibility:visible;pointer-events:auto;transition:opacity .2s ease,visibility 0s linear 0s}
        /* 黑名单遮罩提至与设置弹窗同级，靠后 DOM 叠在设置弹窗之上（编辑器盖在设置上） */
        #__titan_dm_bl_mask{z-index:2147483647}
        /* 屏蔽词管理窗口 */
        #__titan_dm_block{position:fixed;top:50%;left:50%;transform:translate(-50%,-48%) scale(0.96);width:min(360px,calc(100vw - 32px));max-height:min(70vh,480px);display:flex;flex-direction:column;background:linear-gradient(180deg,rgba(30,30,36,0.98),rgba(18,18,22,0.98));border:1px solid rgba(255,255,255,0.12);border-radius:12px;color:#eee;font-size:12px;box-shadow:0 20px 60px rgba(0,0,0,0.7);z-index:2147483647;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;opacity:0;visibility:hidden;pointer-events:none;transition:opacity .2s ease,transform .2s cubic-bezier(.4,0,.2,1),visibility 0s linear .2s;overflow:hidden}
        #__titan_dm_block.open{opacity:1;visibility:visible;pointer-events:auto;transform:translate(-50%,-50%) scale(1)}
        #__titan_dm_block_mask{position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:2147483646;opacity:0;visibility:hidden;pointer-events:none;transition:opacity .2s ease,visibility 0s linear .2s;backdrop-filter:blur(2px)}
        #__titan_dm_block_mask.open{opacity:1;visibility:visible;pointer-events:auto;transition:opacity .2s ease,visibility 0s linear 0s}
        #__titan_dm_block .block-head{display:flex;align-items:center;padding:14px 16px 10px;border-bottom:1px solid rgba(255,255,255,0.08)}
        #__titan_dm_block .block-title{flex:1;font-size:14px;font-weight:600;color:#fff}
        #__titan_dm_block .block-close{background:transparent;border:0;color:#888;cursor:pointer;font-size:20px;line-height:1}
        #__titan_dm_block .block-close:hover{color:#fff}
        #__titan_dm_block .block-add{display:flex;gap:8px;padding:12px 16px}
        #__titan_dm_block .block-add input{flex:1;min-width:0;background:#222;color:#eee;border:1px solid #444;border-radius:6px;padding:8px 10px;font-size:12px}
        #__titan_dm_block .block-add input:focus{outline:none;border-color:#00a1d6}
        #__titan_dm_block .block-add-btn{padding:8px 16px;background:linear-gradient(180deg,#00b4e8,#0098d6);color:#fff;border:0;border-radius:6px;cursor:pointer;font-size:12px;font-weight:500}
        #__titan_dm_block .block-add-btn:hover{background:linear-gradient(180deg,#1ac5ff,#00a1d6)}
        #__titan_dm_block .block-tip{padding:0 16px 8px;color:#888;font-size:11px}
        #__titan_dm_block .block-list{flex:1;min-height:0;overflow-y:auto;padding:4px 12px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,0.2) transparent}
        #__titan_dm_block .block-list::-webkit-scrollbar{width:6px}
        #__titan_dm_block .block-list::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.2);border-radius:3px}
        #__titan_dm_block .block-item{display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:6px;transition:background .12s}
        #__titan_dm_block .block-item:hover{background:rgba(255,255,255,0.04)}
        #__titan_dm_block .block-word{flex:1;min-width:0;color:#ddd;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        #__titan_dm_block .block-del{background:transparent;border:0;color:#888;cursor:pointer;font-size:14px;padding:2px 6px;border-radius:4px;transition:all .12s}
        #__titan_dm_block .block-del:hover{color:#f88;background:rgba(245,80,80,0.12)}
        #__titan_dm_block .block-empty{padding:24px;text-align:center;color:#666}
        #__titan_dm_block .block-footer{padding:10px 16px;border-top:1px solid rgba(255,255,255,0.08)}
        #__titan_dm_block .block-clear-btn{width:100%;padding:7px;background:rgba(245,80,80,0.1);color:#f88;border:1px solid rgba(245,80,80,0.25);border-radius:6px;cursor:pointer;font-size:11px;transition:all .12s}
        #__titan_dm_block .block-clear-btn:hover{background:rgba(245,80,80,0.2);color:#faa}
        /* 新站点询问浮层（右下角，带 6s 进度条，超时向右滑出） */
        #__titan_dm_newsite{position:fixed;right:24px;bottom:116px;width:320px;max-width:calc(100vw - 48px);background:linear-gradient(180deg,rgba(30,30,36,0.98),rgba(18,18,22,0.98));border:1px solid rgba(255,255,255,0.12);border-radius:12px;padding:14px 16px;color:#eee;font-size:12px;box-shadow:0 20px 60px rgba(0,0,0,0.7);z-index:2147483647;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;opacity:0;transform:translateX(120%);transition:opacity .25s ease,transform .3s cubic-bezier(.4,0,.2,1);pointer-events:none}
        #__titan_dm_newsite.show{opacity:1;transform:translateX(0);pointer-events:auto}
        #__titan_dm_newsite.hide{opacity:0;transform:translateX(120%);pointer-events:none}
        #__titan_dm_newsite .ns-msg{color:#ddd;line-height:1.5;margin-bottom:10px}
        #__titan_dm_newsite .ns-btns{display:flex;gap:6px;margin-bottom:10px}
        #__titan_dm_newsite .ns-btn{flex:1;min-width:0;padding:8px 4px;background:rgba(255,255,255,0.06);color:#eee;border:1px solid rgba(255,255,255,0.12);border-radius:6px;cursor:pointer;font-size:11px;transition:all .12s;text-align:center;display:flex;flex-direction:column;gap:3px;align-items:center}
        #__titan_dm_newsite .ns-btn:hover{background:rgba(0,161,214,0.18);border-color:rgba(0,161,214,0.4);color:#fff}
        #__titan_dm_newsite .ns-btn.ns-no{background:rgba(245,80,80,0.1);color:#f88;border-color:rgba(245,80,80,0.25)}
        #__titan_dm_newsite .ns-btn.ns-no:hover{background:rgba(245,80,80,0.2);color:#faa}
        #__titan_dm_newsite .ns-sub{display:block;font-size:9px;color:#888;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
        #__titan_dm_newsite .ns-bar{height:3px;background:rgba(255,255,255,0.1);border-radius:2px;overflow:hidden}
        #__titan_dm_newsite .ns-bar>i{display:block;height:100%;width:100%;background:linear-gradient(90deg,#00b4e8,#0098d6);transform-origin:left center;animation:__nsDeplete 6s linear forwards}
        @keyframes __nsDeplete{from{transform:scaleX(1)}to{transform:scaleX(0)}}
        /* 黑名单管理窗口（复用屏蔽词窗口调性） */
        #__titan_dm_blacklist{position:fixed;top:50%;left:50%;transform:translate(-50%,-48%) scale(0.96);width:min(420px,calc(100vw - 32px));max-height:min(80vh,560px);display:flex;flex-direction:column;background:linear-gradient(180deg,rgba(30,30,36,0.98),rgba(18,18,22,0.98));border:1px solid rgba(255,255,255,0.12);border-radius:12px;color:#eee;font-size:12px;box-shadow:0 20px 60px rgba(0,0,0,0.7);z-index:2147483647;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;opacity:0;visibility:hidden;pointer-events:none;transition:opacity .2s ease,transform .2s cubic-bezier(.4,0,.2,1),visibility 0s linear .2s;overflow:hidden}
        #__titan_dm_blacklist.open{opacity:1;visibility:visible;pointer-events:auto;transform:translate(-50%,-50%) scale(1)}
        #__titan_dm_blacklist .bl-head{display:flex;align-items:center;padding:14px 16px 10px;border-bottom:1px solid rgba(255,255,255,0.08)}
        #__titan_dm_blacklist .bl-title{flex:1;font-size:14px;font-weight:600;color:#fff}
        #__titan_dm_blacklist .bl-close{background:transparent;border:0;color:#888;cursor:pointer;font-size:20px;line-height:1}
        #__titan_dm_blacklist .bl-close:hover{color:#fff}
        #__titan_dm_blacklist .bl-body{padding:12px 16px;flex:1;overflow-y:auto;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,0.2) transparent}
        #__titan_dm_blacklist .bl-tip{color:#888;font-size:11px;line-height:1.6;margin-bottom:10px}
        #__titan_dm_blacklist .bl-tip code{background:rgba(255,255,255,0.08);padding:1px 5px;border-radius:3px;font-family:Menlo,monospace;color:#9cf}
        #__titan_dm_blacklist textarea{width:100%;min-height:240px;resize:vertical;background:#222;color:#eee;border:1px solid #444;border-radius:6px;padding:8px 10px;font-size:12px;font-family:Menlo,monospace;line-height:1.5;box-sizing:border-box}
        #__titan_dm_blacklist textarea:focus{outline:none;border-color:#00a1d6}
        #__titan_dm_blacklist .bl-footer{padding:10px 16px;border-top:1px solid rgba(255,255,255,0.08)}
        #__titan_dm_blacklist .bl-save{width:100%;padding:8px;background:linear-gradient(180deg,#00b4e8,#0098d6);color:#fff;border:0;border-radius:6px;cursor:pointer;font-size:12px;font-weight:500;transition:background .12s}
        #__titan_dm_blacklist .bl-save:hover{background:linear-gradient(180deg,#1ac5ff,#00a1d6)}
        html.__titan_dm_light__ #__titan_dm_newsite{background:linear-gradient(180deg,#fff,#f4f6f8);color:#222;border-color:rgba(0,0,0,0.12);box-shadow:0 20px 60px rgba(0,0,0,0.2)}
        html.__titan_dm_light__ #__titan_dm_newsite .ns-msg{color:#222}
        html.__titan_dm_light__ #__titan_dm_newsite .ns-btn{background:rgba(0,0,0,0.04);color:#222;border-color:rgba(0,0,0,0.12)}
        html.__titan_dm_light__ #__titan_dm_newsite .ns-btn:hover{background:rgba(0,161,214,0.1);color:#000}
        html.__titan_dm_light__ #__titan_dm_newsite .ns-sub{color:#888}
        html.__titan_dm_light__ #__titan_dm_newsite .ns-bar{background:rgba(0,0,0,0.1)}
        html.__titan_dm_light__ #__titan_dm_blacklist{background:linear-gradient(180deg,#fff,#f4f6f8);color:#222;border-color:rgba(0,0,0,0.12)}
        html.__titan_dm_light__ #__titan_dm_blacklist .bl-title{color:#111}
        html.__titan_dm_light__ #__titan_dm_blacklist .bl-close{color:#999}
        html.__titan_dm_light__ #__titan_dm_blacklist .bl-close:hover{color:#000}
        html.__titan_dm_light__ #__titan_dm_blacklist .bl-tip{color:#888}
        html.__titan_dm_light__ #__titan_dm_blacklist .bl-tip code{background:rgba(0,0,0,0.06);color:#0070a8}
        html.__titan_dm_light__ #__titan_dm_blacklist textarea{background:#fff;color:#222;border-color:#ccc}
        html.__titan_dm_light__ #__titan_dm_blacklist .bl-footer{border-color:rgba(0,0,0,0.08)}
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
        #__titan_dm_ddp_search .ddp-list::-webkit-scrollbar{width:6px}
        #__titan_dm_ddp_search .ddp-list::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.2);border-radius:3px}
        #__titan_dm_ddp_search .ddp-anime{display:flex;gap:10px;padding:7px;border-radius:8px;cursor:pointer;transition:background .12s;align-items:center}
        #__titan_dm_ddp_search .ddp-anime:hover{background:rgba(0,161,214,0.12)}
        #__titan_dm_ddp_search .ddp-anime img{width:40px;height:56px;object-fit:cover;border-radius:4px;flex-shrink:0;background:#333}
        #__titan_dm_ddp_search .ddp-anime .meta{flex:1;min-width:0}
        #__titan_dm_ddp_search .ddp-anime .ttl{color:#fff;font-weight:500;font-size:13px;word-break:break-word;line-height:1.4}
        #__titan_dm_ddp_search .ddp-anime .sub{color:#888;font-size:11px;margin-top:3px}
        #__titan_dm_ddp_search .ddp-ep{display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:6px;cursor:pointer;transition:background .12s}
        #__titan_dm_ddp_search .ddp-ep:hover{background:rgba(0,161,214,0.14)}
        #__titan_dm_ddp_search .ddp-ep .no{flex:0 0 34px;color:#9cf;font-family:Menlo,monospace;font-size:11px}
        #__titan_dm_ddp_search .ddp-ep .ttl{flex:1;min-width:0;color:#ddd;font-size:12px;word-break:break-word;line-height:1.4}
        #__titan_dm_ddp_search .ddp-ep .load{font-size:10px;color:#666}
        /* 剧集列表底部「获取全部剧集」入口（筛选可能漏集时出现） */
        #__titan_dm_ddp_search .ddp-all-eps{margin:10px 0 2px;padding:8px;text-align:center;font-size:11px;color:#888;cursor:pointer;border:1px dashed rgba(255,255,255,0.15);border-radius:6px;transition:all .12s}
        #__titan_dm_ddp_search .ddp-all-eps:hover{color:#9cf;border-color:rgba(0,161,214,0.4);background:rgba(0,161,214,0.06)}
        #__titan_dm_ddp_search .ddp-status{padding:8px 16px 12px;color:#9cf;font-size:11px;min-height:18px;border-top:1px solid rgba(255,255,255,0.06);display:flex;align-items:center;gap:8px}
        #__titan_dm_ddp_search .ddp-status .ddp-spin{flex:0 0 auto;width:13px;height:13px;border:2px solid rgba(0,161,214,0.25);border-top-color:#00a1d6;border-radius:50%;animation:ddpSpin .7s linear infinite;display:none}
        #__titan_dm_ddp_search .ddp-status.loading .ddp-spin{display:block}
        @keyframes ddpSpin{to{transform:rotate(360deg)}}
        /* list 区加载遮罩：请求进行中覆盖，禁止误点 */
        #__titan_dm_ddp_search .ddp-list-wrap{position:relative;flex:1;min-height:0;overflow:hidden;display:flex;flex-direction:column}
        #__titan_dm_ddp_search .ddp-list{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:6px 10px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,0.2) transparent}
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
        html.__titan_dm_light__ #__titan_dm_menu__ .dm-info{color:#0070a8}
        html.__titan_dm_light__ #__titan_dm_menu__ .dm-info .dm-save{color:#999}
        html.__titan_dm_light__ #__titan_dm_menu__ .dm-info .dm-save:hover{color:#0070a8}
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
        html.__titan_dm_light__ #__titan_dm_menu__ .radio-group label{color:#666;border-color:rgba(0,0,0,0.15)}
        html.__titan_dm_light__ #__titan_dm_menu__ .radio-group input:checked + label{background:rgba(0,161,214,0.1);border-color:#00a1d6;color:#000}
        html.__titan_dm_light__ #__titan_dm_menu__ .radio-group label:hover{color:#000}
        html.__titan_dm_light__ #__titan_dm_menu__ select{background:#fff;color:#222;border-color:#ccc}
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
        /* 屏蔽词窗口亮色 */
        html.__titan_dm_light__ #__titan_dm_block{background:linear-gradient(180deg,#fff,#f4f6f8);color:#222;border-color:rgba(0,0,0,0.12)}
        html.__titan_dm_light__ #__titan_dm_block .block-title{color:#111}
        html.__titan_dm_light__ #__titan_dm_block .block-close{color:#999}
        html.__titan_dm_light__ #__titan_dm_block .block-close:hover{color:#000}
        html.__titan_dm_light__ #__titan_dm_block .block-add input{background:#fff;color:#222;border-color:#ccc}
        html.__titan_dm_light__ #__titan_dm_block .block-word{color:#333}
        html.__titan_dm_light__ #__titan_dm_block .block-tip{color:#999}
        html.__titan_dm_light__ #__titan_dm_block .block-empty{color:#999}
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
        html.__titan_dm_light__ #__titan_dm_ddp_search .ddp-all-eps{color:#888;border-color:rgba(0,0,0,0.12)}
        html.__titan_dm_light__ #__titan_dm_ddp_search .ddp-all-eps:hover{color:#0070a8;border-color:rgba(0,161,214,0.4);background:rgba(0,161,214,0.06)}
        html.__titan_dm_light__ #__titan_dm_ddp_search .ddp-loading{background:rgba(255,255,255,0.55)}
        html.__titan_dm_light__ #__titan_dm_ddp_search .ddp-loading .big-txt{color:#0070a8}
        html.__titan_dm_light__ #__titan_dm_ddp_search .ddp-empty{color:#999}
        /* 主题切换按钮（菜单底部，通用设置弹窗内也可手动切）*/
        #__titan_dm_menu__ .btn-theme{display:block;width:100%;padding:6px;background:transparent;color:#9cf;border:1px solid rgba(255,255,255,0.15);border-radius:4px;cursor:pointer;font-size:11px;margin-top:6px;transition:all .12s}
        #__titan_dm_menu__ .btn-theme:hover{background:rgba(0,161,214,0.12);color:#fff}
        html.__titan_dm_light__ #__titan_dm_menu__ .btn-theme{color:#0070a8;border-color:rgba(0,0,0,0.15)}
        html.__titan_dm_light__ #__titan_dm_menu__ .btn-theme:hover{color:#000}
        html.__titan_dm_light__ #__titan_dm_menu__ .dm-footer{border-color:rgba(0,0,0,0.08)}
        html.__titan_dm_light__ #__titan_dm_menu__ .filter-type svg{fill:#666}
        html.__titan_dm_light__ #__titan_dm_menu__ .filter-type span{color:#666}
        html.__titan_dm_light__ #__titan_dm_menu__ .filter-type:hover{background:rgba(0,0,0,0.05)}
        html.__titan_dm_light__ #__titan_dm_menu__ .filter-type:hover svg{fill:#000}
        html.__titan_dm_light__ #__titan_dm_menu__ .filter-type:hover span{color:#000}
        html.__titan_dm_light__ #__titan_dm_menu__ .filter-type:has(input:checked) svg,html.__titan_dm_light__ #__titan_dm_menu__ .filter-type:has(input:checked) span{color:#00a1d6;fill:#00a1d6}
      `;
      try { document.head.appendChild(css); } catch (e) { /* CSP 等异常不阻断脚本 */ }
    }
    // 应用主题（首次注入即生效；之后 toggle 切换）
    try { applyTheme(); } catch (e) {}
  }

  // ============= 通用设置 UI（引擎无关：可在任意页面经油猴菜单打开）=============
  const $ = (id) => document.getElementById(id);
  let settingsModal, settingsMask, blacklistModal, blacklistMask;
  let __settingsUIReady = false;

  // AI 开关切换：保存 enabled 字段 + 实时刷新两个「智能匹配」按钮的显隐
  function refreshAiMatchVisibility() {
    const show = aiMatchVisible();
    const m1 = $('__dm_ddp_match__'); if (m1) m1.style.display = show ? '' : 'none';
    const m2 = $('__ddp_match2__'); if (m2) m2.style.display = show ? '' : 'none';
    // 开关 UI 同步
    const sw = $('__dm_ai_switch__'); if (sw) sw.classList.toggle('on', aiEnabled());
    const am = $('__dm_auto_match__'); if (am) am.classList.toggle('on', autoMatchEnabled());
  }
  function refreshBlacklistVisibility() {
    const on = blacklistEnabled();
    const sw = $('__dm_bl_switch__'); if (sw) sw.classList.toggle('on', on);
    const row = $('__dm_bl_open_row__'); if (row) row.style.display = on ? '' : 'none';
    const hint = $('__dm_bl_hint__'); if (hint) hint.style.display = on ? '' : 'none';
  }
  function renderBlacklist() {
    const bl = loadBlacklist();
    $('__dm_bl_text__').value = (bl.patterns || []).join('\n');
  }
  // 编辑器直接盖在通用设置之上（不关设置弹窗，保留用户未保存的 AI 配置输入）
  function openBlacklistModal() {
    renderBlacklist();
    blacklistMask.classList.add('open');
    blacklistModal.classList.add('open');
  }
  function closeBlacklistModal() {
    if (!__settingsUIReady) return;
    blacklistModal.classList.remove('open');
    blacklistMask.classList.remove('open');
  }
  // 通用设置弹窗：open / close
  function openSettingsModal() {
    ensureSettingsUI();
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
    // 同步黑名单开关 + 入口显隐
    refreshBlacklistVisibility();
  }
  function closeSettingsModal() {
    if (!__settingsUIReady) return;
    settingsModal.classList.remove('open');
    settingsMask.classList.remove('open');
  }

  // 创建设置/黑名单 UI + 绑定事件（幂等；引擎无关，任意页面首次打开通用设置时调用）
  function ensureSettingsUI() {
    if (__settingsUIReady) return;
    injectCSS();
    // 通用设置弹窗（独立的浮层 + 遮罩），挂到 body
    settingsModal = document.createElement('div');
    settingsModal.id = '__titan_dm_settings';
    settingsModal.innerHTML = `
      <div class="modal-title">⚙ 通用设置</div>
      <div class="modal-section">配置管理</div>
      <div class="row"><label>重置所有</label><button class="btn btn-danger" id="__dm_reset_all__">清空所有存储</button></div>
      <div class="row"><label>导出</label><button class="btn" id="__dm_export__">下载 settings.json</button></div>
      <div class="row"><label>导入</label><button class="btn" id="__dm_import__">选择 JSON 文件</button></div>
      <input type="file" id="__dm_import_file" accept=".json" style="display:none">
      <div class="row"><label>黑名单</label><div id="__dm_bl_switch__" class="switch"></div><span class="hint" style="margin:0 0 0 8px">部分网页不注入弹幕</span></div>
      <div class="row" id="__dm_bl_open_row__" style="display:none"><button class="btn" id="__dm_bl_open__">🚫 管理黑名单</button></div>
      <p class="hint" id="__dm_bl_hint__" style="display:none">开启后：新站点首次全自动载入前会询问是否加入；命中规则的站点不注入弹幕（不显示图标/消息）。</p>
      <div class="modal-section">弹弹play 代理</div>
      <div class="row"><label>Worker URL</label><input type="text" id="__dm_ddp_url__" placeholder="留空用默认内置 API" style="flex:1;min-width:0;background:#222;color:#eee;border:1px solid #444;border-radius:5px;padding:7px 10px;font-size:12px"></div>
      <div class="row"><label>Token</label><input type="text" id="__dm_ddp_token__" placeholder="留空用默认" style="flex:1;min-width:0;background:#222;color:#eee;border:1px solid #444;border-radius:5px;padding:7px 10px;font-size:12px"></div>
      <div class="row"><label>简繁转换</label><select id="__dm_chconvert__" style="flex:1;min-width:0;background:#222;color:#eee;border:1px solid #444;border-radius:5px;padding:7px 10px;font-size:12px;cursor:pointer"><option value="1">转换为简体（默认）</option><option value="0">不转换</option><option value="2">转换为繁体</option></select></div>
      <div class="row"><button class="btn btn-primary" id="__dm_ddp_save__">保存代理配置</button></div>
      <div class="row"><label>匹配缓存</label><button class="btn btn-danger" id="__dm_ddp_clear_match__">清空已匹配记录</button></div>
      <p class="hint">部署自己的 Worker 见 <code style="font-size:10px">userscript/worker/README.md</code>；匹配过的视频会记住，下次「智能匹配」直接命中，免重复请求。</p>
      <div class="modal-section">AI 配置（智能匹配增强）</div>
      <div class="row"><label>启用 AI</label><div id="__dm_ai_switch__" class="switch"></div><span class="hint" style="margin:0 0 0 8px">开启后「✨ 智能匹配」用 LLM 提取文件名</span></div>
      <div class="row"><label>全自动载入</label><div id="__dm_auto_match__" class="switch"></div><span class="hint" style="margin:0 0 0 8px">打开视频自动匹配标题->单结果自动载入弹幕（零操作）</span></div>
      <div class="row"><label>API 地址</label><input type="text" id="__dm_ai_url__" placeholder="填到 /v1，如 https://ai.retr0.xyz/v1" style="flex:1;min-width:0;background:#222;color:#eee;border:1px solid #444;border-radius:5px;padding:7px 10px;font-size:12px"></div>
      <div class="row"><label>Key</label><input type="text" id="__dm_ai_key__" placeholder="sk-...（OpenAI 兼容）" style="flex:1;min-width:0;background:#222;color:#eee;border:1px solid #444;border-radius:5px;padding:7px 10px;font-size:12px"></div>
      <div class="row"><label>模型</label><input type="text" id="__dm_ai_model__" placeholder="deepseek-chat / gpt-4o-mini 等" style="flex:1;min-width:0;background:#222;color:#eee;border:1px solid #444;border-radius:5px;padding:7px 10px;font-size:12px"></div>
      <div class="row"><button class="btn" id="__dm_ai_test__">测试 AI 可用性</button><button class="btn btn-primary" id="__dm_ai_save__">保存 AI 配置</button></div>
      <p class="hint">开启后显示「✨ 智能匹配当前视频」，使用AI提取番剧名+集号再搜索；关闭则该按钮隐藏。</p>
      <div class="modal-section">关于</div>
      <div class="about">
        <p><b class="about-brand"> 今天要来点弹幕吗？</b></p>
        <p>脚本版本：<code id="__dm_ver_script__">1.2.1</code></p>
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
    settingsMask = document.createElement('div');
    settingsMask.id = '__titan_dm_modal_mask';
    document.body.appendChild(settingsMask);
    // ============= 全自动载入黑名单管理窗口 ============
    blacklistModal = document.createElement('div');
    blacklistModal.id = '__titan_dm_blacklist';
    blacklistModal.innerHTML = `
      <div class="bl-head"><span class="bl-title">🚫 全自动载入黑名单</span><button class="bl-close" id="__dm_bl_close__">×</button></div>
      <div class="bl-body">
        <p class="bl-tip">每行一条 URL，可使用 <code>*</code> 作为通配符。命中规则的网页将不注入弹幕（不显示图标/消息）。示例：<code>*://*.bilibili.com/*</code></p>
        <textarea id="__dm_bl_text__" placeholder="*://*.bilibili.com/*&#10;*://*.youtube.com/*&#10;*://video.example.com/*" spellcheck="false"></textarea>
      </div>
      <div class="bl-footer"><button class="bl-save" id="__dm_bl_save__">保存</button></div>
    `;
    blacklistMask = document.createElement('div');
    blacklistMask.id = '__titan_dm_bl_mask';  // 独立遮罩，z-index 与设置弹窗同级、靠后 DOM 叠在上层
    document.body.appendChild(blacklistMask);
    document.body.appendChild(blacklistModal);  // modal 在 mask 之后追加 -> 同 z 时盖在 mask 上

    // ============= 事件绑定 ============
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
    // 黑名单开关：开 -> 显示「管理黑名单」入口
    $('__dm_bl_switch__').addEventListener('click', () => {
      const cfg = loadBlacklist();
      cfg.enabled = !cfg.enabled;
      saveBlacklist(cfg);
      refreshBlacklistVisibility();
    });
    // 黑名单管理入口 -> 打开编辑窗口
    $('__dm_bl_open__').addEventListener('click', () => { openBlacklistModal(); });
    // 保存：每行一条 -> 去空去重 -> 持久化 -> 关窗（设置弹窗仍开着，保留未保存输入）
    $('__dm_bl_save__').addEventListener('click', () => {
      const lines = $('__dm_bl_text__').value.split('\n').map(s => s.trim()).filter(Boolean);
      const cfg = loadBlacklist();
      cfg.patterns = lines;
      saveBlacklist(cfg);
      closeBlacklistModal();
      showStatus('🚫 黑名单已保存（' + lines.length + ' 条）', 4000);
    });
    // 关闭 / 点遮罩：仅关黑名单编辑器（设置弹窗在下方保持打开）
    $('__dm_bl_close__').addEventListener('click', closeBlacklistModal);
    blacklistMask.addEventListener('click', closeBlacklistModal);
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
    // 测试 AI 可用性：用当前输入框值（不必先保存）临时写入并跑一次提取
    $('__dm_ai_test__').addEventListener('click', async () => {
      const baseUrl = $('__dm_ai_url__').value.trim();
      const apiKey = $('__dm_ai_key__').value.trim();
      const model = $('__dm_ai_model__').value.trim();
      if (!baseUrl || !model) { alert('请先填写 API 地址和模型'); return; }
      // 临时写入（不持久化开关，仅让 llmExtractFileName 用到本次配置）
      const old = loadAiConfig();
      saveAiConfig({ enabled: true, autoMatch: !!old.autoMatch, baseUrl, apiKey, model });
      const testBtn = $('__dm_ai_test__');
      const origTxt = testBtn.textContent;
      testBtn.disabled = true; testBtn.textContent = '测试中…';
      try {
        const ext = await llmExtractFileName('[KTXP&VCB-Studio] Plastic Memories [13][Ma10p_1080p][x265_flac].mkv');
        if (ext && ext.title) {
          alert('✅ AI 可用！\n 测试用例：[KTXP&VCB-Studio] Plastic Memories [13][Ma10p_1080p][x265_flac].mkv \n模型：' + model + '\n测试提取结果：\n  番剧名：' + ext.title + (ext.episode ? '\n  集号：' + ext.episode : ''));
        } else {
          alert('⚠️ AI 已响应但未提取到有效结果，请检查模型是否支持');
        }
      } catch (e) {
        alert('❌ AI 测试失败：' + e.message);
      } finally {
        // 还原开关持久化状态（测试时临时开了 enabled，恢复回 old）
        saveAiConfig({ enabled: !!old.enabled, autoMatch: !!old.autoMatch, baseUrl, apiKey, model });
        testBtn.disabled = false; testBtn.textContent = origTxt;
        refreshAiMatchVisibility();
      }
    });
    // 简繁转换：下拉改即存（弹弹play comment 接口的 chConvert 参数）
    $('__dm_chconvert__').addEventListener('change', () => {
      const v = parseInt($('__dm_chconvert__').value, 10);
      const s = loadSettings();
      s.ddpChConvert = (v >= 0 && v <= 2) ? v : 1;
      saveSettings(s);
    });
    $('__dm_close_settings__').addEventListener('click', closeSettingsModal);
    settingsMask.addEventListener('click', closeSettingsModal);
    // 弹窗内按钮
    $('__dm_reset_all__').addEventListener('click', () => {
      if (confirm('确定要清空所有设置？此操作不可撤销。（含弹幕样式设置、弹弹play 代理配置、匹配缓存、AI 配置、黑名单）')) {
        [STORAGE_KEY, DDP_KEY, MATCH_CACHE_KEY, AI_KEY, RESUME_KEY, BLACKLIST_KEY, SEEN_SITES_KEY].forEach(k => { try { GM_deleteValue(k); } catch (e) {} });
        alert('已清空。刷新页面后生效。');
      }
    });
    $('__dm_export__').addEventListener('click', () => {
      const data = {
        settings: loadSettings(),
        ddp: loadDdpConfig(),
        ai: loadAiConfig(),
        matchCache: loadMatchCache(),
        blacklist: loadBlacklist(),
        seenSites: loadSeenSites(),
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
          if (obj.blacklist) saveBlacklist(obj.blacklist);
          if (obj.seenSites) saveSeenSites(obj.seenSites);
          // 兼容旧格式（导出的是裸 settings 对象而不是包装的）
          if (!obj.settings && !obj.ddp && !obj.ai && !obj.matchCache && !obj.blacklist) saveSettings(obj);
          alert('导入成功！' + (obj.settings ? '弹幕设置 + 代理 + AI + 匹配缓存已恢复' : '弹幕设置已恢复'));
        } catch (err) { alert('导入失败：' + err.message); }
        e.target.value = '';
      };
      reader.readAsText(f);
    });
    // Esc 关闭设置/黑名单弹窗（覆盖无引擎页面：此时 injectDanmakuControls 的 onKey 未注册；
    //   有引擎页面 onKey 也会处理，classList 操作幂等，不冲突）
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (blacklistModal && blacklistModal.classList.contains('open')) closeBlacklistModal();
      else if (settingsModal && settingsModal.classList.contains('open')) closeSettingsModal();
    });
    __settingsUIReady = true;
  }


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
    injectCSS();
    ensureSettingsUI();  // 通用设置 UI（引擎无关，任意页面可用）

    if (document.getElementById('__titan_dm_btn__')) return;

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
      <div class="dm-panel-move">
        <!-- 常用设置 -->
        <div class="dm-panel">
          <div class="title"><span class="ttl">弹幕设置</span><span class="dm-close" id="__dm_menu_close__" title="关闭">×</span></div>
          <div class="dm-info"><span class="dm-status"></span><a class="dm-save" hidden title="保存当前弹幕为 XML 文件">保存弹幕</a></div>
          <div class="row"><label>显示</label><div id="__dm_switch__" class="switch on"></div></div>
          <div class="sep"></div>
          <div class="row"><label>字号</label><input type=range id=__dm_font__ min=50 max=200 value=100 step=5><span class=val id=__dm_fontv__>1.0×</span></div>
          <div class="row"><label>不透明度</label><input type=range id=__dm_op__ min=20 max=100 value=85 step=5><span class=val id=__dm_opv__>85%</span></div>
          <div class="row"><label>区域</label><input type=range id=__dm_area__ min=25 max=100 value=100 step=5><span class=val id=__dm_areav__>满屏</span></div>
          <div class="row"><label>速度</label><input type=range id=__dm_speed__ min=25 max=300 value=100 step=25><span class=val id=__dm_speedv__>1.0×</span></div>
          <div class="row"><label>密度</label><input type=range id=__dm_dens__ min=10 max=100 value=100 step=10><span class=val id=__dm_densv__>1.0</span></div>
          <div class="row"><label>时长</label><input type=range id=__dm_dur__ min=20 max=120 value=45 step=5><span class=val id=__dm_durv__>4.5s</span></div>
          <div class="row"><label>上限</label><input type=number id=__dm_limit__ value=300 min=0 step=50></div>
          <div class="sep"></div>
          <div class="row"><label>速度同步</label><input type=checkbox class=check id=__dm_sync__ checked></div>
          <div class="row"><label>加粗</label><input type=checkbox class=check id=__dm_bold__ checked></div>
          <div class="row"><label>防遮挡</label><input type=checkbox class=check id=__dm_shade__></div>
          <div class="sep"></div>
          <button class="btn-more" data-go-page="2">更多设置 -></button>
        </div>
        <!-- 高级设置 -->
        <div class="dm-panel">
          <div class="title-bar">
            <button class="btn-back" data-go-page="1">← 返回</button>
            <span class="title-text">高级设置</span>
          </div>
          <div class="dm-info"><span class="dm-status"></span><a class="dm-save" hidden title="保存当前弹幕为 XML 文件">保存弹幕</a></div>
          <div class="row"><label>全屏同步</label><input type=checkbox class=check id=__dm_fssync__></div>
          <div class="row"><label>顶部偏移</label><input type=number id=__dm_offtop__ value=0 step=1 style="width:60px"></div>
          <div class="row"><label>底部偏移</label><input type=number id=__dm_offbot__ value=0 step=1 style="width:60px"></div>
          <div class="row"><label>最大长度</label><input type=number id=__dm_maxlen__ value=50 min=0 step=10 style="width:60px"></div>
          <div class="sep"></div>
          <div class="row" style="flex-direction:column;align-items:stretch;gap:6px">
            <label style="flex:none;color:#aaa;font-size:11px">按类型过滤</label>
            <div class="filter-type-group">
              <div class="filter-type" data-blk="1"><svg viewBox="0 0 28 28"><path d="M23 3H5a4 4 0 0 0-4 4v14a4 4 0 0 0 4 4h18a4 4 0 0 0 4-4V7a4 4 0 0 0-4-4zM11 9h6a1 1 0 0 1 0 2h-6a1 1 0 0 1 0-2zm-3 2H6V9h2v2zm4 4h-2v-2h2v2zm9 0h-6a1 1 0 0 1 0-2h6a1 1 0 0 1 0 2z"></path></svg><span>滚动</span><input type=checkbox class=check id=__dm_blk_1__></div>
              <div class="filter-type" data-blk="4"><svg viewBox="0 0 28 28"><path d="M23 3H5a4 4 0 0 0-4 4v14a4 4 0 0 0 4 4h18a4 4 0 0 0 4-4V7a4 4 0 0 0-4-4zM9 9H7V7h2v2zm4 0h-2V7h2v2zm4 0h-2V7h2v2zm4 0h-2V7h2v2z"></path></svg><span>底部</span><input type=checkbox class=check id=__dm_blk_4__></div>
              <div class="filter-type" data-blk="5"><svg viewBox="0 0 28 28"><path d="M23 3H5a4 4 0 0 0-4 4v14a4 4 0 0 0 4 4h18a4 4 0 0 0 4-4V7a4 4 0 0 0-4-4zM9 21H7v-2h2v2zm4 0h-2v-2h2v2zm4 0h-2v-2h2v2zm4 0h-2v-2h2v2z"></path></svg><span>顶部</span><input type=checkbox class=check id=__dm_blk_5__></div>
              <div class="filter-type" data-blk="6"><svg viewBox="0 0 28 28"><path d="M23 3H5a4 4 0 0 0-4 4v14a4 4 0 0 0 4 4h18a4 4 0 0 0 4-4V7a4 4 0 0 0-4-4zM7.849 11.669l.447-.828.492.782.894.184-.536.736.134.966-.85-.321-.804.414.045-.967L7 11.946l.849-.277zm3.352 7.101l-1.43-.506L8.43 19v-1.565L7.357 16.33l1.43-.506.67-1.381.894 1.289 1.475.23-.894 1.289.269 1.519zm7.95-3.9l-2.816-.69-2.458 1.565-.223-2.946-2.145-1.933 2.637-1.151L15.263 7l1.877 2.255 2.86.23-1.52 2.531.671 2.854z"></path></svg><span>逆向</span><input type=checkbox class=check id=__dm_blk_6__></div>
            </div>
          </div>
          <div class="row"><button class="btn-save" id="__dm_open_block__">🚫 屏蔽词管理</button></div>
          <div class="sep"></div>
          <div class="row" style="flex-direction:column;align-items:stretch;gap:5px">
            <label style="flex:none;color:#aaa;font-size:11px">描边类型</label>
            <div class="radio-group">
              <input type="radio" name="fontborder" id="__dm_fb0__" value="0" checked><label for="__dm_fb0__">重墨</label>
              <input type="radio" name="fontborder" id="__dm_fb1__" value="1"><label for="__dm_fb1__">描边</label>
              <input type="radio" name="fontborder" id="__dm_fb2__" value="2"><label for="__dm_fb2__">45°投影</label>
            </div>
          </div>
          <div class="row"><label>弹幕字体</label><select id="__dm_fontfamily__" style="flex:1;min-width:0;background:#222;color:#eee;border:1px solid #444;border-radius:4px;padding:5px 8px;font-size:12px;cursor:pointer">
            <option value="SimHei, 'Microsoft JhengHei', Arial, Helvetica, sans-serif">黑体</option>
            <option value="SimSun, serif">宋体</option>
            <option value="NSimSun, serif">新宋体</option>
            <option value="FangSong, serif">仿宋</option>
            <option value="'Microsoft YaHei', sans-serif">微软雅黑</option>
            <option value="'Microsoft YaHei UI Light', sans-serif">微软雅黑 Light</option>
            <option value="'Noto Sans CJK SC DemiLight', sans-serif">Noto Sans DemiLight</option>
            <option value="'Noto Sans CJK SC Regular', sans-serif">Noto Sans Regular</option>
          </select></div>
          <div class="sep"></div>
          <div class="row"><label>DOM 回收</label><input type=checkbox class=check id=__dm_recdom__ checked></div>
          <div class="row"><label>模型回收</label><input type=checkbox class=check id=__dm_recmdl__></div>
          <div class="row"><label>拖拽视频</label><input type=checkbox class=check id=__dm_bindmove__ checked></div>
          <div class="row"><label>禁止缩小</label><input type=checkbox class=check id=__dm_shrink__ checked></div>
        </div>
      </div>
      <div class="dm-footer">
        <button class="btn-more" id="__dm_ddp_search__">🌐 搜索弹幕</button>
        <button class="btn-more" id="__dm_ddp_match__">✨ 智能匹配</button>
        <button class="btn-file" id="__dm_load_file__">📂 载入本地</button>
        <button class="btn-theme" id="__dm_toggle_theme__">🌓 主题</button>
        <button class="btn-more" id="__dm_open_settings__">⚙ 通用设置</button>
      </div>
   `;
    // 菜单挂到 body（脱开 art-video-player 的 overflow: hidden 裁切），用 position: fixed 手动定位到 btn 旁边
    document.body.appendChild(menu);


    // ============= 屏蔽词管理独立窗口 ============
    const blockModal = document.createElement('div');
    blockModal.id = '__titan_dm_block';
    blockModal.innerHTML = `
      <div class="block-head"><span class="block-title">屏蔽词管理</span><button class="block-close" id="__dm_block_close__">×</button></div>
      <div class="block-add">
        <input type="text" id="__dm_block_input__" placeholder="添加屏蔽词，正则以 / 开头 / 结尾">
        <button class="block-add-btn" id="__dm_block_add__">添加</button>
      </div>
      <div class="block-tip">支持子串匹配或 /正则/，共 <span id="__dm_block_count__">0</span> 条</div>
      <div class="block-list" id="__dm_block_list__"></div>
      <div class="block-footer"><button class="block-clear-btn" id="__dm_block_clear__">清空全部</button></div>
    `;
    document.body.appendChild(blockModal);
    const blockMask = document.createElement('div');
    blockMask.id = '__titan_dm_block_mask';
    document.body.appendChild(blockMask);


    // 编辑器直接盖在通用设置之上（不关设置弹窗，保留用户未保存的 AI 配置输入）

    function renderBlockList() {
      const s = loadSettings();
      const bl = Array.isArray(s.blockList) ? s.blockList : [];
      const list = $('__dm_block_list__');
      $('__dm_block_count__').textContent = bl.length;
      if (!bl.length) { list.innerHTML = '<div class="block-empty">暂无屏蔽词</div>'; return; }
      list.innerHTML = bl.map((w, i) => `<div class="block-item"><span class="block-word" title="${escapeHtml(w)}">${escapeHtml(w)}</span><button class="block-del" data-i="${i}">🗑</button></div>`).join('');
      list.querySelectorAll('.block-del').forEach(b => b.addEventListener('click', () => {
        const idx = +b.dataset.i;
        const cur = Array.isArray(loadSettings().blockList) ? loadSettings().blockList : [];
        cur.splice(idx, 1);
        engine.setSetting('blockList', cur);
        renderBlockList();
        reloadDanmakuPreserveTime();
      }));
    }
    function openBlockModal() { renderBlockList(); blockModal.classList.add('open'); blockMask.classList.add('open'); }
    function closeBlockModal() { blockModal.classList.remove('open'); blockMask.classList.remove('open'); }
    $('__dm_block_close__').addEventListener('click', closeBlockModal);
    blockMask.addEventListener('click', closeBlockModal);
    $('__dm_block_add__').addEventListener('click', () => {
      const inp = $('__dm_block_input__');
      const w = inp.value.trim();
      if (!w) return;
      const cur = Array.isArray(loadSettings().blockList) ? loadSettings().blockList : [];
      if (cur.includes(w)) { inp.value = ''; return; }
      cur.push(w);
      engine.setSetting('blockList', cur);
      inp.value = '';
      renderBlockList();
      reloadDanmakuPreserveTime();
    });
    $('__dm_block_input__').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('__dm_block_add__').click(); } });
    $('__dm_block_clear__').addEventListener('click', () => {
      if (confirm('清空所有屏蔽词？')) { engine.setSetting('blockList', []); renderBlockList(); reloadDanmakuPreserveTime(); }
    });

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
    let ddpListIsFiltered = false; // 上次搜索是否按集号过滤过（过滤可能漏集，剧集视图给「获取全部剧集」入口）

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
      list.scrollTop = 0;  // 切换到作品视图回到顶部
      list.querySelectorAll('.ddp-anime').forEach(el => {
        el.addEventListener('click', () => renderDdpEpisodes(animes[+el.dataset.i]));
      });
    }

    // 视图②：某作品的剧集列表（点击 → 经 Worker 拉弹幕载入引擎）
    function renderDdpEpisodes(a) {
      ddpCurrentAnime = a;
      const eps = a.episodes || [];
      $('__ddp_back__').style.display = '';
      ddpSetStatus((a.animeTitle || '') + ' · ' + eps.length + ' 集 - 点击载入弹幕');
      const list = $('__ddp_list__');
      let html = eps.length ? eps.map((e, i) => `
        <div class="ddp-ep" data-i="${i}">
          <span class="no">${escapeHtml(e.episodeNumber || (i + 1))}</span>
          <span class="ttl">${escapeHtml(e.episodeTitle || '')}</span>
          <span class="load">载入 -></span>
        </div>`).join('') : '<div class="ddp-empty">该剧无剧集数据</div>';
      // 筛选过的列表可能漏集：底部给「获取全部剧集」入口（仅当该剧尚未拉取全集）
      if (ddpListIsFiltered && a.animeId && !a.__allEpsLoaded) {
        html += `<div class="ddp-all-eps" id="__ddp_all_eps__" title="按集号筛选可能漏掉目标集，点击拉取该剧全部剧集">不在列表中？点击获取全部剧集</div>`;
      }
      list.innerHTML = html;
      list.scrollTop = 0;  // 切换到剧集视图回到顶部
      list.querySelectorAll('.ddp-ep').forEach(el => {
        el.addEventListener('click', () => {
          const idx = +el.dataset.i;
          const e = eps[idx];
          const label = (a.animeTitle || '') + ' ' + (e.episodeTitle || ('第' + (e.episodeNumber || (idx + 1)) + '集'));
          // 传 meta：用户通过搜索选定某集，也记入匹配缓存（下次智能匹配可命中）
          loadDandanplayComment(e.episodeId, label, { episodeId: e.episodeId, animeTitle: a.animeTitle, episodeTitle: e.episodeTitle });
        });
      });
      const allEpsBtn = $('__ddp_all_eps__');
      if (allEpsBtn) allEpsBtn.addEventListener('click', () => loadAllEpisodes(a));
    }
    // 拉取某作品的全部剧集（不过滤），替换当前剧集列表重新渲染
    async function loadAllEpisodes(a) {
      if (!a || !a.animeId) return;
      try {
        ddpSetStatus('获取全部剧集…', false, { loading: true });
        const bg = await ddpGetBangumi(a.animeId);
        const eps = (bg && bg.episodes) || [];
        a.episodes = eps;
        a.__allEpsLoaded = true;  // 标记已拉全集，不再显示按钮
        renderDdpEpisodes(a);
        ddpSetStatus((a.animeTitle || '') + ' · 共 ' + eps.length + ' 集 - 点击载入弹幕');
      } catch (e) {
        ddpSetStatus('获取全部剧集失败: ' + e.message, true);
      }
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
        ddpListIsFiltered = false;  // 关键词搜索不过滤集号
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
            const want = parseWantEpisode(ext.episode);
            const isSpecial = want.kind === 'special';
            const epLabel = ext.episode === 'movie' ? '（剧场版）' : (ext.episode ? ' ' + ext.episode : '');
            ddpSetStatus('🤖 AI 提取: ' + ext.title + epLabel + '，搜索中…', false, { loading: true });
            // 特殊篇：不用 API 集数过滤（会把 SP1 当正片第1集），拿全部剧集供用户在列表里选
            const res = await ddpSearchEpisodes(ext.title, isSpecial ? '' : ext.episode);
            ddpListIsFiltered = !isSpecial;  // 特殊篇未过滤；正片按集号过滤（可能漏集）
            const animes = (res && res.animes) || [];
            if (animes.length) {
              ddpLastResults = res;
              ddpCurrentAnime = null;
              $('__ddp_back__').style.display = 'none';
              renderDdpAnimes(res);
              // 特殊篇尝试客户端定位，提示是否找到
              let locateMsg = '';
              if (isSpecial) {
                let found = false;
                for (const a of animes) { if (pickSpecialEpisode(a.episodes, want)) { found = true; break; } }
                locateMsg = found ? '（已定位 ' + ext.episode + '，请在作品内点选）' : '（' + ext.episode + ' 请手动选择）';
              } else if (ext.episode) {
                locateMsg = '（已定位 ' + ext.episode + '）';
              }
              ddpSetStatus('🤖 AI 命中 ' + animes.length + ' 部作品' + locateMsg + '，点击载入');
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
      // 黑名单兜底：命中规则 -> 跳过（watchVideo 已对黑名单站点整体不注入，这里防御性兜底）
      if (isUrlBlacklisted()) return;
      // 新站点首次全自动载入：右下角弹窗询问是否加入黑名单（加入逻辑在弹窗内同步完成；6s 超时默认「否」）
      if (blacklistEnabled() && isNewSite()) {
        const choice = await promptNewSiteBlacklist();  // 'root' | 'host' | 'no'
        if (choice === 'root' || choice === 'host') return;  // 已加入黑名单 -> 本次也跳过
        // 'no'（含超时）-> 继续全自动载入
      }
      const title = getPageTitle();
      if (!title || title.length < 2) { showStatus('⚠️ 自动匹配：未获取到可用标题', 6000); return; }
      showStatus('⏳ 自动匹配中…', 0);  // 持续显示，直到结果出来
      try {
        const ext = await llmExtractFileName(title);
        if (!ext || !ext.title) { showStatus('⚠️ 自动匹配：AI 未能从标题提取番剧信息（' + title.slice(0,30) + '…）', 6000); return; }
        const want = parseWantEpisode(ext.episode);
        const isSpecial = want.kind === 'special';
        // 特殊篇（SP/OVA/OAD…）：API 集数过滤会把 SP1 当成正片第1集，故拿全部剧集后客户端定位
        const res = await ddpSearchEpisodes(ext.title, isSpecial ? '' : ext.episode);
        ddpListIsFiltered = !isSpecial;  // 特殊篇未过滤；正片按集号过滤（可能漏集）
        const animes = (res && res.animes) || [];
        // 特殊篇：在每部作品的剧集列表里定位
        let picked = null, pickedAnime = null, pickedScore = 0;
        if (isSpecial && animes.length) {
          for (const a of animes) {
            const r = pickSpecialEpisode(a.episodes, want);
            if (r) { picked = r.ep; pickedAnime = a; pickedScore = r.score; break; }
          }
        }
        // 唯一定位到一集：正片单结果 / 特殊篇定位成功且唯一作品且匹配可信
        const singleMain = !isSpecial && animes.length === 1 && animes[0].episodes && animes[0].episodes.length === 1;
        const confidentSpecial = isSpecial && animes.length === 1 && picked && (want.num == null ? pickedScore >= 50 : pickedScore >= 100);
        if (singleMain || confidentSpecial) {
          const a = isSpecial ? pickedAnime : animes[0];
          const e = isSpecial ? picked : animes[0].episodes[0];
          const label = (a.animeTitle || '') + ' ' + (e.episodeTitle || ext.episode || ('第' + (e.episodeNumber || 1) + '集'));
          let comments;
          try { comments = (await ddpGetComment(e.episodeId)).comments || []; }
          catch (err) { showStatus('⚠️ 自动匹配：拉取弹幕失败（' + err.message + '）', 8000); return; }
          const rawList = ddpCommentsToList(comments);
          if (!rawList.length) { showStatus('⚠️ 自动匹配：' + label + ' 该集暂无弹幕', 6000); return; }
          applyDanmakuList(rawList, label, { seekTo: video.currentTime || 0 });
          putMatchCache(video, { episodeId: e.episodeId, animeTitle: a.animeTitle, episodeTitle: e.episodeTitle });
          showStatus('🎬 自动载入: ' + label + ' · ' + rawList.length + ' 条');
          return;
        }
        // 未定位 / 多结果 -> 打开搜索弹窗让用户手动选
        if (animes.length === 0) {
          showStatus('⚠️ 自动匹配：未搜到「' + ext.title + (ext.episode ? ' ' + ext.episode : '') + '」，请手动搜索', 8000);
          return;
        }
        ddpLastResults = res;       // 缓存搜索结果供弹窗复显
        $('__ddp_kw__').value = ext.title;  // 预填 AI 提取的标题
        renderDdpAnimes(res);       // 渲染作品列表（用户点作品 -> 列剧集 -> 点剧集载入）
        openDdpModal();             // 打开弹窗（会 closeMenu + 聚焦搜索框）
        ddpSetStatus('🤖 AI 命中 ' + animes.length + ' 部作品' + (isSpecial ? '（' + ext.episode + ' 未自动定位，请手动选择）' : '，请选择'));
        showStatus('🤖 自动匹配到多部作品，已弹出列表请选择', 6000);
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
      __lastLabel = label;
      setStatus('✓ ' + label + ' · ' + filtered.length + ' / ' + rawList.length + ' 条', true);  // 持久显示载入信息
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
      $('__dm_shade__').checked = !!s.preventShade;
      // Page 2 高级
      // 描边类型单选：fontBorder 0=重墨(默认) / 1=描边 / 2=45°投影
      const fb = (s.fontBorder == null) ? 0 : s.fontBorder;
      document.querySelectorAll('input[name=fontborder]').forEach(r => { r.checked = (r.value === String(fb)); });
      // 弹幕字体
      const ff = s.fontFamily || "SimHei, 'Microsoft JhengHei', Arial, Helvetica, sans-serif";
      const ffSel = $('__dm_fontfamily__'); if (ffSel) ffSel.value = ff;
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
      // 屏蔽词列表在独立窗口管理，syncUI 不再设 textarea
      $('__dm_recdom__').checked = !!s.isRecyclingDom;
      $('__dm_recmdl__').checked = !!s.isRecyclingModel;
      $('__dm_bindmove__').checked = !!s.canBindMove;
      $('__dm_shrink__').checked = !!s.forbidShrinkState;
    }

    // 持久状态（载入信息）+ 瞬时状态（错误/刷新等）：瞬时消息 4s 后恢复持久信息
    let __lastPersistentStatus = '';
    let __lastLabel = '';
    function setStatus(txt, persistent) {
      const showSave = !!(window.__titanLastDmList && window.__titanLastDmList.length);
      menu.querySelectorAll('.dm-status').forEach(el => {
        el.textContent = txt || '';
        clearTimeout(el.__t);
        if (persistent) {
          __lastPersistentStatus = txt || '';
        } else if (txt) {
          el.__t = setTimeout(() => { el.textContent = __lastPersistentStatus; }, 4000);
        }
      });
      menu.querySelectorAll('.dm-save').forEach(el => { if (showSave) el.removeAttribute('hidden'); else el.setAttribute('hidden', ''); });
    }
    // 保存当前弹幕为 B 站 XML 文件（可被本脚本「载入本地弹幕」再次载入）
    function saveDanmakuFile() {
      const rawList = window.__titanLastDmList;
      if (!rawList || !rawList.length) { setStatus('尚无弹幕可保存'); return; }
      const esc = s => String(s == null ? '' : s).replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
      const body = rawList.map((d, i) => '<d p="' + (d.stime || 0) + ',' + (d.mode || 1) + ',' + (d.size || 25) + ',' + (d.color || 16777215) + ',0,0,' + esc(d.dmid != null && d.dmid !== '' ? d.dmid : ('xml-' + i)) + '">' + esc(d.text) + '</d>').join('\n');
      const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<i>\n' + body + '\n</i>';
      const blob = new Blob([xml], { type: 'application/xml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = ((__lastLabel || 'danmaku').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'danmaku') + '.xml';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    menu.querySelectorAll('.dm-save').forEach(el => el.addEventListener('click', (e) => { e.stopPropagation(); saveDanmakuFile(); }));

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
    $('__dm_shade__').addEventListener('change', e => { engine.setSetting('preventShade', e.target.checked); });
    // 描边类型单选组：0=重墨 1=描边 2=45°投影
    document.querySelectorAll('input[name=fontborder]').forEach(r => {
      r.addEventListener('change', e => { if (e.target.checked) engine.setSetting('fontBorder', +e.target.value); });
    });
    // 弹幕字体
    $('__dm_fontfamily__').addEventListener('change', e => { engine.setSetting('fontFamily', e.target.value); });
    // Page 2 高级
    $('__dm_fssync__').addEventListener('change', e => { engine.setSetting('fullScreenSync', e.target.checked); });
    $('__dm_offtop__').addEventListener('change', e => { engine.setSetting('offsetTop', +e.target.value || 0); });
    $('__dm_offbot__').addEventListener('change', e => { engine.setSetting('offsetBottom', +e.target.value || 0); });
    $('__dm_maxlen__').addEventListener('change', e => { engine.setSetting('maxLength', +e.target.value || 0); });
    // 屏蔽词管理：打开独立窗口
    $('__dm_open_block__').addEventListener('click', () => { closeMenu(); openBlockModal(); });
    // 屏蔽类型图标块：点 div 切换内部 checkbox 并触发 change（checkbox 视觉隐藏，靠 :has 高亮）
    menu.querySelectorAll('.filter-type').forEach(ft => {
      ft.addEventListener('click', (e) => {
        if (e.target.tagName === 'INPUT') return;
        const cb = ft.querySelector('input[type=checkbox]');
        if (cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change', { bubbles: true })); }
      });
    });
    // 屏蔽类型 change：自动立即重载（__numBlk 按 mode 数字精确过滤）
    ['blk_1','blk_4','blk_5','blk_6'].forEach(k => $('__dm_' + k + '__').addEventListener('change', () => {
      const numBlk = [];
      if ($('__dm_blk_1__').checked) numBlk.push(1);
      if ($('__dm_blk_4__').checked) numBlk.push(4);
      if ($('__dm_blk_5__').checked) numBlk.push(5);
      if ($('__dm_blk_6__').checked) numBlk.push(6);
      engine.config.setting.__numBlk = numBlk;
      engine.setSetting('noDanmakuXTypes', []);
      reloadDanmakuPreserveTime();
    }));
    $('__dm_recdom__').addEventListener('change', e => { engine.setSetting('isRecyclingDom', e.target.checked); });
    $('__dm_recmdl__').addEventListener('change', e => { engine.setSetting('isRecyclingModel', e.target.checked); });
    $('__dm_bindmove__').addEventListener('change', e => { engine.setSetting('canBindMove', e.target.checked); });
    $('__dm_shrink__').addEventListener('change', e => { engine.setSetting('forbidShrinkState', e.target.checked); });
    // 面板切换（横版滑动：data-go-page=2 滑到高级，=1 滑回常用）
    menu.addEventListener('click', e => {
      const btn = e.target.closest('[data-go-page]');
      if (!btn) return;
      const p = btn.getAttribute('data-go-page');
      const move = menu.querySelector('.dm-panel-move');
      if (move) move.classList.toggle('slide', p === '2');
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

    // 打开/关闭
    let menuOpen = false;
    // 点击不在 #__titan_dm_btn__ 和 #__titan_dm_menu__ 容器内才关闭
    // （菜单挂到 document.body 而非 btn，所以必须同时检查两个容器）
    const onDocClick = (e) => { if (!e.target.closest('#__titan_dm_btn__, #__titan_dm_menu__')) closeMenu(); };
    // Esc 关弹窗（优先）或菜单（onKey 仅在菜单打开期间注册）
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (blacklistModal.classList.contains('open')) closeBlacklistModal();
      else if (settingsModal.classList.contains('open')) closeSettingsModal();
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

    // 暴露 setStatus / openSettings 给 console 调试 + 油猴菜单
    if (window.__titan) { window.__titan.setStatus = setStatus; window.__titan.openSettings = openSettingsModal; }
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

  // 新站点首次全自动载入前的询问浮层（右下角）。返回 Promise<'root'|'host'|'no'>。
  // 6s 进度条走完自动向右滑出关闭并默认选「否」；点击任一按钮立即执行并滑出。
  // 用共享 Promise 去重：同一时刻只弹一个，并发调用复用同一个结果。
  let __newSitePromptPromise = null;
  function promptNewSiteBlacklist() {
    if (__newSitePromptPromise) return __newSitePromptPromise;
    __newSitePromptPromise = new Promise((resolve) => {
      const host = location.hostname || '';
      const root = getRootDomain(host);
      let el = document.getElementById('__titan_dm_newsite');
      if (el) el.remove();
      el = document.createElement('div');
      el.id = '__titan_dm_newsite';
      el.innerHTML =
        '<div class="ns-msg">检测到这个新站点中有视频元素，是否要将其加入黑名单？</div>' +
        '<div class="ns-btns">' +
          '<button type="button" class="ns-btn" data-act="root">根域名<span class="ns-sub">' + root + '</span></button>' +
          '<button type="button" class="ns-btn" data-act="host">仅当前域名<span class="ns-sub">' + host + '</span></button>' +
          '<button type="button" class="ns-btn ns-no" data-act="no">否</button>' +
        '</div>' +
        '<div class="ns-bar"><i></i></div>';
      document.body.appendChild(el);
      // 入场（下一帧加 show 触发过渡）
      requestAnimationFrame(() => el.classList.add('show'));

      let done = false;
      const finish = (act) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        // 加入黑名单的逻辑直接在此同步执行（不依赖调用方 async 续行，避免续行丢失导致未保存）
        markSiteSeen(root);  // 无论选什么，标记已访问，避免重复打扰
        let added = false;
        if (act === 'root') {
          addBlacklistPatterns(['*://*.' + root + '/*', '*://' + root + '/*']);
          showStatus('🚫 已将 ' + root + ' 加入黑名单，即将刷新生效…', 6000);
          added = true;
        } else if (act === 'host') {
          addBlacklistPatterns(['*://' + host + '/*']);
          showStatus('🚫 已将 ' + host + ' 加入黑名单，即将刷新生效…', 6000);
          added = true;
        }
        el.classList.remove('show');
        el.classList.add('hide');  // 向右滑出
        setTimeout(() => { if (el.parentNode) el.remove(); }, 320);
        __newSitePromptPromise = null;
        resolve(act);
        // 加入黑名单后刷新页面，让拦截立即生效（刷新后 watchVideo 重跑 -> isUrlBlacklisted 命中 -> 不注入弹幕）
        if (added) setTimeout(() => { try { location.reload(); } catch (e) {} }, 700);
      };
      el.querySelectorAll('.ns-btn').forEach(b => b.addEventListener('click', () => finish(b.getAttribute('data-act'))));
      const timer = setTimeout(() => finish('no'), 6000);  // 进度条走完 -> 默认「否」
    });
    return __newSitePromptPromise;
  }

  // ============= 主流程：MutationObserver 监听 video 出现 =============
  let activeEngine = null;
  let initingVideo = null;  // 初始化锁：标记当前正在 init 的 video，防止并发 tryInit 竞态

  // 清理当前活跃引擎 + 所有 UI 元素（换集/PJAX 导航时调用）
  function cleanupEngine() {
    if (activeEngine) {
      try { activeEngine.__titanCleanup(); } catch (e) {}
      activeEngine = null;
    }
    initingVideo = null;  // 清理时一并释放初始化锁
    // 注：通用设置/黑名单 UI（__titan_dm_settings/__titan_dm_modal_mask/__titan_dm_blacklist/__titan_dm_bl_mask）
    //   由 ensureSettingsUI 管理（引擎无关、幂等），不随引擎清理，换集/导航后仍可打开。
    ['__titan_dm_btn__','__titan_dm_menu__','__titan_dm_block','__titan_dm_block_mask','__titan_dm_ddp_search','__titan_dm_ddp_mask','__titan_roll_layer__','__titan_cmd_layer__','__titan_rotate_layer__','__titan_status__']
      .forEach(id => { const e = document.getElementById(id); if (e) e.remove(); });
  }

  function watchVideo() {
    // 黑名单站点：整体不注入（不显示弹幕图标、不显示「正在匹配」等消息）
    if (isUrlBlacklisted()) return;
    const tryInit = async (video) => {
      if (video.__titanBound) return;
      if (initingVideo) return;  // 已有 init 进行中，跳过（避免并发：await getEngine 期间又触发一次）
      initingVideo = video;
      // 如果已有活跃引擎（上一个视频），先清理
      cleanupEngine();
      initingVideo = video;  // cleanupEngine 清了锁，重新设回
      video.__titanBound = true;
      try {
        const adapter = createAdapter(video);
        const engine = await getEngine(video, adapter);
        // await 期间可能被并发清理（cleanupEngine 把 activeEngine 置 null）→ 检查是否仍是本次 init
        if (initingVideo !== video) { try { engine.__titanCleanup && engine.__titanCleanup(); } catch(e){} return; }
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
            // 同步菜单状态行（持久显示载入信息 + 露出「保存弹幕」）
            if (window.__titan && typeof window.__titan.setStatus === 'function') {
              window.__titan.setStatus('✓ ' + (resume.label || '已恢复弹幕') + ' · ' + filtered.length + ' / ' + resume.rawList.length + ' 条', true);
            }
          } catch (e) { showStatus('⚠️ 恢复失败: ' + e.message); }
          clearResume();
        } else {
          const dmLoaded = await autoLoad(engine, video, adapter);
          // 全自动载入：同目录弹幕没命中（autoLoad 返回 false）时才走远程 AI 匹配
          if (!dmLoaded && engine.__titanAutoMatch) {
            engine.__titanAutoMatch();
          }
          if (resume.ts) clearResume();  // 清掉过期恢复标记
        }
      } catch (e) {
        console.error('[web-danmaku-plugin] init failed:', e);
        showStatus('Titan 初始化失败: ' + e.message, 8000);
        console.error('[web-danmaku-plugin] 堆栈:', e.stack);
      } finally {
        if (initingVideo === video) initingVideo = null;  // 释放锁
      }
    };

    // 扫描页面所有未绑定的 <video>，逐个 init。
    // retries：SPA 页面 video 可能是异步创建的（如 ArtPlayer 动态挂载），
    //   没扫到就每隔 300ms 重试，最多 5 次（1.5s 窗口覆盖异步初始化）。
    const scanVideos = (retries) => {
      let found = false;
      document.querySelectorAll('video').forEach(v => {
        if (!v.__titanBound && (v.currentSrc || v.src)) {
          tryInit(v);
          // tryInit 真正进入初始化会同步设 __titanBound=true；若被锁挡住返回早退则 __titanBound 仍 false → 继续 retry
          if (v.__titanBound) found = true;
        }
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
          // 正在初始化中的 video 忽略其 src 变化（播放器初始化常多次设 src，会打断 init）
          if (initingVideo === m.target) continue;
          // 只对已绑定的 video 触发换源重载（真实切视频）；未绑定的交给 scanVideos
          if (m.target.__titanBound) { m.target.__titanBound = false; hasSrcChange = true; }
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

  // 油猴菜单：尽早注册（任意页面可用，方便调试与解封）。放在最前，
  // 确保后续 injectCSS/watchVideo 即使抛错也不影响菜单可用。
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('⚙ 通用设置', openSettingsModal);
  }

  injectCSS();  // 尽早注入样式（含黑名单/无视频页面，供油猴菜单打开设置时使用）

  try {
    const startWatch = () => { try { watchVideo(); } catch (e) { console.error('[web-danmaku-plugin] watchVideo error:', e); } };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', startWatch);
    } else {
      startWatch();
    }
  } catch (e) { console.error('[web-danmaku-plugin] init error:', e); }

  // 暴露核心函数供 dev/test 端到端验证（生产环境无害，单一命名空间）
  window.__titan = { injectControls: injectDanmakuControls, getEngine, createAdapter, parseAny, parseDandanplayApi, ddpCommentsToList, filePathFromVideo, getPageTitle, loadDdpConfig, saveDdpConfig, ddpSearchEpisodes, ddpGetComment, ddpMatch, loadMatchCache, saveMatchCache, getMatchCache, putMatchCache, clearMatchCache, matchCacheKeyOf, loadAiConfig, saveAiConfig, aiReady, aiEnabled, autoMatchEnabled, llmExtractFileName, loadResume, saveResume, clearResume, loadBlacklist, saveBlacklist, blacklistEnabled, isUrlBlacklisted, getRootDomain, isNewSite, markSiteSeen, promptNewSiteBlacklist, pageTitleSnapshot: _PAGE_TITLE_SNAPSHOT, engine: null, adapter: null, setStatus: null, openSettings: openSettingsModal };
})();
