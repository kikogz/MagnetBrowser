// torrent-server.js — 主进程侧 BitTorrent 流式服务（TCP/DHT 经典种子 + WebSeed 代理兜底）
// 设计要点：
//  1) 预览播放器只负责 <video> 渲染，所有 P2P / 下载都在主进程完成，彻底避开
//     第三方页面的 CSP 钳制、浏览器 WebRTC 限制、以及 webtorrent.io 源依赖。
//  2) 本地用普通 http://127.0.0.1 提供服务（不再走自签名 https，消除证书回调 bug）。
//  3) 两条取流路径：
//     a. 经典 TCP/DHT 种子 -> torrent-stream（Node 直连外网，不受 CSP）流式喂 <video>；
//     b. 纯 WebSeed 种子（如 Sintel）-> 主进程直接走 HTTP Range 代理该 WebSeed URL（不需要做种者）。
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const parseTorrent = require('parse-torrent');

let TorrentStream = null;
let loadError = null;
try {
  TorrentStream = require('torrent-stream');
} catch (e) {
  loadError = e;
}

// 可写配置文件目录：与 main.js 保持一致
// 打包后 = exe 同级/cache/config；开发期 = 项目根/cache/config
// 首次运行由 main.js 从 src/config 复制默认 trackers.json 到此（asar 只读，不能原地写）
const _cfgRoot = app.isPackaged ? path.dirname(process.execPath) : path.resolve(__dirname, '..');
const TRACKERS_FILE = path.join(_cfgRoot, 'cache', 'config', 'trackers.json');

let server = null;
let port = 0;
let tokenSeq = 0;
const engines = new Map(); // token -> record

// 给经典种子追加的公共 Tracker 列表，提升 Peer / 做种者命中率。
// 同时包含 UDP 与 HTTP(S) 两类：很多网络（公司网/部分 ISP/沙箱）会掐 BitTorrent 的 UDP 流量，
// 此时 HTTP(S) Tracker 仍能工作，是“找不到做种者”时的主要救命通道。
// 列表优先从运行时可写目录 cache/config/trackers.json 读取（首次运行由 main.js 从 src/config 复制，
// 方便用户自行增删、且不会写进 asar 只读层）；读取失败则回退到下方内置默认。
// 内置默认（与 src/config/trackers.json 初始内容一致）：trackers.json 缺失/损坏时的回退，
// 也是设置面板「恢复默认」按钮的还原目标。
const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://tracker.leechers-paradise.org:6969/announce',
  'udp://tracker.internetwarriors.net:1337/announce',
  'udp://tracker.pirateparty.gr:6969/announce',
  'udp://tracker.cyberia.is:6969/announce',
  'udp://retracker.lanta-net.ru:2710/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.uw0.xyz:6969/announce',
  'udp://tracker.moeking.me:6969/announce',
  'udp://tracker.zerobytes.xyz:1337/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://tracker.theoks.net:6969/announce',
  'udp://tracker.open.gumse.com:6969/announce',
  'udp://tracker.filemail.com:6969/announce',
  'udp://tracker.skyts.net:6969/announce',
  'udp://tracker.bitcoinlinks.org:6969/announce',
  'http://tracker.opentrackr.org:1337/announce',
  'http://torrent.ubuntu.com:6969/announce',
  'http://p4p.arenabg.com:1337/announce',
  'https://tracker.nanoha.org:443/announce',
  'http://tracker.internetwarriors.net:1337/announce',
  'http://tracker.tiny-vps.com:6969/announce',
  'http://tracker.openbittorrent.com:80/announce',
  'https://tracker.gbitt.info:443/announce',
  'http://tracker.gbitt.info:80/announce',
  'http://retracker.lanta-net.ru:2710/announce',
  'http://tracker.files.fm:6969/announce'
];

let TRACKERS = DEFAULT_TRACKERS.slice();

function loadTrackers() {
  try {
    const p = TRACKERS_FILE;
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (Array.isArray(raw) && raw.length) {
      TRACKERS = raw.filter((x) => typeof x === 'string' && /^https?:\/\//i.test(x) || /^udp:\/\//i.test(x));
      if (TRACKERS.length) return;
    }
  } catch (e) {}
  TRACKERS = DEFAULT_TRACKERS.slice();
}
loadTrackers();

// 供设置面板「Tracker 维护」调用：重新读取磁盘上的 trackers.json（即时生效）
function reloadTrackers() { loadTrackers(); }
function getTrackers() { return TRACKERS.slice(); }
function getDefaultTrackers() { return DEFAULT_TRACKERS.slice(); }

const VIDEO_EXT = /\.(mp4|mkv|avi|mov|wmv|flv|webm|m4v|mpg|mpeg|ts|rmvb|vob|ogv|3gp|m2ts|iso)$/i;

function isAvailable() { return !!TorrentStream; }
function getLoadError() { return loadError ? (loadError.message || String(loadError)) : null; }

// 解析磁力参数（xt/dn/tr/ws/xs），不需要额外依赖
function parseMagnetParams(magnet) {
  const out = { infoHash: '', name: '', trackers: [], ws: [], xs: '' };
  try {
    const q = magnet.indexOf('?') >= 0 ? magnet.slice(magnet.indexOf('?') + 1) : '';
    q.split('&').forEach((p) => {
      const i = p.indexOf('=');
      const k = i >= 0 ? decodeURIComponent(p.slice(0, i)) : decodeURIComponent(p);
      const v = i >= 0 ? decodeURIComponent(p.slice(i + 1)) : '';
      if (k === 'xt') out.infoHash = v.replace(/urn:btih:/i, '').toLowerCase();
      else if (k === 'dn') out.name = v;
      else if (k === 'tr') out.trackers.push(v);
      else if (k === 'ws') out.ws.push(v);
      else if (k === 'xs') out.xs = v;
    });
  } catch (e) {}
  return out;
}

// 给磁力串追加公共 tracker（仅当原串缺少时），提升 Peer 发现
function withExtraTrackers(magnet) {
  const p = parseMagnetParams(magnet);
  let m = magnet;
  TRACKERS.forEach((t) => {
    if (!p.trackers.some((x) => x.toLowerCase().includes(t.split('://')[1] ? t.split('://')[1].split('/')[0] : t))) {
      m += '&tr=' + encodeURIComponent(t);
    }
  });
  return m;
}

function ensureServer() {
  return new Promise((resolve, reject) => {
    if (server) return resolve(port);
    server = http.createServer(handler);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(port); });
  });
}

function humanSize(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let x = n;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return (i === 0 ? x : x.toFixed(1)) + ' ' + u[i];
}

// 选核心视频文件：靠电影名匹配 > 同扩展名体积最大 > 第一个视频
function pickCoreVideo(files, movieName) {
  if (!files || !files.length) return null;
  const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
  const mWords = norm(movieName);
  let best = null; let bestScore = -1; let maxVideo = null;
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

// 添加磁力：返回 { token, infoHash, files:[{index,name,length}] }
// 路由策略：
//  - 含 WebSeed 参数(ws/xs)的种子：先走 WebSeed 直拉（最快、最稳，不依赖做种者），失败再回退 DHT；
//  - 经典 TCP/DHT 种子（无 ws/xs）：直接走 torrent-stream，失败则报错。
function addMagnet(magnet, timeoutMs) {
  timeoutMs = timeoutMs || 90000;
  const params = parseMagnetParams(magnet);
  const hasWebSeed = !!(params.ws.length || params.xs);
  return new Promise((resolve, reject) => {
    if (!TorrentStream) { return reject(new Error('主进程播放引擎未加载（torrent-stream 缺失）')); }
    const token = 't' + (++tokenSeq) + '_' + Date.now().toString(36);
    let settled = false;
    // 单一 settle 入口，避免双路径竞态导致 Promise 永远不 resolve
    const finish = (rec) => { if (!settled) { settled = true; resolve(rec); } };
    const fail = (err) => { if (!settled) { settled = true; reject(err); } };

    if (hasWebSeed) {
      // 纯 WebSeed 路径：主进程直接走 HTTP Range 代理该 WebSeed 源（不并启动 torrent-stream，避免竞态）
      fallbackWebSeed(token, magnet, params, finish, fail);
    } else {
      // 经典 TCP/DHT 路径：torrent-stream 直连外网取元数据 + 流式喂 <video>
      let engine;
      try { engine = TorrentStream(withExtraTrackers(magnet)); } catch (e) { return fail(e); }
      const timer = setTimeout(() => {
        try { engine.destroy(); } catch (_) {}
        fail(new Error('主进程未在限定时间内找到做种者（可能网络到不了 DHT/Peer）'));
      }, timeoutMs);
      engine.on('torrent', () => {
        clearTimeout(timer);
        const files = engine.files.map((f, i) => ({ index: i, name: f.name, length: f.length }));
        engines.set(token, { kind: 'ts', engine, infoHash: params.infoHash || '', files, startedAt: Date.now() });
        finish({ token, infoHash: params.infoHash || '', files });
      });
      engine.on('error', (e) => { clearTimeout(timer); try { engine.destroy(); } catch (_) {} fail(e); });
    }
  });
}

// 路径 b：WebSeed 代理（从 xs 取 .torrent 元数据，主进程走 HTTP Range 拉 WebSeed 文件）
function fallbackWebSeed(token, magnet, params, finish, fail, prevErr) {
  if (!params.xs && !params.ws.length) {
    return fail(prevErr || new Error('无做种者且无可用的 WebSeed 源'));
  }
  const xs = params.xs || (params.ws[0] + (params.name ? encodeURIComponent(params.name) : ''));
  https.get(xs, { timeout: 12000, rejectUnauthorized: false }, (res) => {
    if (res.statusCode !== 200) { res.resume(); return fail(prevErr || new Error('WebSeed 元数据获取失败（HTTP ' + res.statusCode + '）')); }
    const chunks = [];
    res.on('data', (d) => chunks.push(d));
    res.on('end', () => {
      try {
        const buf = Buffer.concat(chunks);
        const t = parseTorrent(buf);
        const files = (t.files || []).map((f, i) => ({ index: i, name: f.name, length: f.length }));
        const base = (params.ws[0] || xs.replace(/\/[^/]*$/, '/')).replace(/\/?$/, '/');
        // 每个文件的实际 WebSeed 地址：优先用 .torrent 里的 urlList（精确地址），否则用基址+文件名兜底
        const urlList = (t.urlList && t.urlList.length) ? t.urlList : [];
        const wsUrls = files.map((f, i) => urlList[i] || (base + encodeURIComponent(f.name)));
        const rec = {
          kind: 'ws',
          infoHash: t.infoHash || params.infoHash,
          files,
          base,
          wsUrls,
          startedAt: Date.now()
        };
        engines.set(token, rec);
        finish({ token, infoHash: rec.infoHash, files });
      } catch (e) {
        fail(prevErr || new Error('WebSeed 元数据解析失败：' + e.message));
      }
    });
  }).on('error', () => fail(prevErr || new Error('WebSeed 源不可达'))).on('timeout', function () { this.destroy(); fail(prevErr || new Error('WebSeed 元数据获取超时')); });
}

function streamUrl(token, fileIndex) {
  return `http://127.0.0.1:${port}/${token}/${fileIndex}`;
}

function getStats(token) {
  const rec = engines.get(token);
  if (!rec) return { peers: 0, downloaded: 0, webseed: rec ? rec.kind === 'ws' : false };
  if (rec.kind === 'ws') return { peers: 0, downloaded: 0, webseed: true };
  try {
    const swarm = rec.engine.swarm;
    return { peers: swarm && swarm.wires ? swarm.wires.length : 0, downloaded: swarm ? swarm.downloaded : 0, webseed: false };
  } catch (e) { return { peers: 0, downloaded: 0, webseed: false }; }
}

function stopTorrent(token) {
  const rec = engines.get(token);
  if (rec) { engines.delete(token); try { if (rec.engine) rec.engine.destroy(); } catch (e) {} }
}

// HTTP 处理器：GET /<token>/<fileIndex> ，支持 Range 流式播放
function handler(req, res) {
  const u = (req.url || '').split('?')[0];
  const parts = u.split('/').filter(Boolean);
  const token = parts[0];
  const fileIndex = parseInt(parts[1] || '0', 10);
  const rec = engines.get(token);
  if (!rec) { res.writeHead(404); res.end('torrent not ready'); return; }

  const range = req.headers.range;
  let start = 0, end = null, isRange = false;
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    if (m) { isRange = true; start = parseInt(m[1], 10); end = m[2] ? parseInt(m[2], 10) : null; }
  }

  if (rec.kind === 'ts') {
    const file = rec.engine.files && rec.engine.files[fileIndex];
    if (!file) { res.writeHead(404); res.end('no such file'); return; }
    const total = file.length;
    if (end == null) end = total - 1;
    if (start > end || start >= total) { res.writeHead(416); res.end(); return; }
    res.writeHead(isRange ? 206 : 200, {
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': 'video/mp4'
    });
    try {
      const stream = file.createReadStream({ start: start, end: end });
      stream.on('error', () => { try { res.destroy(); } catch (_) {} });
      stream.pipe(res);
    } catch (e) { try { res.destroy(); } catch (_) {} }
    return;
  }

  // WebSeed 代理模式：主进程代 <video> 去远端拉 Range
  const fname = (rec.files[fileIndex] && rec.files[fileIndex].name) || '';
  const remote = (rec.wsUrls && rec.wsUrls[fileIndex]) || (rec.base + encodeURIComponent(fname));
  const opts = { method: 'GET', headers: {}, rejectUnauthorized: false };
  if (isRange) opts.headers.Range = `bytes=${start}-${end == null ? '' : end}`;
  const r = https.request(remote, opts, (up) => {
    res.writeHead(up.statusCode, {
      'Content-Range': up.headers['content-range'] || '',
      'Accept-Ranges': up.headers['accept-ranges'] || 'bytes',
      'Content-Length': up.headers['content-length'] || '',
      'Content-Type': up.headers['content-type'] || 'video/mp4'
    });
    up.pipe(res);
  });
  r.on('error', (e) => { res.writeHead(502); res.end('webseed proxy error: ' + e.message); });
  r.end();
}

module.exports = { isAvailable, getLoadError, ensureServer, streamUrl, addMagnet, getStats, stopTorrent, pickCoreVideo, humanSize, reloadTrackers, getTrackers, getDefaultTrackers };
