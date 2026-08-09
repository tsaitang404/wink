# wink 实现计划：旗语式光学文件传输

> **For Hermes:** 用 subagent-driven-development 按任务逐个实现。

**Goal:** 在 `/data/code/wink` 新建一个"屏幕/终端 → 摄像头"文件传输工具。**wink（旗语）**——人类最早的视觉通信方式，屏幕对摄像头就是现代旗语：发送端把文件编码成无限流动的 QR 码，接收端用摄像头"读旗"重建文件。发送端两种实现（Linux 静态二进制 + 单 HTML 网页），接收端一个手机网页。

**Architecture:** 借鉴 decimen-optical-transfer（MIT）的单向光学信道思路——发送端把文件切成块，用 LT 喷泉码（Luby transform）编码成无限循环的 QR 帧流；接收端摄像头收集任意约 K·1.15 个不同帧即可重建文件。无握手、无重传、丢帧只损失时间。

**Tech Stack:**
- 接收端：TypeScript + Vite（zxing-wasm 解码）+ 需要服务器托管（手机摄像头要求安全上下文）
- 终端发送端：**Rust**（qrcode crate 纯 Rust，**零 C 依赖**）+ musl 静态编译单文件 —— **不用 Go**
- 网页发送端：TypeScript + Vite + **vite-plugin-singlefile 内联成单个 HTML**，file:// 双击即用，零依赖
- 协议核心：移植 decimen 的 `dlog`（精确 IEEE-754 运算，跨语言确定性）+ soliton 分布 + 自描述帧头

## 部署约束（2026-08-09 用户明确，最高优先级）

**发送端必须在任意机器上零依赖直接运行：**

| 场景 | 方案 | 依赖 |
|---|---|---|
| 任意 Linux（可能无 OpenCV/动态库、glibc 版本旧） | **Rust musl 静态编译单文件**，`qrcode` crate 纯 Rust 无 C 依赖 | 零（`file` 验证 statically linked） |
| Windows（无任何工具链） | **单 HTML 网页发送端**，file:// 双击浏览器打开 | 零（浏览器自带） |
| Chrome 桌面 | 同一单 HTML | 零 |

- sender-cli **不用 OpenCV/GLFW/libcimbar 那套**（C++ 动态库依赖，目标机器可能没有）
- sender-web 构建产物 = **一个 .html 文件**（JS/CSS/WASM 全内联），不是需要服务器的 SPA
- 可选加分项：Rust 交叉编译 Windows 静态二进制（`x86_64-pc-windows-gnu`），但**默认交付 HTML 版**保证 Windows 可用

## 目录结构

```
/data/code/wink/
├── protocol/            # 共享协议定义（单一事实源）
│   ├── spec.md          # 帧格式、容器格式、喷泉码参数（人类可读）
│   └── golden-vectors/  # 金标准字节向量（跨语言测试用）
├── receiver/            # 接收端：手机网页（Vite + TS）
│   ├── src/main.ts      # 摄像头 → zxing-wasm 解码 → 喷泉解码 → 文件
│   ├── src/fountain.ts  # dlog + soliton + LT 解码器（移植自 decimen）
│   ├── src/protocol.ts  # 帧头解析、容器解析、SHA-256 校验
│   └── index.html
├── sender-cli/          # 终端发送端：Rust 静态二进制（零依赖）
│   ├── src/main.rs      # CLI：读文件 → 切块 → 喷泉编码 → ANSI 帧流
│   ├── src/fountain.rs  # dlog + soliton + LT 编码器（与 TS 版比特一致）
│   ├── src/qr.rs        # qrcode crate → ANSI 半块字符渲染
│   └── Cargo.toml
├── sender-web/          # 前端发送端：单 HTML（vite-plugin-singlefile 内联）
│   ├── src/main.ts      # 选文件 → 喷泉编码 → canvas QR 帧流
│   └── index.html
├── docs/
│   ├── README.md
│   └── protocol.md
├── SKILL.md             # 项目技能（每仓库建 SKILL.md 惯例）
└── package.json         # workspace：receiver + sender-web
```

## 协议设计（v0.1，简版 decimen）

### 帧头（16 字节，小端）
```
0  u8   magic 0x57  (wink)
1  u8   version 0x01
2  u16  sessionId       随机，每次发送端启动更换
4  u32  seq             帧序号，驱动喷泉 PRNG
8  u16  k               源块数量
10 u16  blockLen        本帧载荷字节数
12 u32  totalLen        文件容器总长
```

### 容器（载荷内部）
```
0  u8   类型：0=文件 1=文本
1  u8   压缩：0=无 1=gzip
2  u32  原始大小
6  u32  文件名长度 + 文件名(UTF-8)
.. u32  payloadFnv  容器 FNV-1a 校验
.. bytes 文件字节（可 gzip）
32 bytes SHA-256（可选，v0.2 加）
```

### 喷泉码参数（v0.1）
- 块大小：按帧容量自适应（终端 v15 约 500B → 块 64B；前端 v40 → 块 2953B 简化为固定 1024B 起步）
- 分布：robust-soliton，R=K 的经典参数（δ=0.5, c=0.1）
- PRNG：splitmix32（decimen 用），seq 驱动
- 冗余目标：接收 ~1.15K 帧完成

### 为什么不用循环重传
单向信道无反向通道。循环发 0..K-1 块，丢一帧要等整轮。喷泉码任意 1.15K 帧可解，丢帧零成本。

## 任务分解

### Task 1: 项目骨架
**Files:** `/data/code/wink/` 全部目录 + `package.json` + `Cargo.toml` + `README.md`
**Step 1:** `mkdir -p` 各目录，`git init`（init 时加 .gitignore: node_modules/ dist/ target/）
**Step 2:** package.json workspace + Cargo.toml（qrcode = "0.14"）
**Step 3:** 提交

### Task 2: 协议规范 + 金标准向量
**Files:** `protocol/spec.md`、`protocol/golden-vectors/frame-*.bin`
**Step 1:** 写 spec.md（上面帧头/容器/喷泉参数）
**Step 2:** 生成 3 组金标准：空帧、1 块文件帧、多块文件帧（固定 session/seq/k，手算 FNV）
**Step 3:** 提交

### Task 3: TS 端 fountain + protocol（接收端核心，TDD）
**Files:** `receiver/src/fountain.ts`、`receiver/src/protocol.ts`、`receiver/tests/fountain.test.ts`、`receiver/tests/protocol.test.ts`
**Step 1:** 写测试：dlog 固定值断言（移植 decimen tests/fountain.test.ts 的已知值）、solitonCdf、encode/decode 往返
**Step 2:** 实现 dlog（精确 IEEE-754）、soliton、splitmix32、LT 编解码、帧头 pack/parse、容器 pack/parse
**Step 3:** `npm test` 全绿
**Step 4:** 提交

### Task 4: Rust 端 fountain + protocol（终端发送端核心，跨语言一致）
**Files:** `sender-cli/src/fountain.rs`、`sender-cli/src/protocol.rs`、`sender-cli/tests/fountain.rs`
**Step 1:** 写测试：同样的 dlog 固定值（与 TS 测试完全一致）、solitonCdf、往返
**Step 2:** 实现 dlog/soliton/splitmix32/LT 编码/帧头 pack
**Step 3:** `cargo test` 全绿 + 与 TS 金标准向量对比（读 golden-vectors 断言）
**Step 4:** 提交
**关键：** Rust 版 dlog 必须与 TS 版逐位一致——测试锁死字节。

### Task 5: 终端 QR 渲染
**Files:** `sender-cli/src/qr.rs`
**Step 1:** qrcode crate 生成 QR 矩阵 → ANSI 半块字符（上块 ▀ 下块 ▄ 全块 █ 空 空格 + 背景色）
**Step 2:** 输出测试：生成一个已知 payload 的 QR，目测可扫（用手机验证）
**Step 3:** 提交

### Task 6: sender-cli 主流程
**Files:** `sender-cli/src/main.rs`
**Step 1:** 参数解析（`wink send file.txt [--fps 10] [--block 64] [--text]`）
**Step 2:** 读文件 → 容器打包（FNV + 可选 gzip）→ 切块 → 无限循环生成帧 → ANSI 渲染 → 清屏重画（`\x1b[2J\x1b[H`）+ 帧率控制（sleep）
**Step 3:** 手动验证：手机打开接收页对准终端，能收到文件
**Step 4:** 提交

### Task 7: receiver 网页
**Files:** `receiver/index.html`、`receiver/src/main.ts`、`receiver/src/decode-worker.ts`
**Step 1:** 摄像头 getUserMedia → zxing-wasm worker 解码 → 帧头解析 → 喷泉解码器
**Step 2:** 进度条（已收帧数/K）→ 完成时容器解析 + FNV 校验 + 下载链接
**Step 3:** 手机浏览器实测：能从 sender-cli 终端和 sender-web 收到文件
**Step 4:** 提交

### Task 8: sender-web 单 HTML 网页
**Files:** `sender-web/index.html`、`sender-web/src/main.ts`、`sender-web/vite.config.ts`
**Step 1:** 选文件 → 同 protocol.ts 编码 → canvas 每帧画 QR（qrcode 库）
**Step 2:** 帧率控制（requestAnimationFrame 或 setInterval 按 fps）
**Step 3:** vite-plugin-singlefile 构建 → `dist/wink-sender.html` 单文件（JS/CSS 全内联）
**Step 4:** Chrome 双击 file:// 打开实测：与 receiver 配对成功
**Step 5:** 提交

### Task 9: 静态二进制构建（零依赖验证）
**Files:** `sender-cli/`（构建配置）、`.github/workflows/build.yml`
**Step 1:** `rustup target add x86_64-unknown-linux-musl && cargo build --release --target x86_64-unknown-linux-musl`
**Step 2:** 验证 `file wink` 输出 "statically linked"；`ldd wink` 报 "not a dynamic executable"
**Step 3:** 可选：`rustup target add x86_64-pc-windows-gnu` 交叉编译 Windows 版（加分项，不阻塞）
**Step 4:** CI workflow 产出 Linux musl + Windows GNU 两个二进制 + sender-web 单 HTML
**Step 5:** 提交 + 打 tag v0.1.0 + Release notes + README

### Task 10: 文档 + SKILL.md
**Files:** `docs/README.md`、`docs/protocol.md`、`SKILL.md`
**Step 1:** 用户文档（发送/接收流程、终端 vs 网页对比、性能数字）
**Step 2:** 协议文档（帧格式表、喷泉参数、跨语言确定性说明）
**Step 3:** SKILL.md（触发条件、构建命令、测试命令、坑：跨语言 dlog、终端 QR 容量、帧率）
**Step 4:** 提交

## 验证清单

- [ ] `cd sender-cli && cargo test` 全绿，且 golden-vectors 断言通过（与 TS 字节一致）
- [ ] `cd receiver && npm test` 全绿（同一组固定值）
- [ ] 终端：`wink send docs/README.md --fps 10` → 手机接收页收到完整文件，SHA-256 匹配
- [ ] **零依赖**：`file wink` → "statically linked"；`ldd wink` → "not a dynamic executable"
- [ ] 在干净 Linux 容器/无开发工具机器上跑 `wink` 正常（模拟目标环境）
- [ ] 网页：双击 `wink-sender.html`（file:// 无服务器）→ 选文件 → 手机接收页收到，SHA-256 匹配
- [ ] 断帧测试：手挡住摄像头 1 秒 → 传输继续完成（喷泉容错）

## 风险与权衡

| 风险 | 缓解 |
|---|---|
| **Rust/JS 浮点不一致**（soliton 分布偏差 → 静默解码失败） | dlog 只用 IEEE-754 基础运算；金标准向量双端锁死；测试必跑 |
| **目标机无动态库/旧 glibc** | musl 静态编译（零依赖）；`ldd` 验证；CI 出 Linux+Windows 双产物 |
| **Windows 无工具链** | 单 HTML 发送端 file:// 即用（浏览器自带）；Windows 二进制仅加分项 |
| **终端 QR 容量小、带宽低**（~2-10 KB/s） | 定位为"小文件/配置/文本"场景；文档写明限制；前端路径给高带宽方案 |
| **终端清屏闪烁** | ANSI 清屏 + 静帧渲染；帧率默认 10fps 可调 |
| **接收端需要安全上下文**（手机摄像头） | 接收端必须 https/localhost 托管（局域网 http 也可，Chrome flag 例外）；发送端无此限制（纯 canvas/终端） |

## 开放问题

1. 终端渲染用 ANSI 半块（黑白）还是全色块（更高密度但终端兼容性差）？——v0.1 黑白半块，先跑通
2. 是否需要文本片段模式？——终端路径文本传输很有用（SSH 到服务器发个配置），v0.1 加上（成本低）
3. 接收端是否需要 PWA 离线？——v0.1 单页即可，PWA 后置
