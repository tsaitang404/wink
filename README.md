# wink

只靠屏幕和镜头传输文件的工具。发送端把文件编码成喷泉码 QR 帧流，接收端用摄像头扫码重建文件。传输过程不经过任何网络，不需要物理连接。

# TODO
[] 多码 zxing支持同时识别多个二维码，可以同时渲染多个二维码来提高带宽
[] 彩码 通过彩色二维码的rgb分量复用一个二维码，提高带宽

## Releases

| 产物 | 架构 | 形态 | 依赖 |
|---|---|---|---|
| **wink-linux-x86_64** | x86_64 | Rust musl 静态编译单文件 | 零 |
| **wink-linux-aarch64** | ARM64 (aarch64) | Rust musl 静态编译单文件 | 零 |
| **wink-sender.html** | 全平台 | 单 HTML（file:// 双击即用） | 零 |
| **wink-receiver.html** | 手机浏览器 | 通过 GitHub Pages 部署 | 浏览器 |

Release 下载：https://github.com/tsaitang404/wink/releases
接收端在线版：https://tsaitang404.github.io/wink/（自动更新）

## 快速开始

### 终端发送
```bash
# 任意 Linux（x86_64 或 ARM64），直接跑，无需安装
chmod +x wink-linux-x86_64
./wink-linux-x86_64 文件 [--fps 30] [--block N]
# → 显示元信息 QR（接收端扫码预览）
# → 按空格开始喷泉帧流
```

播放中命令（底部输入，回车执行）：

| 输入 | 作用 |
|---|---|
| `空格` | 暂停 / 继续 |
| `b<块号>` | 跳到含该块的帧并暂停（如 `b5`） |
| `f<帧号>` | 跳到指定帧并暂停（如 `f42`） |
| `<百分比>%` | 从该百分比位置开始并暂停（如 `50%`） |
| `q` | 退出 |

参数：`--fps` 帧率（默认 30）；`--block` 块长字节，不传则按终端宽度自动优化。

### 网页发送
双击打开 `wink-sender.html` → 选文件 → 调整参数 → 点"开始传输"。

### 手机接收
手机浏览器打开 **https://tsaitang404.github.io/wink/** → 启动摄像头 → 对准发送端二维码。

## 功能

- **喷泉码（LT）**：接收任意 ~1.15×K 个不同帧即可重建，丢帧只损失时间
- **元信息帧**：发送前显示传输预览 QR（文件名/大小/块数/预估时间/编码方式）
- **块级状态**：接收端显示每个块的接收状态（灰=未收、橙=收到未解出、绿=已解出），点击查看块号
- **跳转控制**：发送端可暂停、跳指定帧/块/百分比（b/f/% 命令），暂停时显示目标帧供接收端对焦
- **帧时间线**：接收端按帧显示接收位图（灰/橙/绿三态），作丢帧诊断
- **SHA-256 校验**：接收完成校验，失败不交付
- **跨语言确定性**：Rust 发送端与 TS 接收端逐位一致（golden 向量锁定）
- **自动构建**：CI 构建 x86_64/ARM64 二进制 + 单 HTML，tag 自动发布

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
cargo build --release --target x86_64-unknown-linux-musl    # x86_64
cargo build --release --target aarch64-unknown-linux-musl   # ARM64
```

## 文档

- [协议规范](protocol/spec.md) — 帧格式/容器/manifest/喷泉参数
- [详细设计](.hermes/plans/2026-08-09_wink-detailed-design.md)
- [实施规格](.hermes/plans/2026-08-09_wink-impl-spec.md)
- [编码与测试规范](.hermes/plans/2026-08-09_wink-coding-standards.md)

## 证书

MIT License © 2026 tsaitang404。可自由使用、修改、分发。
