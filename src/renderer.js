// renderer.js — 工具栏逻辑、地址本下拉、窗口控制
// 内嵌网页由主进程 BrowserView 承载，尺寸由主进程 setBounds 精确控制（铺满工具栏以下），
// 渲染进程只通过 electronAPI 发指令，无需也不做 JS 量尺寸。
const toolbar = document.getElementById('toolbar');
const urlInput = document.getElementById('url');
const backBtn = document.getElementById('back');
const fwdBtn = document.getElementById('fwd');
const homeBtn = document.getElementById('home');
const addrBookBtn = document.getElementById('addrbook');
const addrDrop = document.getElementById('addr-drop');

// 主页地址：固定定义为 javbus
const HOME_URL = 'https://www.javbus.com/';

let settings = { homeUrl: HOME_URL, startupUrl: 'https://www.fanbus.cyou/' };
let pendingRules = null;

// ---------- 浮层避让：设置弹窗打开时让主进程把 BrowserView 压成 0 高（关闭即恢复） ----------
function refreshOverlay() {
  const modal = document.getElementById('settings-modal');
  const mode = (modal && !modal.classList.contains('hidden')) ? 'settings' : 'none';
  window.electronAPI.setOverlay(mode);
}

// ---------- 导航（经主进程 BrowserView） ----------
function normalize(u) {
  u = (u || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) {
    // 纯域名补 https；否则当作搜索词
    if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(u)) u = 'https://' + u;
    else u = 'https://www.bing.com/search?q=' + encodeURIComponent(u);
  }
  return u;
}

function load(u) {
  const target = normalize(u);
  if (!target) return;
  window.electronAPI.navigate(target);
  urlInput.value = target;
}

function updateNavState(canBack) {
  backBtn.disabled = !canBack;
}

// 主进程转发的网页导航事件：更新地址栏 + 后退按钮状态
window.electronAPI.onPageNavigated((d) => {
  urlInput.value = d.url || '';
  updateNavState(d.canGoBack);
  if (pendingRules) injectRules();
});

// ---------- 地址本下拉：用独立置顶浮窗承载（浮在 BrowserView 之上，网页保持原位不被遮挡/推走） ----------
addrDrop.onclick = (e) => {
  e.stopPropagation();
  const r = addrDrop.getBoundingClientRect();
  // 传 right 供主进程把菜单右对齐到按钮右边界
  window.electronAPI.openAddrDropdown({ left: r.left, right: r.right, bottom: r.bottom, width: r.width, top: r.top });
};

// ---------- 地址本：点击 📖 打开独立置顶浮窗（浮在浏览区之上，不挤占网页，点外部自动收回） ----------
addrBookBtn.onclick = () => window.electronAPI.openAddrPanelWindow();

// ---------- 自定义标题栏：窗口控制 ----------
document.getElementById('win-min').onclick = () => window.electronAPI.windowControl('min');
document.getElementById('win-max').onclick = () => window.electronAPI.windowControl('max');
document.getElementById('win-close').onclick = () => window.electronAPI.windowControl('close');

// ---------- 设置（齿轮） ----------
const settingsBtn = document.getElementById('settings');
const modal = document.getElementById('settings-modal');
const setHome = document.getElementById('set-home');
const setStartup = document.getElementById('set-startup');
const setAuto = document.getElementById('set-auto');
const setVer = document.getElementById('set-ver');
// Tracker 维护栏元素
const setTrackers = document.getElementById('set-trackers');
const trackerCount = document.getElementById('tracker-count');
const trackerReset = document.getElementById('tracker-reset');
const trackerSave = document.getElementById('tracker-save');
// 广告拦截维护栏元素
const setRules = document.getElementById('set-rules');
const rulesCount = document.getElementById('rules-count');
const rulesReset = document.getElementById('rules-reset');
const rulesSave = document.getElementById('rules-save');
function openSettings() {
  setHome.value = settings.homeUrl || '';
  setStartup.value = settings.startupUrl || '';
  if (setAuto) setAuto.checked = !!settings.autoFetchBlocked;   // 自动获取防屏蔽地址开关（设在设置里）
  if (setVer) {
    window.electronAPI.getVersion().then((v) => { setVer.textContent = v || '—'; }).catch(() => {});
  }
  // 加载当前 Tracker 列表（来自 config/trackers.json）
  if (setTrackers) {
    window.electronAPI.getTrackers().then((list) => {
      setTrackers.value = (list || []).join('\n');
      updateTrackerCount();
    }).catch(() => {});
  }
  // 加载当前广告拦截规则（来自 config/filter-rules.json 的 rules 数组）
  if (setRules) {
    window.electronAPI.getRules().then((list) => {
      setRules.value = (list || []).join('\n');
      updateRulesCount();
    }).catch(() => {});
  }
  modal.classList.remove('hidden');
  refreshOverlay(); // 让 BrowserView 让位（压成 0 高），设置弹窗覆盖整窗
}
function closeSettings() { modal.classList.add('hidden'); refreshOverlay(); }
settingsBtn.onclick = openSettings;
document.getElementById('settings-close').onclick = closeSettings;
document.getElementById('settings-cancel').onclick = closeSettings;
// 自动获取防屏蔽地址：开关变化即保存；打开时立即采集一次当前页
if (setAuto) setAuto.onchange = () => {
  settings.autoFetchBlocked = setAuto.checked;
  window.electronAPI.sendSettings(settings);
  if (setAuto.checked) window.electronAPI.extractNow();
};
document.getElementById('settings-save').onclick = () => {
  const h = (setHome.value || '').trim();
  const s = (setStartup.value || '').trim();
  settings.homeUrl = normalize(h) || settings.homeUrl;
  settings.startupUrl = normalize(s) || settings.startupUrl;
  window.electronAPI.sendSettings(settings);
  closeSettings();
};

// ---------- Tracker 维护：实时计数 + 保存 / 恢复默认 ----------
function updateTrackerCount() {
  if (!setTrackers || !trackerCount) return;
  const n = setTrackers.value.split('\n').map((s) => s.trim()).filter(Boolean).length;
  trackerCount.textContent = '共 ' + n + ' 条';
}
if (setTrackers) setTrackers.addEventListener('input', updateTrackerCount);

// 保存：逐行解析、过滤空行，交给主进程校验落盘（无效行会被忽略并提示）
if (trackerSave) trackerSave.onclick = () => {
  const lines = setTrackers.value.split('\n').map((s) => s.trim()).filter(Boolean);
  window.electronAPI.saveTrackers(lines).then((r) => {
    if (r && r.ok) {
      updateTrackerCount();
      const skip = (r.bad && r.bad.length) ? '（已忽略 ' + r.bad.length + ' 条无效）' : '';
      showToast('Tracker 已保存：' + r.count + ' 条' + skip);
    } else {
      showToast('保存失败：' + (r && r.msg || '未知错误'));
    }
  }).catch((e) => showToast('保存失败：' + (e && e.message || e)));
};

// 恢复默认：写回内置 31 条（来自 torrent-server 的 DEFAULT_TRACKERS）
if (trackerReset) trackerReset.onclick = () => {
  window.electronAPI.resetTrackers().then((r) => {
    if (r && r.ok) {
      setTrackers.value = (r.list || []).join('\n');
      updateTrackerCount();
      showToast('已恢复默认 ' + (r.list || []).length + ' 条');
    } else {
      showToast('重置失败：' + (r && r.msg || '未知错误'));
    }
  }).catch((e) => showToast('重置失败：' + (e && e.message || e)));
};

// ---------- 广告拦截规则维护：实时计数 + 保存 / 恢复默认 ----------
function updateRulesCount() {
  if (!setRules || !rulesCount) return;
  const n = setRules.value.split('\n').map((s) => s.trim()).filter(Boolean).length;
  rulesCount.textContent = '共 ' + n + ' 条';
}
if (setRules) setRules.addEventListener('input', updateRulesCount);

// 保存：逐行解析、过滤空行，交给主进程落盘并即时下发到当前网页
if (rulesSave) rulesSave.onclick = () => {
  const lines = setRules.value.split('\n').map((s) => s.trim()).filter(Boolean);
  window.electronAPI.saveRules(lines).then((r) => {
    if (r && r.ok) {
      updateRulesCount();
      showToast('拦截规则已保存：' + r.count + ' 条（已应用到当前网页）');
    } else {
      showToast('保存失败：' + (r && r.msg || '未知错误'));
    }
  }).catch((e) => showToast('保存失败：' + (e && e.message || e)));
};

// 恢复默认：写回内置 10 条
if (rulesReset) rulesReset.onclick = () => {
  window.electronAPI.resetRules().then((r) => {
    if (r && r.ok) {
      setRules.value = (r.list || []).join('\n');
      updateRulesCount();
      showToast('已恢复默认 ' + (r.list || []).length + ' 条');
    } else {
      showToast('重置失败：' + (r && r.msg || '未知错误'));
    }
  }).catch((e) => showToast('重置失败：' + (e && e.message || e)));
};

// ---------- 顶栏按键（经主进程 BrowserView） ----------
homeBtn.onclick = () => load(settings.homeUrl || HOME_URL);
backBtn.onclick = () => window.electronAPI.goBack();
fwdBtn.onclick = () => window.electronAPI.reload();
urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') load(urlInput.value); });

// ---------- 主进程下发：设置 / 规则 ----------
window.electronAPI.receiveSettings((s) => {
  settings = Object.assign({ homeUrl: HOME_URL, startupUrl: 'https://www.fanbus.cyou/', autoFetchBlocked: false }, s);
});

window.electronAPI.receiveRules((rules) => {
  pendingRules = rules;
  injectRules();
});

// ---------- 加载反馈：让按钮“有没有反应”一眼可见 ----------
const toastEl = document.getElementById('toast');
let toastTimer = null;
function showToast(msg) {
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 3500);
}
// 转圈反馈与“加载事件”解耦：开始加载即转，最多 8 秒强制停（不依赖可能不触发的停止事件）
let spinTimer = null;
function spin(on) {
  if (!fwdBtn) return;
  fwdBtn.classList.toggle('loading', !!on);
  if (on) {
    if (spinTimer) clearTimeout(spinTimer);
    spinTimer = setTimeout(() => { fwdBtn.classList.remove('loading'); spinTimer = null; }, 8000);
  } else if (spinTimer) {
    clearTimeout(spinTimer); spinTimer = null;
  }
}
window.electronAPI.onPageLoading((loading) => { if (loading) spin(true); else spin(false); });
window.electronAPI.onPageError((d) => {
  const url = (d && d.url) || '';
  const why = (d && (d.desc || d.code)) || '未知错误';
  showToast(`加载失败：${url}（${why}）`);
  spin(false);
});

// ---------- 过滤规则（广告拦截维护栏：每行一条 CSS 选择器 或 纯关键字） ----------
function injectRules() {
  if (!pendingRules) return;
  const rules = (pendingRules.rules || []).filter((x) => typeof x === 'string');
  if (window.electronAPI.execJs) {
    const code =
      'window.__MB_RULES__=' + JSON.stringify({ rules }) +
      ';window.__applySiteFilters&&window.__applySiteFilters();';
    window.electronAPI.execJs(code).catch(() => {});
  }
}
