// ==UserScript==
// @name         抖音直播飘屏弹幕关键词屏蔽
// @namespace    https://github.com/Evil-artc/Tampermonkey-script
// @version      1.4.0
// @description  网页端抖音直播间屏蔽视频上飘屏弹幕里包含指定关键词的消息。基于真实通信结构编写：飘屏弹幕由主线程通过 Worker.postMessage({method:"addBarrage", params:{content:[{type:"text",text:"..."}]}}) 发给渲染 Worker，脚本在发送前按关键词拦截，命中则不转发，弹幕永不渲染。另含“一键全关弹幕层”兜底。
// @author       只剩寒暄
// @match        https://live.douyin.com/*
// @match        https://www.douyin.com/follow/live/*
// @match        https://www.douyin.com/live/*
// @run-at       document-start
// @grant        none
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  // 关键：@grant none 时本脚本运行在页面真实世界(main world)，
  // 因此下面修改的 Worker.prototype.postMessage 对页面代码真实生效。
  // （旧版用 @grant GM_* 会被 Tampermonkey 关进沙箱 isolated world，
  //   window.Worker 的替换只改到沙箱里，页面看不到，导致关键词失效。）

  const KW_KEY  = 'douyin_danmaku_block_keywords';
  const OPT_KEY = 'douyin_danmaku_block_opts';
  const ON_KEY  = 'douyin_danmaku_block_enabled';
  const ALL_KEY = 'douyin_danmaku_block_all';

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  };

  let keywords = (store.get(KW_KEY, '') || '').split('\n').map(s => s.trim()).filter(Boolean);
  let enabled  = store.get(ON_KEY, '1') !== '0';
  let blockAll = store.get(ALL_KEY, '0') === '1';
  let opts = Object.assign({ caseSensitive: false, regex: false }, JSON.parse(store.get(OPT_KEY, '{}') || '{}'));

  let blockedCount = 0;
  const updateBadgeCbs = [];

  function isBlocked(text) {
    if (!text) return false;
    const t = opts.caseSensitive ? text : text.toLowerCase();
    for (const raw of keywords) {
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

  // 从 addBarrage 消息里提取完整弹幕文本（昵称+内容都在 content 里）
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
  // 直接在 main world 包装 Worker.prototype.postMessage，
  // 并额外包装构造函数以防抖音缓存了原型引用。
  function installWorkerHook() {
    if (typeof Worker === 'undefined') return;

    try {
      const origPost = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (msg, transfer) {
        if (enabled && msg && typeof msg === 'object' && msg.method === 'addBarrage') {
          const txt = barrageText(msg);
          if (txt && isBlocked(txt)) {
            blockedCount++;
            updateBadgeCbs.forEach(cb => cb());
            return; // 命中关键词 -> 丢弃，不转发给渲染 Worker，弹幕永不绘制
          }
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
            if (txt && isBlocked(txt)) {
              blockedCount++;
              updateBadgeCbs.forEach(cb => cb());
              return;
            }
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

  // ============ 兜底：一键全关弹幕层 ============
  function applyBlockAll() {
    const layer = document.getElementById('DanmakuLayout');
    if (layer) layer.style.display = blockAll ? 'none' : '';
  }

  // ============ 单一面板 UI ============
  function buildUI() {
    const style = document.createElement('style');
    style.textContent = `
      #dd-panel{position:fixed;top:64px;right:14px;z-index:2147483647;width:300px;
        background:rgba(28,31,35,.96);backdrop-filter:blur(6px);color:#e8eaed;
        border:1px solid #3a3f47;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.45);
        font-size:13px;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;overflow:hidden;}
      #dd-panel *{box-sizing:border-box;}
      #dd-panel .dd-hd{display:flex;align-items:center;gap:8px;padding:9px 12px;background:#272b30;
        cursor:move;user-select:none;}
      #dd-panel .dd-ic{font-size:15px;}
      #dd-panel .dd-hd b{font-size:14px;font-weight:600;flex:1;}
      #dd-panel .dd-badge{font-size:11px;color:#9aa0a6;background:#1c1f23;border:1px solid #3a3f47;
        border-radius:10px;padding:1px 8px;white-space:nowrap;}
      #dd-panel .dd-toggle{cursor:pointer;color:#9aa0a6;transition:transform .15s;font-size:12px;}
      #dd-panel.open .dd-toggle{transform:rotate(180deg);}
      #dd-panel .dd-bd{padding:10px 12px;display:none;border-top:1px solid #3a3f47;}
      #dd-panel.open .dd-bd{display:block;}
      #dd-panel.off .dd-hd{opacity:.7;}
      #dd-panel textarea{width:100%;height:110px;resize:vertical;background:#11141a;color:#e8eaed;
        border:1px solid #3a3f47;border-radius:8px;padding:8px;font-size:12px;line-height:1.5;}
      #dd-panel textarea:focus{outline:none;border-color:#2f6bff;}
      #dd-panel .dd-row{display:flex;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap;}
      #dd-panel label{display:flex;align-items:center;gap:4px;cursor:pointer;font-size:12px;}
      #dd-panel button{background:#2f6bff;color:#fff;border:0;border-radius:8px;padding:6px 14px;
        cursor:pointer;font-size:12px;transition:background .15s;}
      #dd-panel button:hover{background:#1f5af0;}
      #dd-panel button.sec{background:#3a3f47;}
      #dd-panel button.sec:hover{background:#474d56;}
      #dd-panel .dd-stat{margin-top:9px;color:#9aa0a6;font-size:12px;line-height:1.6;}
    `;
    document.head.appendChild(style);

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
        <textarea id="dd-kw" placeholder="每行一个关键词，支持通配请用正则模式&#10;例：&#10;广告&#10;加微信&#10;引流"></textarea>
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
          <button id="dd-reset" class="sec">清空</button>
        </div>
        <div class="dd-stat" id="dd-stat"></div>
      </div>`;
    document.body.appendChild(panel);

    const ta = panel.querySelector('#dd-kw');
    const elOn = panel.querySelector('#dd-on');
    const elRe = panel.querySelector('#dd-re');
    const elCi = panel.querySelector('#dd-ci');
    const elAll = panel.querySelector('#dd-all');
    const badge = panel.querySelector('#dd-badge');
    const stat = panel.querySelector('#dd-stat');

    function syncInputs() {
      ta.value = keywords.join('\n');
      elOn.checked = enabled;
      elRe.checked = opts.regex;
      elCi.checked = opts.caseSensitive;
      elAll.checked = blockAll;
      updateBadge();
    }
    function updateBadge() {
      const active = enabled || blockAll;
      panel.classList.toggle('off', !active);
      badge.textContent = active ? ('已拦 ' + blockedCount) : '已关';
      stat.innerHTML = `状态：${enabled ? '关键词过滤中' : '已关闭'} ｜ 全关：${blockAll ? '开' : '关'}<br>关键词：${keywords.length} 个 ｜ 已屏蔽弹幕：${blockedCount} 条`;
    }
    updateBadgeCbs.push(updateBadge);

    // 标题栏：展开/收起 + 拖拽
    panel.querySelector('.dd-hd').addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      panel.classList.toggle('open');
    });

    panel.querySelector('#dd-save').addEventListener('click', () => {
      keywords = ta.value.split('\n').map(s => s.trim()).filter(Boolean);
      enabled = elOn.checked;
      opts.regex = elRe.checked;
      opts.caseSensitive = elCi.checked;
      blockAll = elAll.checked;
      store.set(KW_KEY, keywords.join('\n'));
      store.set(ON_KEY, enabled ? '1' : '0');
      store.set(OPT_KEY, JSON.stringify(opts));
      store.set(ALL_KEY, blockAll ? '1' : '0');
      applyBlockAll();
      updateBadge();
    });

    panel.querySelector('#dd-reset').addEventListener('click', () => {
      ta.value = '';
      keywords = [];
      store.set(KW_KEY, '');
      updateBadge();
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

  // ============ 启动 ============
  if (document.body) buildUI();
  else document.addEventListener('DOMContentLoaded', () => { buildUI(); applyBlockAll(); });
  setInterval(() => { if (blockAll) applyBlockAll(); }, 2000);
})();
