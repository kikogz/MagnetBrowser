// preview-app.js — 预览窗口播放逻辑（运行在 file:// 自有源，无第三方 CSP）
(function () {
  'use strict';
  const B = window.__previewBridge;
  const videoEl = document.getElementById('pwVideo');
  const statusEl = document.getElementById('pwStatus');
  const diagEl = document.getElementById('pwDiag');
  const titleEl = document.getElementById('pwTitle');
  const fileSel = document.getElementById('pwFile');
  const copyBtn = document.getElementById('pwCopy');
  const closeBtn = document.getElementById('pwClose');
  const frameCanvas = document.getElementById('pwFrame');
  const bufBar = document.getElementById('pwBuf');

  const qp = new URLSearchParams(location.search);
  const MAGNET = qp.get('magnet') || '';
  const NAME = qp.get('name') || '视频预览';
  const MOVIE = qp.get('movieName') || '';
  window.__magnet = MAGNET;
  titleEl.textContent = NAME;

  let token = null;
  let closed = false;
  let pollTimer = null;

  function setStatus(html) { statusEl.innerHTML = html; }
  function setDiag(txt) { diagEl.textContent = '诊断：' + txt; }

  function doClose() {
    if (closed) return;
    closed = true;
    if (pollTimer) clearInterval(pollTimer);
    if (token && B) { try { B.stop(token); } catch (e) {} }
    if (B) { try { B.closeWindow(); } catch (e) {} }
  }
  closeBtn.onclick = doClose;
  window.addEventListener('beforeunload', () => { if (token && B) { try { B.stop(token); } catch (e) {} } });

  // 当前文件总字节数（用于缓冲进度条百分比）与正在播放的索引
  let curFileLen = 0;
  let playIdx = -1;

  // 把当前已解码帧绘到 canvas，作为“静止画面”兜底：首帧就绪 / 播放卡顿时显示，避免一直黑屏
  function showStaticFrame() {
    try {
      if (videoEl.readyState >= 2 && videoEl.videoWidth) {
        frameCanvas.width = videoEl.videoWidth;
        frameCanvas.height = videoEl.videoHeight;
        frameCanvas.getContext('2d').drawImage(videoEl, 0, 0, frameCanvas.width, frameCanvas.height);
        frameCanvas.style.display = '';
      }
    } catch (e) {}
  }
  function hideStaticFrame() { frameCanvas.style.display = 'none'; }

  // 缓冲进度条：用 furthest buffered byte / 文件总字节 计算百分比（实时移动，证明非假死）
  function updateBufBar() {
    try {
      if (!curFileLen) return;
      let end = 0;
      for (let i = 0; i < videoEl.buffered.length; i++) end = Math.max(end, videoEl.buffered.end(i));
      const pct = Math.max(0, Math.min(100, end / curFileLen * 100));
      bufBar.style.width = pct.toFixed(1) + '%';
    } catch (e) {}
  }
  function bufferedBytes() {
    let end = 0; try { for (let i = 0; i < videoEl.buffered.length; i++) end = Math.max(end, videoEl.buffered.end(i)); } catch (e) {}
    return end;
  }

  // 首帧解码后：备好静止帧；播放中：显示动态画面、隐藏静止帧；卡顿等待：显示静止帧 + 提示已下载量
  videoEl.addEventListener('loadeddata', () => { showStaticFrame(); setStatus('已解码首帧，准备播放（已缓冲 ' + humanSize(bufferedBytes()) + '）'); });
  videoEl.addEventListener('canplay', () => showStaticFrame());
  videoEl.addEventListener('playing', () => { hideStaticFrame(); setStatus('▶ 播放中：' + (curFileLen ? humanSize(curFileLen) : '')); });
  videoEl.addEventListener('waiting', () => { showStaticFrame(); setStatus('缓冲中…（已下载 ' + humanSize(bufferedBytes()) + '，等待数据）'); });
  videoEl.addEventListener('stalled', () => { showStaticFrame(); });
  videoEl.addEventListener('progress', updateBufBar);
  videoEl.addEventListener('timeupdate', () => { if (!videoEl.paused) hideStaticFrame(); updateBufBar(); });

  copyBtn.onclick = () => {
    try {
      navigator.clipboard.writeText(MAGNET).then(() => setStatus('已复制磁力链接'), () => fallbackCopy());
    } catch (e) { fallbackCopy(); }
    function fallbackCopy() {
      const ta = document.createElement('textarea'); ta.value = MAGNET; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); setStatus('已复制磁力链接'); } catch (e2) { setStatus('复制失败，请手动复制'); }
      document.body.removeChild(ta);
    }
  };

  function pickCoreVideo(files, movieName) {
    const VIDEO_EXT = /\.(mp4|mkv|avi|mov|wmv|flv|webm|m4v|mpg|mpeg|ts|rmvb|vob|ogv|3gp|m2ts|iso)$/i;
    const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
    const mWords = norm(movieName);
    let best = null, bestScore = -1, maxVideo = null;
    for (const f of files) {
      if (!VIDEO_EXT.test(f.name)) continue;
      let score = 0;
      if (mWords.length) {
        const fWords = norm(f.name);
        const hit = mWords.filter((w) => fWords.includes(w)).length;
        if (hit >= Math.ceil(mWords.length / 2)) score = hit;
      }
      if (score > bestScore) { bestScore = score; best = f; }
      if (!maxVideo || f.length > maxVideo.length) maxVideo = f;
    }
    return best || maxVideo || null;
  }

  function humanSize(n) {
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0, x = n;
    while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
    return (i === 0 ? x : x.toFixed(1)) + ' ' + u[i];
  }

  function playIndex(idx, files) {
    playIdx = idx;
    curFileLen = (files[idx] && files[idx].length) || 0;
    bufBar.style.width = '0%';
    B.streamUrl(token, idx).then((url) => {
      videoEl.src = url;
      videoEl.preload = 'auto';
      const p = videoEl.play();
      if (p && p.catch) p.catch(() => {});
      const f = files[idx];
      setStatus('正在连接流并缓冲：' + (f.name || '').split('/').pop() + '（' + humanSize(f.length) + '）— 首帧就绪后会自动出画面');
    }).catch((e) => setStatus('切换失败：' + (e && e.message || e)));
  }

  function showFileSelect(files, selected) {
    if (!files || files.length <= 1) { fileSel.style.display = 'none'; return; }
    fileSel.style.display = '';
    fileSel.innerHTML = '';
    files.forEach((f) => {
      const o = document.createElement('option');
      o.value = f.index; o.textContent = f.name.split('/').pop() + '（' + humanSize(f.length) + '）';
      if (selected != null && f.index === selected) o.selected = true;
      fileSel.appendChild(o);
    });
    fileSel.onchange = () => playIndex(parseInt(fileSel.value, 10), files);
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (!token || closed) return;
      B.stats(token).then((s) => {
        if (!s) return;
        if (s.webseed) setDiag('WebSeed 代理拉流中（无需做种者，取决于源站是否可达）');
        else setDiag('主进程 P2P：peers ' + (s.peers || 0) + ' · 已下载 ' + humanSize(s.downloaded || 0));
      }).catch(() => {});
    }, 1500);
  }

  async function main() {
    if (!MAGNET) { setStatus('未收到磁力链接'); return; }
    let avail = { ok: true };
    try { avail = await B.available(); } catch (e) {}
    if (avail && avail.ok === false) {
      setStatus('播放引擎未加载：' + (avail.error || '未知') + '，请复制磁力用外部播放器打开。');
      setDiag('主进程模块缺失');
      return;
    }
    setStatus('<span class="spinner"></span>正在通过 DHT / Tracker 寻找做种者…（已等待 0s，最长约 90s）');
    setDiag('已提交主进程：' + MAGNET.slice(0, 40) + '…');
    const startedAt = Date.now();
    const waitTick = setInterval(() => {
      const sec = Math.round((Date.now() - startedAt) / 1000);
      setStatus('<span class="spinner"></span>正在通过 DHT / Tracker 寻找做种者…（已等待 ' + sec + 's，最长约 90s）');
    }, 1000);
    let res;
    try {
      res = await B.addMagnet(MAGNET, 90000);
    } catch (e) {
      clearInterval(waitTick);
      setStatus('连接失败：' + (e && e.message || e) + '。可复制后用外部播放器打开。');
      setDiag('失败原因：' + (e && e.message || e) + ' — 多为网络到不了 DHT/Peer 或该磁力无做种者；可换网络/代理，或复制磁力用外部播放器。');
      return;
    }
    clearInterval(waitTick);
    token = res.token;
    const files = res.files || [];
    if (!files.length) { setStatus('种子内未找到文件，请复制磁力用外部播放器打开。'); setDiag('空种子'); return; }
    const file = pickCoreVideo(files, MOVIE);
    showFileSelect(files, file ? file.index : null);
    if (!file) {
      setStatus('未找到可播放的视频文件，请从上方列表手动选择，或复制磁力用外部播放器打开。');
      setDiag('无视频文件，已列出全部文件');
      return;
    }
    startPolling();
    playIndex(file.index, files);
  }

  main();
})();
