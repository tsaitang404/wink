# wink —— 眨眼式光学文件传输

**屏幕对镜头 wink 传输文件。** 发送端把文件编码成无限流动的喷泉码 QR 流，接收端用摄像头"读旗"重建文件。设备之间**没有任何网络路径**——payload 以光的形式传播。

## 为什么叫 wink

发送端的屏幕/终端对接收端的摄像头"眨眼"（wink），每一眨都是一帧 QR 码；接收端"看到"（sees）足够多帧后，文件就完整到达。一眨眼，文件就到了。

## 三种形态，零依赖

| 形态 | 位置 | 依赖 |
|---|---|---|
| **wink-linux-x86_64**（终端发送端） | Releases | **零**（Rust musl 静态编译单文件） |
| **wink-sender.html**（网页发送端） | Releases | **零**（单 HTML，file:// 双击即用） |
| **wink-receiver.html**（手机接收端） | 部署到静态服务器 | 浏览器（需 https 或 localhost 供摄像头用） |

## 快速开始

### 终端发送
```bash
# 任意 Linux，直接跑（无需安装）
./wink-linux-x86_64 send secret.txt --fps 30
# → 终端显示元信息 QR（接收端先扫码预览）
# → 按 Enter 开始喷泉帧流
# → 按 q 停止
```

### 网页发送
双击打开 `wink-sender.html` → 选文件 → 调整参数 → 点"开始传输"。

### 手机接收
手机浏览器打开 **https://tsaitang404.github.io/wink/**（GitHub Pages 自动部署，每次 push 自动更新）→ 启动摄像头 → 对准发送端二维码。

> 或本地运行：`npx vite build --config receiver/vite.config.ts && npx vite preview --config receiver/vite.config.ts`

## 核心特性

- **喷泉码（LT）**：接收任意 ~1.15×K 个不同帧即可重建，丢帧只损失时间，绝不损失正确性
- **元信息帧**：发送前先显示传输预览 QR（文件大小/K/预估时间/编码方式），接收端扫码即可预览，发送端开始前可调参数
- **协议可协商**：codec 字段预留彩色编码通道（v0.2 实验）
- **SHA-256 校验**：任何内容提供前校验
- **跨语言确定性**：Rust 发送端与 TS 接收端逐位一致（golden 向量锁定）

## 构建

```bash
# TS 侧（shared/receiver/sender-web）
npm install
npm test                          # 单元测试
npm run gen-vectors               # 生成金标准向量（协议改动后）
npx vite build --config sender-web/vite.config.ts   # → sender-web/dist/index.html

# Rust 侧（sender-cli）
cd sender-cli
cargo test                        # 含 golden 向量断言
cargo build --release --target x86_64-unknown-linux-musl
# → target/x86_64-unknown-linux-musl/release/wink（静态单文件）
```

## 文档

- [协议规范](protocol/spec.md) — 帧格式/容器/manifest/喷泉参数
- [详细设计](.hermes/plans/2026-08-09_wink-detailed-design.md)
- [实施规格](.hermes/plans/2026-08-09_wink-impl-spec.md)
- [编码与测试规范](.hermes/plans/2026-08-09_wink-coding-standards.md)

## 许可

MIT
