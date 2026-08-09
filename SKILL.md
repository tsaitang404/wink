---
name: wink
description: wink 眨眼式光学文件传输项目——终端/屏幕对摄像头传文件（喷泉码 QR，零依赖）。构建、测试、跨语言一致性、踩坑都在这里。
version: 1.0.0
---

# wink 项目技能

wink 把文件编码成喷泉码（LT）QR 帧流，屏幕/终端对摄像头"眨眼"传文件，无网络路径。发送端两种（Rust 静态二进制 + 单 HTML），接收端一个网页。

## 触发条件

- 构建/测试 wink 或改协议
- 处理跨语言不一致（Rust/TS 字节差异）
- 改 QR 编码/解码链路
- 任何 wink 相关开发

## 关键命令

```bash
# 测试
cd /data/code/wink && npm test                    # TS 单测
cd sender-cli && PATH=/usr/bin:$PATH cargo test   # Rust 单测 + golden 断言
cd sender-cli && PATH=/usr/bin:$PATH cargo clippy -- -D warnings   # 必须零警告

# 构建
cd sender-cli && PATH=/usr/bin:$PATH cargo build --release --target x86_64-unknown-linux-musl
# → target/x86_64-unknown-linux-musl/release/wink（static-pie 单文件）
npx vite build --config sender-web/vite.config.ts  # → sender-web/dist/index.html
```

## 跨语言一致性（最重要）

**发送端 Rust 与接收端 TS 必须逐位一致**，靠 `protocol/golden-vectors/` 锁定：
- `dlog-vector.tsv`（500 个 hex）、`soliton-k100.bin`、`frame-session1.bin`、`container-sample.bin`、`manifest-sample.bin`、`splitmix32-seq.bin`
- TS 生成（`npm run gen-vectors`），Rust `tests/golden.rs` 断言字节相等
- **协议任何改动必须重新生成 golden + 提交**

铁律：
- `Math.log`/`f64::ln` 禁止（libm 近似差 1 ulp）——用 `dlog`（纯 IEEE-754 运算）
- JS `Math.imul` ≡ Rust `u32::wrapping_mul`；`>>>` ≡ `>>`（u32）
- 取模都是非负 u32，`%` 语义安全
- 帧头 **HEADER_LEN=20**（不是 16！payloadFnv 在 offset 16-19，block 从 20 开始）

## 踩坑记录

1. **rustup shim 拦截**：curl 装的 rustup 在 ~/.cargo/bin 覆盖系统 cargo → 用 `PATH=/usr/bin:$PATH cargo` 绕开（**不要删 ~/.cargo，用户没同意**）。系统用 pacman `rust-musl` 包提供 musl target
2. **Arch 装包铁律**：rust 工具链全走 pacman（rust/rust-musl），不用 rustup（会冲突）
3. **zxing-wasm**：用 `readBarcodesFromImageData` 返回的 **bytes 字段**（不是 text，UTF-8 会损坏二进制）
4. **qrcode 库**：编码二进制要用 byte-mode segment `[{data: bytes, mode: 'byte'}]`，直接传 Uint8Array 会按 UTF-8 损坏
5. **golden dlog 字节序**：TS `getBigUint64(0,false)` 是小端内存的大端数值 → Rust 要 `swap_bytes()` 匹配；tsv 里 x 必须 `toPrecision(17)`（完整 f64），toFixed(6) 会让 Rust 解析出不同值
6. **clippy pedantic**：协议 cast（usize→u32/f64）是安全的（k≤65535），局部 `#![allow(clippy::cast_*)]` 而非全改 From
7. **vite build 被守护拦截**：用 `node node_modules/vite/bin/vite.js build` 显式调用

## 文件地图

```
shared/          # 协议核心 TS（单一事实源）：protocol/fountain/container/manifest
sender-cli/      # Rust 静态二进制：main(CLI)/fountain/protocol/qr
sender-web/      # 单 HTML 发送端（vite-plugin-singlefile）
receiver/        # 手机接收端（zxing-wasm 解码）
protocol/        # spec.md + golden-vectors
tests/           # TS 单测
```

## 验证清单

- [ ] `npm test` + `cargo test` 全绿（含 golden）
- [ ] `cargo clippy -- -D warnings` 零警告
- [ ] `cargo fmt --check` 无 diff
- [ ] 静态验证：`file wink` → static-pie，`ldd wink` → statically linked
- [ ] 改协议后重新 `npm run gen-vectors` 并提交
