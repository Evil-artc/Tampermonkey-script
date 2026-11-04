// ==UserScript==
// @name         抖音直播飘屏弹幕关键词屏蔽
// @namespace    https://github.com/
// @version      1.9.3
// @description  网页端抖音直播间屏蔽视频上飘屏弹幕里包含指定关键词的消息。支持"全局关键词(所有直播间)"与"当前直播间关键词(仅本房间)"两套规则。基于真实通信结构：飘屏弹幕由主线程通过 Worker.postMessage({method:"addBarrage", params:{content:[{type:"text",text:"..."}]}}) 发给渲染 Worker，脚本在发送前按关键词拦截，命中则不转发，弹幕永不渲染。v1.9.3：修复 www.douyin.com/follow/live/* 下房间 id 解析为"www.douyin.com/"(SPA 启动占位)的问题——改为动态获取房间 id(建面板前与每轮上下文守卫/SPA 路由切换时刷新)，并补充 room_id 参数与 pathname 段兜底。
// @author       只剩寒暄
// @match        https://live.douyin.com/*
// @match        https://www.douyin.com/follow/live/*
// @match        https://www.douyin.com/live/*
// @match        https://*.douyin.com/*
// @match        blob:*
// @run-at       document-start
// @grant        none
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  // 兼容：若脚本被注入到 Worker(无 document) 或非常规环境，直接退出，避免报错
  if (typeof window === 'undefined' || typeof document === 'undefined' || !document.getElementById) return;

  // @grant none => 本脚本运行在页面真实世界(main world)，下面改的 Worker.prototype.postMessage 对页面代码真实生效。

  const KW_KEY      = 'douyin_danmaku_block_keywords';
  const ROOM_KW_KEY = 'douyin_danmaku_block_room_keywords';
  const OPT_KEY     = 'douyin_danmaku_block_opts';
  const ON_KEY      = 'douyin_danmaku_block_enabled';
  const ALL_KEY     = 'douyin_danmaku_block_all';
  const CLAIM_KEY   = 'dd_ui_claim';

  function cookieGet(k) {
    try {
      const m = document.cookie.match(new RegExp('(?:^|; )' + k + '=([^;]*)'));
      return m ? decodeURIComponent(m[1]) : null;
    } catch (e) { return null; }
  }
  function cookieSet(k, v, maxAge) {
    try { document.cookie = k + '=' + encodeURIComponent(v) + '; domain=.douyin.com; path=/; max-age=' + (maxAge || 31536000); } catch (e) {}
  }
  const store = {
    get(k, d) {
      const c = cookieGet(k);
      if (c != null) return c;
      try { const l = localStorage.getItem(k); if (l != null) return l; } catch (e) {}
      return d;
    },
    set(k, v) { cookieSet(k, v); try { localStorage.setItem(k, v); } catch (e) {} },
  };

  function parseList(s) { return (s || '').split('\n').map(x => x.trim()).filter(Boolean); }
  function safeParse(s, d) { try { const o = JSON.parse(s); return (o && typeof o === 'object') ? o : d; } catch (e) { return d; } }

  function getRoomId() {
    try {
      const href = location.href;
      const m = href.match(/live\.douyin\.com\/(\d+)/)
            || href.match(/follow\/live\/(\d+)/)
            || href.match(/douyin\.com\/live\/(\d+)/);
      if (m) return m[1];
      const q = href.match(/[?&]room_id=(\d+)/);
      if (q) return q[1];
      // www.douyin.com/follow/live/<id> 兜底：从 pathname 段直接取
      const seg = location.pathname.split('/').filter(Boolean);
      const i = seg.indexOf('live');
      if (i >= 0 && seg[i - 1] === 'follow' && seg[i + 1]) return seg[i + 1];
    } catch (e) {}
    return location.host + location.pathname;
  }
  // id 动态获取：抖音是大 SPA，脚本启动那一刻 URL 可能仍是 www.douyin.com/，
  // 正则匹配不到会掉进兜底返回 host+path；故后续在 tryHost / enforceContext 中持续刷新。
  let roomId = getRoomId();

  let globalKeywords = parseList(store.get(KW_KEY, ''));
  let roomMap = safeParse(store.get(ROOM_KW_KEY, '{}'), {});
  let roomKeywords = Array.isArray(roomMap[roomId]) ? roomMap[roomId].slice() : [];
  let enabled  = store.get(ON_KEY, '1') !== '0';
  let blockAll = store.get(ALL_KEY, '0') === '1';
  let opts = Object.assign({ caseSensitive: false, regex: false }, safeParse(store.get(OPT_KEY, '{}'), {}));

  let blockedCount = 0;
  const updateBadgeCbs = [];

  // ============ 跨帧配置同步（仅广播配置，不再协调“谁建 UI”）============
  function broadcastConfig() {
    const payload = { __dd_cfg: 1, roomId, globalKeywords, roomMap, opts, enabled, blockAll };
    try {
      for (let i = 0; i < window.frames.length; i++) {
        try { window.frames[i].postMessage(payload, '*'); } catch (e) {}
      }
    } catch (e) {}
    try { window.top.postMessage(payload, '*'); } catch (e) {}
  }
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d) return;
    if (d.__dd_cfg) {
      globalKeywords = Array.isArray(d.globalKeywords) ? d.globalKeywords : globalKeywords;
      roomMap = (d.roomMap && typeof d.roomMap === 'object') ? d.roomMap : roomMap;
      opts = Object.assign({}, opts, d.opts || {});
      if (typeof d.enabled === 'boolean') enabled = d.enabled;
      if (typeof d.blockAll === 'boolean') blockAll = d.blockAll;
      roomKeywords = Array.isArray(roomMap[roomId]) ? roomMap[roomId].slice() : [];
      applyBlockAll();
      updateBadgeCbs.forEach(cb => cb());
    }
  });

  // ============ 匹配逻辑 ============
  function matchList(text, list) {
    if (!list || !list.length) return false;
    const t = opts.caseSensitive ? text : text.toLowerCase();
    for (const raw of list) {
      if (!raw) continue;
      if (opts.regex) {
        try { if (new RegExp(raw, opts.caseSensitive ? '' : 'i').test(text)) return true; } catch (e) {}
      } else {
        const k = opts.caseSensitive ? raw : raw.toLowerCase();
        if (t.includes(k)) return true;
      }
    }
    return false;
  }
  function isBlocked(text) {
    if (!text) return false;
    return matchList(text, globalKeywords) || matchList(text, roomKeywords);
  }
  function barrageText(msg) {
    try {
      const p = msg && msg.params;
      if (!p) return '';
      const content = p.content;
      if (Array.isArray(content)) {
        return content.map(c => (c && (c.text != null ? c.text : (c.src || ''))).toString()).join(' ');
      }
      return JSON.stringify(msg);
    } catch (e) { return ''; }
  }

  // ============ 核心：拦截发给渲染 Worker 的 addBarrage 消息 ============
  function installWorkerHook() {
    if (typeof Worker === 'undefined') return;
    try {
      const origPost = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (msg, transfer) {
        if (enabled && msg && typeof msg === 'object' && msg.method === 'addBarrage') {
          const txt = barrageText(msg);
          if (txt && isBlocked(txt)) { blockedCount++; updateBadgeCbs.forEach(cb => cb()); return; }
        }
        return origPost.apply(this, arguments);
      };
    } catch (e) {}
    try {
      const OrigWorker = Worker;
      const Wrapped = function (url, o) {
        const w = new OrigWorker(url, o);
        const op = w.postMessage.bind(w);
        w.postMessage = function (msg, transfer) {
          if (enabled && msg && typeof msg === 'object' && msg.method === 'addBarrage') {
            const txt = barrageText(msg);
            if (txt && isBlocked(txt)) { blockedCount++; updateBadgeCbs.forEach(cb => cb()); return; }
          }
          return op(msg, transfer);
        };
        return w;
      };
      Wrapped.prototype = OrigWorker.prototype;
      window.Worker = Wrapped;
    } catch (e) {}
  }
  installWorkerHook();

  function applyBlockAll() {
    const layer = document.getElementById('DanmakuLayout');
    if (layer) layer.style.display = blockAll ? 'none' : '';
  }

  // ============ UI 挂载：先到先得 + 播放器帧优先 ============
  const myId = Math.random().toString(36).slice(2);
  let uiHosted = false;
  let claimedByOther = null;
  let panelNode = null;

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || !d.__dd_claim) return;
    claimedByOther = d.id;
    if (uiHosted && d.id !== myId) {
      const p = document.getElementById('dd-panel');
      if (p) { p.remove(); uiHosted = false; panelNode = null; }
    }
  });
  function announceClaim() {
    uiHosted = true;
    store.set(CLAIM_KEY, myId + ':' + Date.now());
    try {
      for (let i = 0; i < window.frames.length; i++) { try { window.frames[i].postMessage({ __dd_claim: { id: myId } }, '*'); } catch (e) {} }
    } catch (e) {}
    try { if (window !== window.top) window.parent.postMessage({ __dd_claim: { id: myId } }, '*'); } catch (e) {}
  }

  function playerFrameElsewhere() {
    try {
      for (const f of window.frames) { try { if (f.document.getElementById('DanmakuLayout')) return true; } catch (e) {} }
    } catch (e) {}
    return false;
  }

  function isLiveContext() {
    return /live\.douyin\.com|follow\/live|\/live\//.test(location.href) || !!document.getElementById('DanmakuLayout');
  }

  function tryHost() {
    if (uiHosted && document.getElementById('dd-panel')) return;
    if (!document.body) return;
    if (document.getElementById('dd-panel')) { uiHosted = true; return; }
    if (claimedByOther && claimedByOther !== myId) return; // 别人已认领
    if (!isLiveContext()) return;                          // 仅直播间页面才建面板
    // SPA 下 URL/roomId 可能晚于脚本启动才确定，建面板前刷新一次，避免 id 仍是 host+path 兜底值
    const newId = getRoomId();
    if (newId !== roomId) {
      roomId = newId;
      roomKeywords = Array.isArray(roomMap[roomId]) ? roomMap[roomId].slice() : [];
    }
    const isPlayer = !!document.getElementById('DanmakuLayout');
    if (isPlayer) { buildUI(); announceClaim(); return; }
    if (window === window.top && !playerFrameElsewhere()) { buildUI(); announceClaim(); }
  }

  function buildUI() {
    if (document.getElementById('dd-panel')) { panelNode = document.getElementById('dd-panel'); return; }
    let style = document.getElementById('dd-style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'dd-style';
      style.textContent = `
        #dd-panel{position:fixed;top:64px;right:14px;z-index:2147483647;width:300px;
          background:rgba(28,31,35,.96);backdrop-filter:blur(6px);color:#e8eaed;
          border:1px solid #3a3f47;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.45);
          font-size:13px;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;overflow:hidden;}
        #dd-panel *{box-sizing:border-box;}
        #dd-panel .dd-hd{display:flex;align-items:center;gap:8px;padding:9px 12px;background:#272b30;cursor:move;user-select:none;}
        #dd-panel .dd-ic{font-size:15px;}
        #dd-panel .dd-hd b{font-size:14px;font-weight:600;flex:1;}
        #dd-panel .dd-badge{font-size:11px;color:#9aa0a6;background:#1c1f23;border:1px solid #3a3f47;
          border-radius:10px;padding:1px 8px;white-space:nowrap;}
        #dd-panel .dd-toggle{cursor:pointer;color:#9aa0a6;transition:transform .15s;font-size:12px;}
        #dd-panel.open .dd-toggle{transform:rotate(180deg);}
        #dd-panel .dd-bd{padding:10px 12px;display:none;border-top:1px solid #3a3f47;}
        #dd-panel.open .dd-bd{display:block;}
        #dd-panel.off .dd-hd{opacity:.7;}
        #dd-panel .dd-room{font-size:11px;color:#9aa0a6;margin-bottom:6px;word-break:break-all;}
        #dd-panel .dd-lbl{display:block;font-size:12px;color:#9aa0a6;margin:8px 0 4px;}
        #dd-panel .dd-lbl .dd-clr{float:right;color:#2f6bff;cursor:pointer;}
        #dd-panel .dd-clr{cursor:pointer;color:#2f6bff;font-size:12px;}
        #dd-panel .dd-clr:hover{text-decoration:underline;}
        #dd-panel textarea{width:100%;height:84px;resize:vertical;background:#11141a;color:#e8eaed;
          border:1px solid #3a3f47;border-radius:8px;padding:8px;font-size:12px;line-height:1.5;}
        #dd-panel textarea:focus{outline:none;border-color:#2f6bff;}
        #dd-panel .dd-row{display:flex;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap;}
        #dd-panel label{display:flex;align-items:center;gap:4px;cursor:pointer;font-size:12px;}
        #dd-panel button{background:#2f6bff;color:#fff;border:0;border-radius:8px;padding:6px 14px;
          cursor:pointer;font-size:12px;transition:background .15s;}
        #dd-panel button:hover{background:#1f5af0;}
        #dd-panel .dd-stat{margin-top:9px;color:#9aa0a6;font-size:12px;line-height:1.6;}`;
      (document.head || document.documentElement).appendChild(style);
    }

    const panel = document.createElement('div');
    panel.id = 'dd-panel';
    panel.innerHTML = `
      <div class="dd-hd">
        <span class="dd-ic">🚫</span>
        <b>弹幕屏蔽</b>
        <span class="dd-badge" id="dd-badge">已拦 0</span>
        <span class="dd-toggle">▾</span>
      </div>
      <div class="dd-bd">
        <div class="dd-room">当前直播间：<span id="dd-room">--</span></div>
        <label class="dd-lbl">全局关键词（所有直播间）</label>
        <textarea id="dd-kw-global" placeholder="对所有直播间生效，每行一个关键词&#10;例：广告 / 加微信 / 引流"></textarea>
        <label class="dd-lbl">本直播间关键词 <span class="dd-clr" id="dd-clr-room">清空</span></label>
        <textarea id="dd-kw-room" placeholder="仅对当前直播间生效，每行一个"></textarea>
        <div class="dd-row">
          <label><input type="checkbox" id="dd-on"> 启用关键词</label>
          <label><input type="checkbox" id="dd-re"> 正则</label>
          <label><input type="checkbox" id="dd-ci"> 区分大小写</label>
        </div>
        <div class="dd-row">
          <label><input type="checkbox" id="dd-all"> 一键全关飘屏弹幕</label>
        </div>
        <div class="dd-row">
          <button id="dd-save">保存</button>
          <span class="dd-clr" id="dd-clr-global">清空全局</span>
        </div>
        <div class="dd-stat" id="dd-stat"></div>
      </div>`;
    (document.body || document.documentElement).appendChild(panel);
    panelNode = panel;

    const taG = panel.querySelector('#dd-kw-global');
    const taR = panel.querySelector('#dd-kw-room');
    const elRoom = panel.querySelector('#dd-room');
    const elOn = panel.querySelector('#dd-on');
    const elRe = panel.querySelector('#dd-re');
    const elCi = panel.querySelector('#dd-ci');
    const elAll = panel.querySelector('#dd-all');
    const badge = panel.querySelector('#dd-badge');
    const stat = panel.querySelector('#dd-stat');

    function updateBadge() {
      const active = enabled || blockAll;
      panel.classList.toggle('off', !active);
      badge.textContent = active ? ('已拦 ' + blockedCount) : '已关';
      stat.innerHTML = `状态：${enabled ? '关键词过滤中' : '已关闭'} ｜ 全关：${blockAll ? '开' : '关'}<br>全局：${globalKeywords.length} 个 ｜ 本间：${roomKeywords.length} 个 ｜ 已屏蔽：${blockedCount} 条`;
    }
    updateBadgeCbs.push(updateBadge);

    function syncInputs() {
      elRoom.textContent = roomId;
      taG.value = globalKeywords.join('\n');
      taR.value = roomKeywords.join('\n');
      elOn.checked = enabled;
      elRe.checked = opts.regex;
      elCi.checked = opts.caseSensitive;
      elAll.checked = blockAll;
      updateBadge();
    }

    panel.querySelector('.dd-hd').addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      panel.classList.toggle('open');
    });
    panel.querySelector('#dd-save').addEventListener('click', () => {
      globalKeywords = parseList(taG.value);
      roomKeywords = parseList(taR.value);
      enabled = elOn.checked;
      opts.regex = elRe.checked;
      opts.caseSensitive = elCi.checked;
      blockAll = elAll.checked;
      if (roomKeywords.length) roomMap[roomId] = roomKeywords.slice();
      else delete roomMap[roomId];
      store.set(KW_KEY, globalKeywords.join('\n'));
      store.set(ROOM_KW_KEY, JSON.stringify(roomMap));
      store.set(OPT_KEY, JSON.stringify(opts));
      store.set(ON_KEY, enabled ? '1' : '0');
      store.set(ALL_KEY, blockAll ? '1' : '0');
      applyBlockAll();
      updateBadge();
      broadcastConfig();
    });
    panel.querySelector('#dd-clr-global').addEventListener('click', () => {
      globalKeywords = []; taG.value = ''; store.set(KW_KEY, ''); updateBadge();
    });
    panel.querySelector('#dd-clr-room').addEventListener('click', () => {
      roomKeywords = []; taR.value = ''; delete roomMap[roomId]; store.set(ROOM_KW_KEY, JSON.stringify(roomMap)); updateBadge();
    });

    let drag = null;
    panel.querySelector('.dd-hd').addEventListener('mousedown', (e) => {
      const r = panel.getBoundingClientRect();
      drag = { x: e.clientX - r.left, y: e.clientY - r.top };
    });
    window.addEventListener('mousemove', (e) => {
      if (!drag) return;
      panel.style.left = (e.clientX - drag.x) + 'px';
      panel.style.top = (e.clientY - drag.y) + 'px';
      panel.style.right = 'auto';
    });
    window.addEventListener('mouseup', () => { drag = null; });

    syncInputs();
  }

  // 立即尝试 + 监听弹幕层出现 + 看门狗
  tryHost();
  document.addEventListener('DOMContentLoaded', tryHost);
  setInterval(tryHost, 1500);
  if (window === window.top) setTimeout(tryHost, 2500);
  try {
    const mo = new MutationObserver(() => { tryHost(); });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}
  // 上下文守卫：退出直播间(URL 不是 live/follow/live 且无 #DanmakuLayout)时收起面板；
  // 回到直播间时自动重建。抖音是大 SPA，切出直播间是客户端路由切换、不会整页刷新，
  // 故需主动监听路由并周期检查，否则面板会一直挂在非直播页上。
  function enforceContext() {
    try {
      // 持续刷新房间 id：SPA 路由变化后 URL 才确定，需重新解析并同步面板
      const newId = getRoomId();
      if (newId !== roomId) {
        roomId = newId;
        roomKeywords = Array.isArray(roomMap[roomId]) ? roomMap[roomId].slice() : [];
        const elRoom = document.querySelector('#dd-room');
        if (elRoom) elRoom.textContent = roomId;
        const taR = document.querySelector('#dd-kw-room');
        if (taR) taR.value = roomKeywords.join('\n');
        updateBadgeCbs.forEach(cb => cb());
      }
      const active = isLiveContext();
      const panel = document.getElementById('dd-panel');
      if (!active) {
        if (panel) panel.remove();
        panelNode = null;
        uiHosted = false;
        claimedByOther = null;
      } else if (!panel) {
        tryHost();
        if (blockAll) applyBlockAll();
      }
    } catch (e) {}
  }
  // 面板防冲掉：若已建但被页面重绘移除，自动重新挂回同一节点(监听器保留)
  setInterval(() => {
    if (uiHosted && panelNode && !document.getElementById('dd-panel')) {
      try { (document.body || document.documentElement).appendChild(panelNode); } catch (e) {}
    }
    if (blockAll) applyBlockAll();
    enforceContext();
  }, 1500);
  // 监听 SPA 路由变化，及时收起/重建面板
  try {
    const _ps = history.pushState, _rs = history.replaceState;
    history.pushState = function () { const r = _ps.apply(this, arguments); try { setTimeout(enforceContext, 0); } catch (e) {} return r; };
    history.replaceState = function () { const r = _rs.apply(this, arguments); try { setTimeout(enforceContext, 0); } catch (e) {} return r; };
    window.addEventListener('popstate', enforceContext);
    window.addEventListener('hashchange', enforceContext);
  } catch (e) {}
  if (window === window.top) setTimeout(broadcastConfig, 1500);
})();
