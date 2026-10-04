// main.js — 主进程
const { app, BrowserWindow, BrowserView, ipcMain, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
// 主进程侧 BitTorrent 流式服务（经典 TCP/DHT 种子 + WebSeed 代理兜底），供预览窗口拉流
const torrentServer = require('./torrent-server');

// ---------- 运行时目录：缓存 / Cookie / 会话 / 可写配置 ----------
// 不落系统 AppData：开发期放「项目根/cache」，打包后放「exe 同级/cache」。
// 关键点：所有会被运行时写入的配置文件（settings/trackers/rules/address-book）
// 必须放在可写目录，不能打进 asar 只读层，否则打包后设置无法保存。
const PROJECT_ROOT = app.isPackaged
  ? path.dirname(process.execPath)        // 打包后：exe 所在目录
  : path.resolve(__dirname, '..');        // 开发期：main.js 在 src/，上一级即项目根
const APP_CACHE_DIR = path.join(PROJECT_ROOT, 'cache');
const CONFIG_DIR = path.join(APP_CACHE_DIR, 'config');

// 首次运行：把 src/config 里的默认配置复制到可写目录（asar 只读，不能原地写）
try {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const seedDir = path.join(__dirname, 'config');
  for (const f of ['settings.json', 'trackers.json', 'filter-rules.json', 'address-book.json']) {
    const srcF = path.join(seedDir, f);
    const dstF = path.join(CONFIG_DIR, f);
    if (fs.existsSync(srcF) && !fs.existsSync(dstF)) fs.copyFileSync(srcF, dstF);
  }
} catch (e) {}
try { app.setPath('userData', APP_CACHE_DIR); } catch (e) {}

// 主进程若崩溃，把错误落地到 cache/error.log，便于排查
process.on('uncaughtException', (e) => {
  try { fs.writeFileSync(path.join(APP_CACHE_DIR, 'error.log'), String((e && e.stack) || e), 'utf-8'); } catch (_) {}
});

// 彻底移除默认菜单栏（Windows/Linux 下 Electron 会注入默认菜单）
Menu.setApplicationMenu(null);

let mainWindow;
let addrPanelWindow = null;       // 地址本浮窗（独立置顶窗，浮在浏览区之上，网页不被挤占）
let addrDropdownWindow = null;    // 地址本下拉浮窗（独立置顶小窗，浮在 BrowserView 之上，网页保持原位）
let browserView = null;           // 内嵌网页承载对象
let overlayMode = 'none';         // none=网页铺满；dropdown/settings=打开浮层时把网页压成 0 高（仅 setBounds，可靠重绘）
let previewWin = null;            // 磁力预览独立窗口（file:// 自有源，无第三方 CSP 钳制）
let lastSpeedMap = {};            // 最近一次测速结果（url->ms），跨浮窗实例保留，程序退出才清零

// ---------- 过滤规则（广告拦截维护栏：每行一条，CSS 选择器 或 纯关键字） ----------
const FILTER_PATH = path.join(CONFIG_DIR, 'filter-rules.json');
// 默认规则（与 filter-rules.json 初始内容一致）：作为「恢复默认」还原目标 + 文件损坏时的回退
const DEFAULT_FILTER_RULES = [
  '#top-ad', '.ad-banner', '[data-ad]', '.google-ad', '.adsbygoogle',
  '.ad-box', '[class*="ptb10"]', '.sidebar', '#recommend-column', 'header .promo'
];

function loadRules() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILTER_PATH, 'utf-8'));
    const rules = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.rules) ? raw.rules : []);
    return { rules: rules.filter((x) => typeof x === 'string') };
  } catch (e) {
    return { rules: DEFAULT_FILTER_RULES.slice() };
  }
}

// ---------- 设置 ----------
const SETTINGS_PATH = path.join(CONFIG_DIR, 'settings.json');
// homeUrl：点击「🏠 主页」打开的地址（固定 javbus）
// startupUrl：应用启动后默认打开的页面（开发期先 fanbus）
const DEFAULT_SETTINGS = {
  homeUrl: 'https://www.javbus.com/',
  startupUrl: 'https://www.fanbus.cyou/',
  autoFetchBlocked: false  // 是否自动从页面采集"防屏蔽地址"
};

function loadSettings() {
  try {
    return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8')));
  } catch (e) {
    return Object.assign({}, DEFAULT_SETTINGS);
  }
}

function saveSettings(s) {
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2), 'utf-8');
    return true;
  } catch (e) {
    return false;
  }
}

// ---------- 地址本 ----------
const ADDRBOOK_PATH = path.join(CONFIG_DIR, 'address-book.json');
const DEFAULT_ADDRBOOK = [{ url: 'https://www.fanbus.cyou/', active: true }];

// 兼容旧版：磁盘上若是字符串数组，统一升级为 {url, active} 对象数组
function loadAddressBook() {
  try {
    const raw = JSON.parse(fs.readFileSync(ADDRBOOK_PATH, 'utf-8'));
    if (!Array.isArray(raw)) return DEFAULT_ADDRBOOK.slice();
    return raw.map((x) => (typeof x === 'string' ? { url: x, active: true } : { url: x.url, active: x.active !== false }));
  } catch (e) {
    return DEFAULT_ADDRBOOK.slice();
  }
}

function saveAddressBook(list) {
  try {
    fs.writeFileSync(ADDRBOOK_PATH, JSON.stringify(list, null, 2), 'utf-8');
    return true;
  } catch (e) {
    return false;
  }
}

// 把地址本每项附带实时延迟 ms（来自 lastSpeedMap），供面板/下拉按速度排序同步
function enrichBook(list) {
  return Array.isArray(list)
    ? list.map((x) => ({ url: x.url, active: x.active !== false, ms: (lastSpeedMap && lastSpeedMap[x.url] != null) ? lastSpeedMap[x.url] : null }))
    : [];
}

// 把最新地址本广播给所有窗口（主窗口下拉 + 地址本窗口列表同步刷新），含实时延迟 ms
function broadcastAddressBook(list) {
  const enriched = enrichBook(list);
  BrowserWindow.getAllWindows().forEach((w) => {
    if (!w.isDestroyed()) w.webContents.send('address-book-updated', enriched);
  });
  // 下拉浮窗若开着，同步刷新（含实时延迟）
  if (addrDropdownWindow && !addrDropdownWindow.isDestroyed()) {
    addrDropdownWindow.webContents.send('addr-list', enriched);
  }
}

// 新增单个地址（去重 + 校验 + 落盘 + 广播），供页面自动采集调用
function addAddressToList(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  const u = rawUrl.trim();
  if (!/^https?:\/\//i.test(u)) return false;
  const list = loadAddressBook();
  if (list.some((x) => x.url === u)) return false; // 已存在则跳过（去重）
  list.push({ url: u, active: true });
  saveAddressBook(list);
  broadcastAddressBook(list);
  return true;
}

// 页面内执行：找出“防屏蔽地址”标签右侧的网址
function pageExtractFn() {
  try {
    var out = [];
    var re = /https?:\/\/[^\s"'<>]+/i;
    var all = document.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var t = (el.textContent || '').trim();
      // 标签文字含“防屏蔽”且较短，避免误匹配大容器
      if (t && t.indexOf('防屏蔽') !== -1 && t.length < 80) {
        var scope = el.parentElement || el;
        var links = scope.querySelectorAll('a[href]');
        if (links.length) {
          for (var j = 0; j < links.length; j++) {
            var h = links[j].href || '';
            if (/^https?:\/\//i.test(h)) out.push(h);
          }
        } else {
          var m = t.match(re);
          if (m) out.push(m[0]);
        }
      }
    }
    var seen = {}, res = [];
    out.forEach(function (u) { if (!seen[u]) { seen[u] = 1; res.push(u); } });
    return res;
  } catch (e) { return []; }
}

// 页面加载完成后，自动采集“防屏蔽地址”并写入地址本（去重）
function extractPageAddresses() {
  if (!browserView) return;
  browserView.webContents.executeJavaScript('(' + pageExtractFn.toString() + ')()').then((list) => {
    if (Array.isArray(list) && list.length) {
      // 调试日志：记录采集到的地址，便于核对 DOM 选择器是否正确
      try { fs.appendFileSync(path.join(APP_CACHE_DIR, 'addr-extract.log'), new Date().toISOString() + '\n' + list.join('\n') + '\n', 'utf-8'); } catch (_) {}
      list.forEach((u) => addAddressToList(u));
    }
  }).catch(() => {});
}

// ---------- 内嵌网页：BrowserView（尺寸由主进程 setBounds 精确控制，铺满工具栏以下；本环境已验证可靠满屏） ----------
const TOOLBAR_H = 48;
const PANEL_W = 440;   // 地址本浮窗宽度（独立置顶窗，浮于浏览区之上，不挤占网页）

function applyBrowserViewBounds() {
  if (!browserView || !mainWindow) return;
  const { width, height } = mainWindow.getBounds();
  if (overlayMode === 'none') {
    // 正常：铺满工具栏以下整块
    browserView.setBounds({ x: 0, y: TOOLBAR_H, width, height: Math.max(0, height - TOOLBAR_H) });
  } else {
    // 浮层（设置弹窗）打开：把网页压成 0 高（仅 setBounds，可靠重绘；关闭浮层即恢复，绝不 removeBrowserView）
    browserView.setBounds({ x: 0, y: TOOLBAR_H, width, height: 0 });
  }
}

function createBrowserView() {
  if (!mainWindow) return;
  browserView = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'persist:magnet'
    }
  });
  mainWindow.addBrowserView(browserView);
  applyBrowserViewBounds();

  // 把内嵌网页的导航事件转发给主窗口渲染进程（更新地址栏 / 后退按钮状态）
  const forwardNav = () => {
    if (!browserView) return;
    const wc = browserView.webContents;
    mainWindow.webContents.send('page-navigated', {
      url: wc.getURL(),
      canGoBack: wc.canGoBack()
    });
  };
  browserView.webContents.on('did-navigate', forwardNav);
  browserView.webContents.on('did-navigate-in-page', forwardNav);
  browserView.webContents.on('did-frame-navigate', (e, _u, _f, isMainFrame) => {
    if (isMainFrame) forwardNav();
  });
  browserView.webContents.on('did-finish-load', () => {
    forwardNav();
    // 仅当“自动获取防屏蔽地址”开关开启时，才采集页面上的防屏蔽地址（延后 1.5s 等页面渲染完）
    if (loadSettings().autoFetchBlocked) setTimeout(extractPageAddresses, 1500);
  });
  // 加载中 / 加载失败 转发，提供可见反馈（站点不可达时区分“没点到”还是“打不开”）
  browserView.webContents.on('did-start-loading', () => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('page-loading', true);
  });
  browserView.webContents.on('did-stop-loading', () => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('page-loading', false);
  });
  browserView.webContents.on('did-fail-load', (e, errorCode, errorDescription, validatedURL) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('page-error', { code: errorCode, desc: errorDescription, url: validatedURL });
    }
  });
  // 弹窗在网页内打开，避免逃逸到系统浏览器
  browserView.webContents.on('new-window', (e, url) => {
    e.preventDefault();
    if (browserView) browserView.webContents.loadURL(url);
  });

  // 启动页用独立的 startupUrl（与「🏠 主页」解耦），开发期默认 fanbus
  browserView.webContents.loadURL(loadSettings().startupUrl || 'https://www.fanbus.cyou/');
}

// ---------- 主窗口 ----------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    frame: false,          // 去掉默认标题栏，用顶栏自定义工具栏充当标题栏
    menuBarVisible: false, // 去掉默认菜单栏
    webPreferences: {
      preload: path.join(__dirname, 'preload-main.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.maximize();                              // 启动即最大化，确保铺满整屏
  mainWindow.on('resize', applyBrowserViewBounds);    // 窗口缩放时同步调整内嵌网页尺寸

  // 页面加载完成后下发规则 / 设置 / 地址本，并创建内嵌网页
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('rules', loadRules());
    mainWindow.webContents.send('settings', loadSettings());
    mainWindow.webContents.send('address-book-updated', loadAddressBook());
    createBrowserView();
  });
}

// ---------- 地址本下拉浮窗（独立置顶小窗，浮在 BrowserView 之上，网页保持原位不被遮挡/推走） ----------
function openAddrDropdown(rect) {
  if (addrDropdownWindow && !addrDropdownWindow.isDestroyed()) { addrDropdownWindow.focus(); return; }
  const mb = mainWindow.getBounds();
  const w = 360; // 菜单固定宽度，右对齐到按钮右边界
  const right = (rect && rect.right != null) ? rect.right : (rect.left + (rect.width || 0));
  const x = mb.x + Math.round(right) - w;
  const y = mb.y + Math.round(rect.bottom);
  addrDropdownWindow = new BrowserWindow({
    x, y,
    width: w,
    height: 340,
    frame: false,
    transparent: true,        // 透明窗体，只显示白色菜单卡片
    alwaysOnTop: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    parent: mainWindow,
    modal: false,
    webPreferences: { contextIsolation: false, nodeIntegration: true } // 小型可信本地窗，直接用 require
  });
  addrDropdownWindow.loadFile(path.join(__dirname, 'addr-dropdown.html'));
  addrDropdownWindow.webContents.on('did-finish-load', () => {
    addrDropdownWindow.webContents.send('addr-list', enrichBook(loadAddressBook()));
  });
  // 失焦即关闭（点别处自动收起）
  addrDropdownWindow.on('blur', () => { try { addrDropdownWindow.close(); } catch (_) {} });
  addrDropdownWindow.on('closed', () => { addrDropdownWindow = null; });
}

ipcMain.on('open-addr-dropdown', (e, rect) => openAddrDropdown(rect || { left: 0, bottom: 48 }));
ipcMain.on('addr-dropdown-select', (e, url) => {
  if (browserView && url) browserView.webContents.loadURL(url);
  if (addrDropdownWindow && !addrDropdownWindow.isDestroyed()) addrDropdownWindow.close();
});
ipcMain.on('addr-dropdown-close', () => {
  if (addrDropdownWindow && !addrDropdownWindow.isDestroyed()) addrDropdownWindow.close();
});

// ---------- 地址本测速：对每个地址做 HTTP(S) 探测，返回响应延迟（毫秒） ----------
function pingUrl(url, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    let done = false;
    const finish = (ms) => { if (!done) { done = true; resolve({ url, ms }); } };
    let lib;
    try { lib = url.startsWith('https') ? https : http; } catch (e) { finish(null); return; }
    let req;
    try {
      req = lib.get(url, { timeout: timeoutMs, headers: { 'User-Agent': 'Mozilla/5.0' }, rejectUnauthorized: false }, (res) => {
        finish(Date.now() - started);   // 收到响应头即认为连通，记录延迟
        res.destroy();
      });
    } catch (e) { finish(null); return; }
    req.on('error', () => finish(null));
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} finish(null); });
  });
}

// ---------- 地址本浮窗：独立置顶窗，浮在浏览区之上（不挤占网页，点击外部自动收回） ----------
function openAddrPanelWindow() {
  if (addrPanelWindow && !addrPanelWindow.isDestroyed()) { addrPanelWindow.close(); return; } // 已开则切换关闭
  if (!mainWindow) return;
  const mb = mainWindow.getBounds();
  const w = PANEL_W;
  const h = Math.max(200, mb.height - TOOLBAR_H);
  const x = mb.x + mb.width - w;
  const y = mb.y + TOOLBAR_H;   // 从工具栏下方起，不遮挡顶部工具栏
  addrPanelWindow = new BrowserWindow({
    x, y, width: w, height: h,
    frame: false,
    transparent: true,        // 透明窗体，只显示白色卡片（浮层质感）
    alwaysOnTop: true,        // 置顶在浏览区之上
    resizable: false,
    movable: false,
    skipTaskbar: true,
    parent: mainWindow,
    modal: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-main.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  addrPanelWindow.loadFile(path.join(__dirname, 'addr-panel.html'));
  // 主窗口移动 / 缩放时跟随 reposition
  const reposition = () => {
    if (!addrPanelWindow || addrPanelWindow.isDestroyed() || !mainWindow) return;
    const m = mainWindow.getBounds();
    addrPanelWindow.setBounds({ x: m.x + m.width - w, y: m.y + TOOLBAR_H, width: w, height: Math.max(200, m.height - TOOLBAR_H) });
  };
  mainWindow.on('resize', reposition);
  mainWindow.on('move', reposition);
  // 失焦（点其它地方）即关闭 = 点击非滑出区收回
  addrPanelWindow.on('blur', () => { try { addrPanelWindow.close(); } catch (_) {} });
  addrPanelWindow.on('closed', () => {
    mainWindow.removeListener('resize', reposition);
    mainWindow.removeListener('move', reposition);
    addrPanelWindow = null;
  });
}

// ---------- 磁力预览窗口（file:// 自有源，无第三方 CSP；主进程负责 P2P，<video> 只播本地流） ----------
function openPreview(magnet, name, movieName) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const mb = mainWindow.getBounds();
  const w = 480, h = 440;
  const x = mb.x + mb.width - w - 16;
  const y = mb.y + mb.height - h - 16;
  if (previewWin && !previewWin.isDestroyed()) {
    previewWin.loadFile(path.join(__dirname, 'preview.html'), { query: { magnet: magnet || '', name: name || '视频预览', movieName: movieName || '' } });
    previewWin.focus();
    return;
  }
  previewWin = new BrowserWindow({
    x, y, width: w, height: h,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    parent: mainWindow,
    modal: false,
    webPreferences: {
      preload: path.join(__dirname, 'preview-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  previewWin.loadFile(path.join(__dirname, 'preview.html'), { query: { magnet: magnet || '', name: name || '视频预览', movieName: movieName || '' } });
  previewWin.on('closed', () => { previewWin = null; });
}

app.whenReady().then(() => {
  // 首次确保地址本文件存在
  if (!fs.existsSync(ADDRBOOK_PATH)) saveAddressBook(DEFAULT_ADDRBOOK);
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ---------- IPC ----------
ipcMain.on('reload-rules', (event) => {
  event.sender.send('rules', loadRules());
});

ipcMain.on('save-settings', (event, s) => {
  saveSettings(s);
});

ipcMain.on('open-addr-panel-window', () => openAddrPanelWindow());

// 地址本浮窗读取设置（开关状态等）
ipcMain.handle('get-settings', () => loadSettings());

// 立即采集一次当前页面防屏蔽地址（开关刚打开时手动触发）
ipcMain.on('extract-now', () => {
  if (loadSettings().autoFetchBlocked) extractPageAddresses();
});

// 对地址本中每个地址测速：每返回一个结果就实时上报（speed-progress），并同步刷新地址栏下拉，
// 实现“一边测速一边排序 + 下拉同步”；最后整体返回结果并保存 lastSpeedMap
ipcMain.handle('speed-test', (event, urls) => {
  const list = Array.isArray(urls) ? urls : [];
  const sender = event.sender;
  const currentList = loadAddressBook();
  const tasks = list.map((u) => pingUrl(u, 2000).then((r) => {
    if (r && r.url) lastSpeedMap[r.url] = r.ms;
    if (sender && !sender.isDestroyed()) {
      try { sender.send('speed-progress', r); } catch (_) {}
    }
    // 同步地址栏下拉菜单（含实时延迟），让主面板下拉条目也跟着更新/排序
    broadcastAddressBook(currentList);
    return r;
  }));
  return Promise.all(tasks).then((results) => results);
});

// 读取最近一次测速结果（url->ms），面板打开时回填，直到重新测速或程序退出
ipcMain.handle('get-speeds', () => lastSpeedMap);

// 自定义标题栏：窗口控制（最小化 / 最大化 / 关闭）
ipcMain.on('window-control', (event, action) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (action === 'min') win.minimize();
  else if (action === 'max') { win.isMaximized() ? win.unmaximize() : win.maximize(); }
  else if (action === 'close') win.close();
});

// 读取地址本
ipcMain.handle('get-address-book', () => loadAddressBook());

// 新增地址（去重 + 校验 http(s)），成功后广播
ipcMain.handle('add-address', (event, url) => {
  if (!url || typeof url !== 'string') return { ok: false, msg: '地址无效' };
  const u = url.trim();
  if (!/^https?:\/\//i.test(u)) return { ok: false, msg: '地址需以 http(s):// 开头' };
  const list = loadAddressBook();
  if (!list.some((x) => x.url === u)) {
    list.push({ url: u, active: true });
    saveAddressBook(list);
    broadcastAddressBook(list);
  }
  return { ok: true, list };
});

// 删除地址，成功后广播
ipcMain.handle('delete-address', (event, url) => {
  const list = loadAddressBook().filter((x) => x.url !== url);
  saveAddressBook(list);
  broadcastAddressBook(list);
  return { ok: true, list };
});

// 切换某地址的「有效激活」状态（仅激活的地址会进入地址栏下拉菜单），成功后广播
ipcMain.handle('set-address-active', (event, url, active) => {
  const list = loadAddressBook().map((x) => (x.url === url ? Object.assign({}, x, { active: !!active }) : x));
  saveAddressBook(list);
  broadcastAddressBook(list);
  return { ok: true, list };
});

// 版本号（来自 package.json），供设置弹窗展示，便于确认当前运行的是哪份代码
ipcMain.handle('get-version', () => app.getVersion());

// ---------- Tracker 维护（设置弹窗内「Tracker 维护」专用栏，用户自行增删） ----------
const TRACKERS_PATH = path.join(CONFIG_DIR, 'trackers.json');
function readTrackersFile() {
  try {
    const raw = JSON.parse(fs.readFileSync(TRACKERS_PATH, 'utf-8'));
    if (Array.isArray(raw)) return raw.filter((x) => typeof x === 'string');
  } catch (e) {}
  return torrentServer.getDefaultTrackers();
}
// 校验：只接受 udp:// 与 http(s):// 两类，其余记为无效行（保存时忽略，但告知用户）
function validateTrackerLines(lines) {
  const ok = [], bad = [];
  (lines || []).forEach((raw) => {
    const s = (raw || '').trim();
    if (!s) return;
    if (/^udp:\/\//i.test(s) || /^https?:\/\//i.test(s)) ok.push(s);
    else bad.push(s);
  });
  return { ok, bad };
}
ipcMain.handle('get-trackers', () => readTrackersFile());
ipcMain.handle('save-trackers', (event, list) => {
  const { ok, bad } = validateTrackerLines(list);
  if (!ok.length) return { ok: false, msg: '没有有效的 tracker 地址（需以 udp:// 或 http(s):// 开头）' };
  try {
    fs.writeFileSync(TRACKERS_PATH, JSON.stringify(ok, null, 2), 'utf-8');
    torrentServer.reloadTrackers();   // 让内存中的 TRACKERS 立即更新，下次预览即生效
    return { ok: true, count: ok.length, bad };
  } catch (e) {
    return { ok: false, msg: '写入文件失败：' + (e && e.message || e) };
  }
});
ipcMain.handle('reset-trackers', () => {
  const def = torrentServer.getDefaultTrackers();
  try {
    fs.writeFileSync(TRACKERS_PATH, JSON.stringify(def, null, 2), 'utf-8');
    torrentServer.reloadTrackers();
    return { ok: true, list: def };
  } catch (e) {
    return { ok: false, msg: '重置失败：' + (e && e.message || e) };
  }
});

// ---------- 广告拦截规则维护（设置弹窗内「广告拦截」专用栏，用户自行增删） ----------
ipcMain.handle('get-rules', () => {
  const r = loadRules();
  return r.rules;
});
ipcMain.handle('save-rules', (event, list) => {
  const rules = Array.isArray(list) ? list.map((s) => (s || '').trim()).filter(Boolean) : [];
  if (!rules.length) return { ok: false, msg: '规则列表为空，至少填一条（CSS 选择器或关键字）' };
  try {
    fs.writeFileSync(FILTER_PATH, JSON.stringify({ rules }, null, 2), 'utf-8');
    // 立即把新规则下发到内嵌网页（若已打开），无需刷新页面
    if (browserView && !browserView.webContents.isDestroyed()) {
      browserView.webContents.send('rules', { rules });
    }
    return { ok: true, count: rules.length };
  } catch (e) {
    return { ok: false, msg: '写入文件失败：' + (e && e.message || e) };
  }
});
ipcMain.handle('reset-rules', () => {
  try {
    fs.writeFileSync(FILTER_PATH, JSON.stringify({ rules: DEFAULT_FILTER_RULES }, null, 2), 'utf-8');
    if (browserView && !browserView.webContents.isDestroyed()) {
      browserView.webContents.send('rules', { rules: DEFAULT_FILTER_RULES });
    }
    return { ok: true, list: DEFAULT_FILTER_RULES.slice() };
  } catch (e) {
    return { ok: false, msg: '重置失败：' + (e && e.message || e) };
  }
});

// ---------- 内嵌网页（BrowserView）控制 + 浮层避让 ----------
ipcMain.handle('navigate', (e, url) => {
  if (browserView) return browserView.webContents.loadURL(url);
});
ipcMain.on('go-back', () => {
  if (browserView && browserView.webContents.canGoBack()) browserView.webContents.goBack();
});
ipcMain.on('reload', () => {
  if (browserView) browserView.webContents.reload();
});
ipcMain.handle('inject-css', (e, css) => {
  if (browserView) return browserView.webContents.insertCSS(css);
});
ipcMain.handle('exec-js', (e, code) => {
  if (browserView) return browserView.webContents.executeJavaScript(code);
});
// 浮层（下拉 / 设置弹窗）打开时让 BrowserView 让位；关闭时恢复铺满（纯 setBounds，稳定重绘）
ipcMain.on('set-overlay', (e, mode) => {
  overlayMode = (mode === 'dropdown' || mode === 'settings') ? mode : 'none';
  applyBrowserViewBounds();
});

// ---------- 磁力预览：主进程 BitTorrent 流式服务（TCP/DHT + WebSeed 代理）----------
ipcMain.handle('torrent-available', () => ({ ok: torrentServer.isAvailable(), error: torrentServer.getLoadError() }));
ipcMain.handle('torrent-add', (event, magnet, timeoutMs) => {
  return torrentServer.ensureServer().then(() => torrentServer.addMagnet(magnet, timeoutMs));
});
ipcMain.handle('torrent-stream-url', (event, token, fileIndex) => {
  return torrentServer.ensureServer().then(() => torrentServer.streamUrl(token, fileIndex));
});
ipcMain.handle('torrent-stats', (event, token) => torrentServer.getStats(token));
ipcMain.handle('torrent-stop', (event, token) => { torrentServer.stopTorrent(token); return true; });
// 打开本地预览窗口（由 preload.js 在用户点「预览」时调用；播放器跑在自有 file:// 源上）
ipcMain.handle('open-preview', (event, arg) => {
  const a = arg || {};
  openPreview(a.magnet, a.name, a.movieName);
  return true;
});
// 预览窗口关闭按钮
ipcMain.on('preview-close', () => {
  if (previewWin && !previewWin.isDestroyed()) previewWin.close();
});
