// preview-preload.js — 预览窗口的预加载（contextIsolation 下把主进程 IPC 暴露给页面）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__previewBridge', {
  // 主进程播放引擎是否可用
  available: () => ipcRenderer.invoke('torrent-available'),
  // 添加磁力并等待元数据：返回 { token, infoHash, files:[{index,name,length}] }
  addMagnet: (magnet, timeoutMs) => ipcRenderer.invoke('torrent-add', magnet, timeoutMs),
  // 仅构建某文件的本地流地址
  streamUrl: (token, fileIndex) => ipcRenderer.invoke('torrent-stream-url', token, fileIndex),
  // 实时进度（peers / 已下载字节）
  stats: (token) => ipcRenderer.invoke('torrent-stats', token),
  // 关闭并销毁种子（释放带宽）
  stop: (token) => ipcRenderer.invoke('torrent-stop', token),
  // 关闭预览窗口
  closeWindow: () => ipcRenderer.send('preview-close')
});
