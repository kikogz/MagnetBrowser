// preload.js — 访客预加载（运行在目标站点页内）
// 职责：磁力链接识别 + 悬停悬浮提示 + 按规则删除指定栏目/广告
(function () {
  'use strict';
  const { ipcRenderer } = require('electron');

  const MAGNET_RE = /magnet:\?xt=urn:btih:([a-z0-9]{32,40})/i;

  // 解析磁力串参数
  function parseMagnet(uri) {
    const out = { uri: uri, hash: '', name: '(未知名称)', trackers: 0, size: null };
    try {
      const q = uri.indexOf('?') >= 0 ? uri.slice(uri.indexOf('?') + 1) : '';
      q.split('&').forEach((p) => {
        const i = p.indexOf('=');
        const k = i >= 0 ? decodeURIComponent(p.slice(0, i)) : decodeURIComponent(p);
        const v = i >= 0 ? decodeURIComponent(p.slice(i + 1)) : '';
        if (k === 'xt') out.hash = v.replace(/urn:btih:/i, '');
        else if (k === 'dn') out.name = v;
        else if (k === 'xl') out.size = v;
        else if (k === 'tr') out.trackers++;
      });
    } catch (e) {}
    return out;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])
    );
  }

  // ---- 悬浮提示 overlay ----
  let overlay = null;
  function getOverlay() {
    if (overlay) return overlay;
    overlay = document.getElementById('__mb_overlay__');
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = '__mb_overlay__';
    Object.assign(overlay.style, {
      position: 'fixed',
      zIndex: '2147483647',
      display: 'none',
      maxWidth: '320px',
      padding: '10px 12px',
      background: 'rgba(18,20,26,0.96)',
      color: '#e8eaf0',
      fontSize: '12px',
      lineHeight: '1.6',
      borderRadius: '8px',
      boxShadow: '0 8px 28px rgba(0,0,0,.45)',
      fontFamily: 'system-ui, sans-serif',
      pointerEvents: 'none'
    });
    document.body.appendChild(overlay);
    return overlay;
  }

  function showOverlay(info, x, y) {
    const box = getOverlay();
    box.innerHTML =
      '<div style="color:#7fd1ff;font-weight:600;margin-bottom:4px">⚡ 磁力链接</div>' +
      '名称：' + escapeHtml(info.name) + '<br>' +
      'Hash：' + escapeHtml(info.hash.slice(0, 20)) + '…<br>' +
      'Tracker：' + info.trackers + ' 个' +
      (info.size ? '<br>大小：' + info.size + ' B' : '');
    box.style.display = 'block';
    const left = Math.min(x + 14, window.innerWidth - 330);
    box.style.left = Math.max(4, left) + 'px';
    box.style.top = (y + 18) + 'px';
  }
  function hideOverlay() {
    if (overlay) overlay.style.display = 'none';
  }

  // 绑定悬停事件并上报；挂一个「▶ 预览」按钮到所在行（每行只挂一个，避免同一行多个磁力重复出按钮）
  function bindLink(el, info) {
    if (el.__mb_bound) return;
    el.__mb_bound = true;
    el.addEventListener('mouseenter', (e) => showOverlay(info, e.clientX, e.clientY));
    el.addEventListener('mousemove', (e) => {
      const left = Math.min(e.clientX + 14, window.innerWidth - 330);
      if (overlay) {
        overlay.style.left = Math.max(4, left) + 'px';
        overlay.style.top = (e.clientY + 18) + 'px';
      }
    });
    el.addEventListener('mouseleave', hideOverlay);
    ipcRenderer.sendToHost('magnet-detected', info);

    // 优先挂到所在表格行（每行只一个按钮，收集该行全部磁力，点击时挑最合适的那条预览）
    const row = el.closest('tr');
    if (row) { ensureRowPreview(row, info); return; }
    // 不在表格行内（如纯文本磁力）：在其后挂一个独立按钮
    try {
      const btn = makePreviewBtn(() => ({ uri: info.uri, name: info.name, movieName: info.name }));
      el.parentNode && el.parentNode.insertBefore(btn, el.nextSibling);
    } catch (e) {}
  }

  // 同一行内只保留一个预览按钮，收集该行所有磁力；点击时挑选“名称最完整”的那条（通常是高清/完整版）
  function ensureRowPreview(row, info) {
    if (row.__mb_row_btn) {
      // 已存在：仅追加磁力（按 uri 去重），避免同一行多个磁力变成多个按钮
      if (!row.__mb_row_btn.__magnets.some((m) => m.uri === info.uri)) row.__mb_row_btn.__magnets.push(info);
      return;
    }
    const store = { magnets: [info], movieName: row.textContent.replace(/\s+/g, ' ').trim().slice(0, 60) };
    const btn = makePreviewBtn(() => {
      const pick = pickBestMagnet(store.magnets);
      return { uri: pick.uri, name: pick.name, movieName: store.movieName };
    });
    btn.__magnets = store.magnets;
    row.__mb_row_btn = btn;
    row.appendChild(btn);
  }

  // 多条磁力里挑“名称最长的”作为预览目标（名称越完整通常越接近完整版/高清版）
  function pickBestMagnet(list) {
    if (!list || !list.length) return null;
    return list.slice().sort((a, b) => String(b.name || '').length - String(a.name || '').length)[0];
  }

  // 生成一个「▶ 预览」按钮，点击时通过 getter 取得要预览的磁力并打开主进程预览窗口
  function makePreviewBtn(getMagnet) {
    const btn = document.createElement('button');
    btn.textContent = '▶ 预览';
    btn.setAttribute('data-mb-preview', '1');
    Object.assign(btn.style, {
      marginLeft: '6px', cursor: 'pointer', border: '1px solid #3b82f6', background: '#eef4ff',
      color: '#1d4ed8', borderRadius: '6px', fontSize: '11px', padding: '1px 6px', verticalAlign: 'middle'
    });
    btn.addEventListener('click', (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      const m = getMagnet();
      if (!m) return;
      ipcRenderer.invoke('open-preview', { magnet: m.uri, name: m.name, movieName: m.movieName }).catch(() => {});
    });
    return btn;
  }

  // ---- 磁力扫描 ----
  function scan() {
    const found = [];
    // 1) 显式 magnet: 链接
    document.querySelectorAll('a[href^="magnet:"]').forEach((a) => {
      found.push({ el: a, info: parseMagnet(a.href) });
    });
    // 2) 正文纯文本中的磁力串
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        /^magnet:/i.test((n.nodeValue || '').trim())
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP
    });
    const texts = [];
    let t;
    while ((t = walker.nextNode())) texts.push(t);
    texts.forEach((node) => {
      const m = node.nodeValue.trim().match(MAGNET_RE);
      if (!m) return;
      const uri = m[0];
      const a = document.createElement('a');
      a.href = uri;
      a.textContent = '⚡磁力';
      a.style.color = '#ffb74d';
      if (node.parentNode) node.parentNode.replaceChild(a, node);
      found.push({ el: a, info: parseMagnet(uri) });
    });
    found.forEach((f) => bindLink(f.el, f.info));
  }

  // ---- 按规则隐藏指定元素（广告拦截维护栏：每行一条，CSS 选择器 或 纯关键字）----
  // 含 . # [ 等 CSS 元字符 => 当作选择器；纯文字（字母/数字/下划线/连字符/中文）=> 当作关键字
  function isKeywordRule(s) { return /^[\w\-一-龥]+$/.test(s); }
  function hideEl(el) {
    try { el.style.setProperty('display', 'none', 'important'); } catch (e) {}
  }
  function applySiteFilters() {
    const mb = (window.__MB_RULES__ && window.__MB_RULES__.rules) || [];
    const kws = [], sels = [];
    mb.forEach((raw) => {
      let s = (raw || '').trim();
      if (!s) return;
      // 兼容 uBlock / AdBlock 语法：剥离 "##" 分隔符（左边可选域名限制，为空表示全局）
      const ab = s.match(/^([^#\n]*?)##(.+)$/);
      if (ab) {
        const domains = ab[1].trim();
        if (domains) {
          // 带域名限制时，仅当前站点命中其一才应用
          const host = (location.hostname || '').toLowerCase();
          const hit = domains.split(',').some((d) => {
            d = d.trim().toLowerCase().replace(/^\|\|/, '');
            return d && (host === d || host.endsWith('.' + d));
          });
          if (!hit) return;
        }
        s = ab[2].trim();
        if (!s) return;
      }
      (isKeywordRule(s) ? kws : sels).push(s);
    });
    // CSS 选择器：直接隐藏匹配元素
    sels.forEach((sel) => {
      try { document.querySelectorAll(sel).forEach(hideEl); } catch (e) {}
    });
    // 关键字：隐藏“自身直接文本或属性(class/id/title/alt/name)”包含该关键字的普通元素
    if (kws.length) {
      const lower = kws.map((k) => k.toLowerCase());
      const all = document.querySelectorAll('*');
      for (let i = 0; i < all.length; i++) {
        const el = all[i];
        if (el === document.body || el === document.documentElement) continue;
        let direct = '';
        const cn = el.childNodes;
        for (let j = 0; j < cn.length; j++) {
          if (cn[j].nodeType === 3) direct += (cn[j].nodeValue || '');
        }
        const cls = (el.className && el.className.baseVal !== undefined) ? el.className.baseVal : (el.className || '');
        const attrs = (cls + ' ' + (el.id || '') + ' ' + (el.getAttribute && el.getAttribute('title') || '') + ' ' + (el.getAttribute && el.getAttribute('alt') || '') + ' ' + (el.getAttribute && el.getAttribute('name') || '')).toLowerCase();
        const hay = (direct + ' ' + attrs).toLowerCase();
        for (let k = 0; k < lower.length; k++) {
          if (hay.indexOf(lower[k]) >= 0) { hideEl(el); break; }
        }
      }
    }
  }
  window.__applySiteFilters = applySiteFilters;

  // ---- 删除页面上的广告元素（载入/渲染阶段即删除，并持续监听动态内容）----
  // 规则：① 类名精确为 .ad-box；② 类名任意位置包含 "ptb10"（如 class="ptb10" / "xxx ptb10 yyy" / "ptb10foo"）
  function removeAdBox() {
    try { document.querySelectorAll('.ad-box, [class*="ptb10"]').forEach((el) => el.remove()); } catch (e) {}
  }
  function removeAdBoxIn(nodes) {
    if (!nodes || !nodes.length) return;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.nodeType !== 1) continue;
      if (n.matches && (n.matches('.ad-box') || n.matches('[class*="ptb10"]'))) { n.remove(); continue; }
      try { n.querySelectorAll('.ad-box, [class*="ptb10"]').forEach((el) => el.remove()); } catch (e) {}
    }
  }
  window.__removeAdBox = removeAdBox;

  // ---- 监听动态内容（SPA / 异步加载）----
  let observer = null;
  function startObserver() {
    if (observer) return;
    observer = new MutationObserver((mutations) => {
      // 先断开再处理再重连，避免自触发死循环
      observer.disconnect();
      try {
        scan();
        // 对本次新增的节点树立即清除广告元素（渲染/异步加载出现即删）
        for (const m of mutations) removeAdBoxIn(m.addedNodes);
        // 同步应用用户维护的拦截规则（动态加载内容也生效）
        if (window.__MB_RULES__ && window.__MB_RULES__.rules && window.__MB_RULES__.rules.length) {
          try { applySiteFilters(); } catch (e) {}
        }
      } finally {
        observer.observe(document.documentElement, { childList: true, subtree: true });
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function init() {
    getOverlay();
    scan();
    removeAdBox();
    startObserver();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
