// preload-main.js — 主窗口（index.html）的预加载，桥接主进程 API 给渲染进程
// 通过 contextBridge 安全暴露 API 给渲染进程
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 接收主进程下发的过滤规则
  receiveRules: (cb) => {
    ipcRenderer.on('rules', (_e, rules) => cb(rules));
  },
  // 接收主进程下发的设置
  receiveSettings: (cb) => {
    ipcRenderer.on('settings', (_e, s) => cb(s));
  },
  // 向主进程保存设置
  sendSettings: (s) => {
    ipcRenderer.send('save-settings', s);
  },
  // ---- 地址本 ----
  getAddressBook: () => ipcRenderer.invoke('get-address-book'),
  addAddress: (url) => ipcRenderer.invoke('add-address', url),
  deleteAddress: (url) => ipcRenderer.invoke('delete-address', url),
  setAddressActive: (url, active) => ipcRenderer.invoke('set-address-active', url, active),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  openAddrPanelWindow: () => ipcRenderer.send('open-addr-panel-window'),
  openAddrDropdown: (rect) => ipcRenderer.send('open-addr-dropdown', rect),
  // 地址本右侧面板：测速 / 立即采集
  speedTest: (urls) => ipcRenderer.invoke('speed-test', urls),
  getSpeeds: () => ipcRenderer.invoke('get-speeds'),
  onSpeedProgress: (cb) => ipcRenderer.on('speed-progress', (_e, r) => cb(r)),
  extractNow: () => ipcRenderer.send('extract-now'),
  onAddressBookUpdated: (cb) => {
    ipcRenderer.on('address-book-updated', (_e, list) => cb(list));
  },
  // ---- 自定义标题栏：窗口控制（最小化 / 最大化 / 关闭） ----
  windowControl: (action) => {
    ipcRenderer.send('window-control', action);
  },
  // ---- 内嵌网页（主进程 BrowserView）控制 ----
  navigate: (url) => ipcRenderer.invoke('navigate', url),
  goBack: () => ipcRenderer.send('go-back'),
  reload: () => ipcRenderer.send('reload'),
  injectCss: (css) => ipcRenderer.invoke('inject-css', css),
  execJs: (code) => ipcRenderer.invoke('exec-js', code),
  onPageNavigated: (cb) => {
    ipcRenderer.on('page-navigated', (_e, d) => cb(d));
  },
  onPageLoading: (cb) => {
    ipcRenderer.on('page-loading', (_e, loading) => cb(loading));
  },
  onPageError: (cb) => {
    ipcRenderer.on('page-error', (_e, d) => cb(d));
  },
  // 浮层避让：下拉 / 设置弹窗 打开时让 BrowserView 让位（纯 setBounds，关闭即恢复）
  setOverlay: (mode) => ipcRenderer.send('set-overlay', mode),
  // ---- 版本号 ----
  getVersion: () => ipcRenderer.invoke('get-version'),
  // ---- Tracker 维护（设置弹窗内专用栏） ----
  getTrackers: () => ipcRenderer.invoke('get-trackers'),
  saveTrackers: (list) => ipcRenderer.invoke('save-trackers', list),
  resetTrackers: () => ipcRenderer.invoke('reset-trackers'),
  // ---- 广告拦截规则维护（设置弹窗内专用栏） ----
  getRules: () => ipcRenderer.invoke('get-rules'),
  saveRules: (list) => ipcRenderer.invoke('save-rules', list),
  resetRules: () => ipcRenderer.invoke('reset-rules')
});
