# MagnetBrowser

Electron + Node.js 桌面应用：内嵌一个简易浏览器访问指定网址，对网页做二次加工
（去广告、隐藏/删除指定栏目、自动识别磁力链接、悬停悬浮预览）。

## 目录结构

```
MagnetBrowser/
├── package.json              # 项目配置（main 指向 src/main.js）
├── package-lock.json
├── .gitignore
├── docs/
│   └── 可行性分析与实现方案.md   # 可行性分析与架构设计
├── src/                     # 应用源码
│   ├── main.js              # 主进程：建窗、读规则、IPC 桥接
│   ├── preload-main.js      # 窗口自身 preload（contextBridge 暴露 API）
│   ├── index.html           # 工具栏 + <webview> 容器
│   ├── renderer.js          # 工具栏逻辑、规则下发、磁力计数
│   ├── preload.js           # 访客预加载：磁力识别 + 悬浮预览 + 栏目删除
│   └── config/
│       └── filter-rules.json   # 过滤规则（CSS 隐藏 / DOM 删除选择器）
├── node_modules/            # 依赖（git 忽略）
└── .workbuddy/              # 项目记忆（WorkBuddy 内部）
```

## 环境要求

- Node.js ≥ 18（本机当前 v22.x）
- Electron 30.x（已安装，二进制在 node_modules/electron/dist）

## 安装与运行

```bash
npm install      # 首次或更新依赖；国内可设 ELECTRON_MIRROR 加速
npm start        # 启动应用（需要带显示器的 GUI 环境）
```

> 镜像加速（可选）：`npm install` 前执行
> `export ELECTRON_MIRROR="https://cdn.npmmirror.com/binaries/electron/"`

## 技术要点

- 用 `<webview>` 标签内嵌目标站（跨版本稳定）。
- 内容过滤走宿主下发的 `insertCSS` / `executeJavaScript`，**不受目标站 CSP 限制**。
- 磁力识别：正则 + `MutationObserver` 覆盖动态加载；命中经 `ipcRenderer.sendToHost` 上报。
- 悬浮预览：页内 overlay div（`z-index` 最大值）。

## 开发里程碑

- M0 骨架（已完成）：`<webview>` + 工具栏跑通
- M1 过滤：接入 filter-rules.json，CSS 隐藏 + DOM 删除
- M2 磁力 + 悬浮：扫描、MutationObserver、页内 overlay、计数器
- M3 规则中心：按域名定制、可视化编辑、热更新
- M4 DHT 元数据：主进程子进程解析文件列表/大小
- M5 打磨 + 打包（electron-builder）
