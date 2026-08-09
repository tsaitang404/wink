# wink 详细设计 v0.1（实施规格完整版）

> 项目：/data/code/wink —— 旗语式光学文件传输
> 日期：2026-08-09
> 参考：decimen-optical-transfer（MIT）算法移植
> 本文件是**落地实施规格**：每个文件、每个函数、每个命令都给到位，实现者零猜测。

---

## 0. 实施规格总览

### 0.1 仓库结构（精确文件清单）

```
/data/code/wink/
├── .gitignore                  # node_modules/ dist/ dist-standalone/ target/ *.local
├── .github/workflows/
│   ├── ci.yml                  # test+build (Rust + TS)
│   └── release.yml             # tag → Linux musl + Windows GNU + sender.html
├── Cargo.toml                  # workspace: sender-cli
├── package.json                # scripts: test/build/web/receiver
├── protocol/
│   ├── spec.md                 # 线格式（章节 2 的内容，人类可读）
│   └── golden-vectors/         # 跨语言金标准字节
│       ├── dlog-vector.tsv
│       ├── soliton-k100.bin
│       ├── frame-session1.bin
│       ├── container-sample.bin
│       └── manifest-sample.bin
├── shared/                     # 协议核心（TS 单一实现，sender-web/receiver 共用）
│   ├── protocol.ts             # 帧头/容器/manifest pack+parse, FNV, safeFileName
│   ├── fountain.ts             # dlog/solitonCdf/splitmix32/frameIndices/LT编解码
│   ├── container.ts            # packFile/unpackFile/gzip决策/isPrecompressedType
│   └── manifest.ts             # packManifest/parseManifest
├── receiver/                   # 手机接收端（Vite + TS）
│   ├── index.html
│   ├── vite.config.ts
│   └── src/
│       ├── main.ts             # 摄像头 → 解码循环 → UI 状态机
│       ├── decode-worker.ts    # zxing-wasm 解码 worker
│       ├── fountain.ts         # 从 ../shared 引用（vite alias）
│       ├── protocol.ts
│       ├── manifest.ts
│       ├── progress.ts         # ETA/块网格/双指标
│       ├── render.ts           # 内容分流呈现（文本/图片/视频/下载）
│       └── style.css
├── sender-cli/                 # Linux 终端发送端（Rust）
│   ├── Cargo.toml
│   └── src/
│       ├── main.rs             # CLI 入口 + 交互流程
│       ├── protocol.rs         # 帧头/manifest/容器 pack（与 TS 字节一致）
│       ├── fountain.rs         # dlog/soliton/splitmix32/LTEncoder
│       ├── qr.rs               # qrcode crate → ANSI 半块渲染
│       ├── terminal.rs         # 列数探测/清屏/按键/信号
│       └── gzip.rs             # flate2 包装（可选压缩）
├── sender-web/                 # 前端发送端（Vite + singlefile）
│   ├── index.html
│   ├── vite.config.ts
│   └── src/
│       ├── main.ts             # 选文件 → manifest → 参数面板 → 帧流
│       ├── fountain.ts         # 引用 ../shared
│       ├── protocol.ts
│       └── manifest.ts
├── tests/                      # TS 端测试（node --test）
│   ├── dlog.test.ts
│   ├── fountain.test.ts
│   ├── protocol.test.ts
│   ├── manifest.test.ts
│   └── golden-vectors.test.ts  # 生成/断言向量
├── docs/
│   ├── README.md               # 用户文档
│   └── protocol.md             # 协议文档
└── SKILL.md                    # 项目技能
```

### 0.2 语言/依赖锁定

| 组件 | 语言 | 关键依赖 | 理由 |
|---|---|---|---|
| shared + receiver + sender-web | TypeScript 5.x | `qrcode@1.5` `zxing-wasm@2` `vite@6` `vite-plugin-singlefile` `tsx` | decimen 同栈，喷泉算法已有 TS 参考 |
| sender-cli | Rust edition 2021 | `qrcode@0.14` `flate2(rust_backend)` | 纯 Rust 零 C 依赖，musl 静态 |
| 无 Go、无 Python | — | — | 用户明确不用 Go；Python 非静态 |

**npm scripts（根 package.json）**：
```json
{
  "scripts": {
    "test": "node --import tsx --test tests/*.test.ts",
    "gen-vectors": "node --import tsx scripts/gen-vectors.ts",
    "dev:receiver": "vite --config receiver/vite.config.ts",
    "dev:sender": "vite --config sender-web/vite.config.ts",
    "build:receiver": "vite build --config receiver/vite.config.ts",
    "build:sender": "vite build --config sender-web/vite.config.ts",
    "build:all": "npm run build:receiver && npm run build:sender"
  }
}
```

**Rust Cargo.toml**：
```toml
[package]
name = "wink"
version = "0.1.0"
edition = "2021"

[dependencies]
qrcode = "0.14"
flate2 = { version = "1", default-features = false, features = ["rust_backend"] }

[profile.release]
opt-level = 3
lto = true
codegen-units = 1
strip = true
panic = "abort"
```

---

## 1. 模块接口（函数签名——双端一致的契约）

### 1.1 protocol.ts / protocol.rs —— 线格式

```ts
// ===== TS (shared/protocol.ts) =====
export const FRAME_MAGIC = 0x57;              // 帧流帧
export const MANIFEST_MAGIC = "WNKM";         // 元信息帧
export const FILE_MAGIC = "WNK1";             // 文件容器
export const TEXT_MAGIC = "WNKT";             // 文本容器
export const HEADER_LEN = 16;

export interface FrameHeader {
  sessionId: number;    // u16
  seq: number;          // u32
  k: number;            // u16
  blockLen: number;     // u16
  totalLen: number;     // u32
  payloadFnv: number;   // u32
}

export function packFrame(h: FrameHeader, block: Uint8Array): Uint8Array;
export function parseFrame(bytes: Uint8Array): { header: FrameHeader; block: Uint8Array } | null;
export function streamIdentity(h: FrameHeader): string;   // `${sessionId}:${k}:${blockLen}:${totalLen}:${payloadFnv}`
export function fnv1a(bytes: Uint8Array): number;          // 纯 u32 整数
export function splitmix32(seed: number): () => number;    // 确定性 PRNG
export function safeFileName(name: string): string;        // 剥离路径/控制字符
```

```rust
// ===== Rust (sender-cli/src/protocol.rs) =====
pub const FRAME_MAGIC: u8 = 0x57;
pub const HEADER_LEN: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FrameHeader {
    pub session_id: u16,
    pub seq: u32,
    pub k: u16,
    pub block_len: u16,
    pub total_len: u32,
    pub payload_fnv: u32,
}

pub fn pack_frame(h: &FrameHeader, block: &[u8]) -> Vec<u8>;
pub fn parse_frame(bytes: &[u8]) -> Option<(FrameHeader, &[u8])>;
pub fn stream_identity(h: &FrameHeader) -> String;
pub fn fnv1a(bytes: &[u8]) -> u32;      // wrapping_mul 与 JS imul 一致
pub fn safe_file_name(name: &str) -> String;
```

### 1.2 fountain.ts / fountain.rs —— 喷泉码

```ts
// ===== TS (shared/fountain.ts) =====
export function dlog(x: number): number;                        // 确定性 ln（IEEE-754 纯运算）
export function solitonCdf(k: number): Float64Array;            // robust-soliton CDF
export function frameSeed(sessionId: number, seq: number): number;
export function frameIndices(k: number, cdf: Float64Array, sessionId: number, seq: number): number[];
export class LTEncoder {
  constructor(payload: Uint8Array, blockLen: number, sessionId: number);
  readonly k: number;
  encode(seq: number): Uint8Array;   // 返回 blockLen 字节
}
export class LTDecoder {
  constructor(k: number, blockLen: number, sessionId: number, totalLen: number);
  readonly framesNew: number;
  readonly framesDup: number;
  readonly solvedCount: number;
  get isComplete(): boolean;
  addFrame(seq: number, block: Uint8Array): void;
  assemble(): Uint8Array | null;
}
```

```rust
// ===== Rust (sender-cli/src/fountain.rs) =====
pub fn dlog(x: f64) -> f64;
pub fn soliton_cdf(k: usize) -> Vec<f64>;
pub fn frame_seed(session_id: u16, seq: u32) -> u32;
pub fn frame_indices(k: usize, cdf: &[f64], session_id: u16, seq: u32) -> Vec<usize>;
pub struct LTEncoder { ... }
impl LTEncoder {
  pub fn new(payload: &[u8], block_len: usize, session_id: u16) -> Self;
  pub fn k(&self) -> usize;
  pub fn encode(&self, seq: u32) -> Vec<u8>;
}
```

**关键一致性要求（实现时必须逐条满足）**：
1. `dlog`：TS 用 `Float64Array` 运算、Rust 用 `f64` —— 都是 IEEE-754 双精度，`+ - * /` 语义一致
2. `solitonCdf`：`dlog(k / SOLITON_DELTA)` 的参数是 `k/0.5`，`Math.sqrt(k)` vs `k.sqrt()`（f64）一致
3. `splitmix32`：JS `Math.imul(a,b)` ≡ Rust `a.wrapping_mul(b)`；`>>> 16` ≡ `>> 16`（无符号移位，u32 自然）
4. `frameIndices` 的逆 CDF 二分：`cdf[mid] >= u` 比较，f64 精确
5. Fisher-Yates：`rnd() % (k - i)` —— rnd() 返回 u32（0..2^32-1），k-i 是 usize/u32，无符号取模
6. LT 编码 XOR：u32 数组按字 XOR；不足 4 字节的尾部块补 0（`Uint8Array`/`Vec` 对齐 4 字节）

### 1.3 container.ts / gzip.rs —— 文件容器

```ts
// ===== TS (shared/container.ts) =====
export interface PackedFile {
  container: Uint8Array;         // 完整容器（含 WNK1 头）
  compression: "none" | "gzip";
  originalSize: number;
  transmittedSize: number;
}
export async function packFile(name: string, type: string, bytes: Uint8Array): Promise<PackedFile>;
export async function unpackFile(container: Uint8Array): Promise<{name: string; type: string; sha256: Uint8Array; bytes: Uint8Array}>;
export function isPrecompressedType(type: string): boolean;  // 图片/视频/zip 跳过 gzip
export const MAX_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_FILE_LABEL = "64 MB";
```

```rust
// ===== Rust (sender-cli/src/protocol.rs 或 gzip.rs) =====
pub fn pack_file(name: &str, mime: &str, bytes: &[u8]) -> Vec<u8>;
pub fn gzip_if_smaller(bytes: &[u8], mime: &str) -> (Vec<u8>, bool); // (transmitted, used_gzip)
```

**gzip 决策**：`bytes.len() >= 768 && !isPrecompressedType(mime) && compressed.len() + 64 < bytes.len()`
（移植 decimen 的保守策略：小文件/预压缩格式不做）

### 1.4 manifest.ts —— 元信息帧

```ts
// ===== TS (shared/manifest.ts) =====
export interface Manifest {
  version: number;          // 1
  payloadType: 0 | 1;       // 0=file 1=text
  compression: 0 | 1;
  codec: 0 | 1 | 2;         // 0=黑白 1=四色 2=八色（v0.1 只实现 0）
  name: string;
  originalSize: number;
  transmittedSize: number;
  k: number;                // u16
  blockLen: number;         // u16
  sessionId: number;        // u16
  qrVersion: number;        // 建议
  fps: number;              // 建议
  estSeconds: number;       // ceil(1.15*k/fps)
  payloadFnv: number;       // 容器 FNV（可为 0）
}
export function packManifest(m: Manifest): Uint8Array;   // 36B + name 的紧凑二进制
export function parseManifest(bytes: Uint8Array): Manifest | null;
```

```rust
// ===== Rust (sender-cli/src/protocol.rs) =====
pub struct Manifest { ... }   // 同字段
pub fn pack_manifest(m: &Manifest) -> Vec<u8>;
pub fn parse_manifest(bytes: &[u8]) -> Option<Manifest>;
```

**Manifest 字节布局**（已在章节 2.4 定义：36B 头 + nameLen；实现按此精确打包）

---

## 2. sender-cli 详细实现

### 2.1 交互状态机

```
[Idle] --读文件--> [Manifest] --按Enter--> [Streaming] --按q/Ctrl+C--> [Exit]
                     ↑ 参数调整(重新打包 manifest)     ↑ 流循环直到用户停
```

- `[Manifest]`：显示元信息 QR + 状态行（文件/大小/K/预估时间/终端列数/建议）
- 键盘：`Enter` 开始；`q` 退出；`Ctrl+C` 干净退出（恢复终端，`termios`）
- `[Streaming]`：循环 `encode(seq)` → ANSI 渲染 → sleep(1/fps)；状态行显示 seq/K/已用时间

### 2.2 terminal.rs（终端控制）

```rust
pub fn terminal_columns() -> usize;      // ioctl(TCGETS) 或 $COLUMNS 或默认 80
pub fn hide_cursor();                    // \x1b[?25l
pub fn show_cursor();                    // \x1b[?25h
pub fn clear_screen();                   // \x1b[2J\x1b[H
pub fn read_key() -> Option<u8>;         // 非阻塞读 stdin
pub fn install_raw_mode() -> RawMode;    // termios 原始模式（恢复用 RAII）
```

### 2.3 qr.rs（ANSI 半块渲染）

```rust
pub fn qr_ansi_blocks(qr: &QrCode, quiet_zone: usize) -> String {
    // 每 2 行模块 → 1 行半块字符
    // 模块矩阵外扩 quiet_zone
    // 字符映射：
    //   上黑下黑 → '█' (U+2588)
    //   上黑下白 → '▀' (U+2580)
    //   上白下黑 → '▄' (U+2584)
    //   上白下白 → ' ' (空格)
}
```

**版本选择**（按终端列数）：
```rust
pub fn pick_qr_version(cols: usize, payload_len: usize) -> QrVersion {
    // 从 v10(57) v15(77) v20(97) v25(117) v30(137) v35(157) v40(177) 中
    // 选第一个 modules+8 <= cols 且 capacity >= payload_len 的版本
    // 找不到 → 报错"文件太大/终端太窄"
}
```

### 2.4 帧率控制

```rust
fn frame_loop(fps: u32, ...) {
    let period = Duration::from_secs_f64(1.0 / fps as f64);
    let mut next = Instant::now();
    loop {
        render_frame(seq);          // 编码 + 渲染
        next += period;
        std::thread::sleep(next.saturating_duration_since(Instant::now()));
        seq = seq.wrapping_add(1);
    }
}
```

### 2.5 gzip（可选，v0.1 实现）

```rust
fn gzip_if_smaller(bytes: &[u8], mime: &str) -> (Vec<u8>, bool) {
    if bytes.len() < 768 || is_precompressed(mime) { return (bytes.to_vec(), false); }
    let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    enc.write_all(bytes).unwrap();
    let compressed = enc.finish().unwrap();
    if compressed.len() + 64 < bytes.len() { (compressed, true) } else { (bytes.to_vec(), false) }
}
```

---

## 3. sender-web 详细实现

### 3.1 页面布局

```
┌────────────────────────────────┐
│  wink 旗语传输 · 发送端     │
│  [选择文件] [粘贴文本]           │
│  ┌──────────────────────────┐  │
│  │                          │  │
│  │    QR canvas (manifest)   │  │  ← 第一帧=元信息
│  │    （点击全屏）            │  │
│  └──────────────────────────┘  │
│  参数面板:                     │
│  [帧率 ──●──── 30fps]         │
│  [QR大小 ────●── v40]         │
│  [块长: 64/128/256/512/1024]  │
│  信息: K=65535 · 预估 3分20秒  │
│  [▶ 开始传输] [■ 停止]        │
└────────────────────────────────┘
```

### 3.2 状态机（与 CLI 同构）

```
[Idle] --选文件--> [Manifest] --点开始--> [Streaming] --点停止--> [Idle]
```

- `[Manifest]`：canvas 显示 manifest QR；参数面板可调；调整实时重新打包 manifest
- `[Streaming]`：`setInterval(1000/fps)` 逐帧 `QRCode.toCanvas(canvas, frameBytes)`；状态行 seq/K
- 全屏：`canvas.requestFullscreen()`（iOS 用 `webkitRequestFullscreen` 或 CSS 放大）

### 3.3 vite.config.ts（singlefile 关键）

```ts
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
export default defineConfig({
  plugins: [viteSingleFile()],
  build: { target: "es2020", assetsInlineLimit: 100000000 },
});
```

---

## 4. receiver 详细实现

### 4.1 页面布局

```
┌────────────────────────────────┐
│  wink 旗语传输 · 接收端     │
│  [▶ 启动摄像头]                 │
│  ┌──────────────────────────┐  │
│  │   摄像头预览（全屏）        │  │
│  └──────────────────────────┘  │
│  状态: 等待旗语...             │
│  ┌──────────────────────────┐  │
│  │ 传输预览卡（收到manifest后）│  │
│  │  文件X · 4.2MB · K=65535  │  │
│  │  预估3分20秒 @30fps        │  │
│  │  进度: ██████░░░ 60%      │  │
│  │  帧: 1200/2100 块: 4000/K  │  │
│  │  [块网格可视化]             │  │
│  └──────────────────────────┘  │
│  [📁 保存文件] [复制文本]       │
└────────────────────────────────┘
```

### 4.2 解码状态机

```
[Idle] --Start camera--> [Scanning]
[Scanning] --收到manifest--> [Waiting-for-stream] (sessionId/k/blockLen 已知)
[Scanning]/[Waiting] --收到帧流帧--> [Decoding] (LTDecoder)
[Decoding] --isComplete--> [Received] (容器解析+校验+呈现)
[Decoding] --streamIdentity变化--> [Waiting-for-stream] (重置)
```

### 4.3 decode-worker.ts（zxing-wasm）

```ts
// 主线程：rAF 循环取 VideoFrame → postMessage 给 worker
// worker：zxing.wasm decode → 返回字节数组
// 忙的 worker 丢帧（fountain 吸收）——与 decimen 的 worker-pool 同思路
self.onmessage = async (e) => {
  const { imageData, width, height } = e.data;
  try {
    const result = await zxing.decode(new Uint8ClampedArray(imageData), width, height);
    self.postMessage({ ok: true, bytes: bytesToUint8(result) });
  } catch {
    self.postMessage({ ok: false });  // 无码/解码失败
  }
};
```

**重要**：zxing-wasm 解码结果是**文本字符串**（QR byte mode 默认按 UTF-8 读）。我们的帧是二进制 → 发送端必须用 `qrcode` 的 `byte` 模式 + **binary/UTF-8 编码**？不对——QR byte mode 存的是原始字节，zxing 返回时可能按 UTF-8 解码。**解决**：发送端用 `QRCode.create([{data: bytes, mode: "byte"}])` 生成；接收端 zxing 返回 Uint8Array（zxing-wasm 的 `decode` 返回字节）。确认 zxing-wasm API：`zxing.decode(image)` 返回 `{text: string, bytes: Uint8Array}`——**用 bytes 字段**，不用 text。

### 4.4 帧识别（解码循环核心）

```ts
function classifyDecoded(bytes: Uint8Array): "manifest" | "frame" | "container" | "unknown" {
  if (bytes.length >= 4) {
    if (bytes[0]===0x53 && bytes[1]===0x4d && bytes[2]===0x50 && bytes[3]===0x4d) return "manifest";
    if (bytes[0]===0x53 && bytes[1]===0x4d && bytes[2]===0x50 && bytes[3]===0x31) return "container";
  }
  if (bytes.length > HEADER_LEN && bytes[0] === FRAME_MAGIC) return "frame";
  return "unknown";
}
```

### 4.5 内容呈现（render.ts）

```ts
function renderReceived(file: {name: string; type: string; bytes: Uint8Array; sha256: Uint8Array}) {
  const mime = file.type.split(";")[0].toLowerCase();
  if (mime.startsWith("text/") || mime === "application/json" || mime.includes("javascript")) {
    if (file.bytes.length < 64 * 1024) showTextPreview(file);   // 内联显示
    else showDownloadOnly(file);                                // 太大只下载
  } else if (mime === "text/html") {
    showIframeSandbox(file);                                    // sandbox 渲染
  } else if (mime.startsWith("image/")) {
    showImage(file);                                            // img 预览
  } else if (mime.startsWith("video/") || mime.startsWith("audio/")) {
    showMedia(file);                                            // 播放器
  } else {
    showDownloadOnly(file);                                     // 二进制直接下载
  }
}
```

### 4.6 进度与 ETA（progress.ts）

```ts
class ProgressTracker {
  constructor(k: number, fps: number, blockLen: number) {}
  onFrame(ts: number): void;    // 统计有效解码帧率（滑动窗口）
  get stats(): {
    framesNew, framesDup,
    effectiveFps,              // 滑动窗口内 new/秒
    solvedCount,
    targetFrames: number,      // ceil(k * 1.15)
    estRemainingSec: number,   // (targetFrames - framesNew) / effectiveFps
  };
}
```

---

## 5. 金标准向量生成（scripts/gen-vectors.ts）

```ts
// 生成 protocol/golden-vectors/ 下所有向量文件
// 用 TS 实现生成（单一权威），Rust 端读取断言

import { dlog } from "../shared/fountain";
import { solitonCdf } from "../shared/fountain";
import { packFrame, packManifest, packFile } from "../shared/protocol";

// 1. dlog-vector.tsv: 对 x in [0.25, 0.5, 0.75, 1, 1.5, 2, 4, 10, 100, 1000] 输出 dlog(x) 的 hex
// 2. soliton-k100.bin: Float64Array(100) 原始字节（little-endian）
// 3. frame-session1.bin: packFrame({sessionId:1, seq:0, k:4, blockLen:16, totalLen:49+4, payloadFnv:fnv1a(container)}, block)
// 4. container-sample.bin: packFile("hello.txt", "text/plain", "hello world 1234")
// 5. manifest-sample.bin: packManifest(固定样例)
```

**Rust 端断言**：`sender-cli/tests/golden.rs` 读这些文件，用 Rust 实现重新计算，断言 `bytes == file_bytes`。

---

## 6. 构建命令（精确）

```bash
# 根目录
npm install
npm test                          # TS 单元测试（dlog/fountain/protocol/manifest/golden）
npm run gen-vectors               # 生成金标准向量（提交进 git）

# sender-cli
cd sender-cli
cargo test                        # Rust 测试（含 golden 断言）
rustup target add x86_64-unknown-linux-musl
cargo build --release --target x86_64-unknown-linux-musl
file target/x86_64-unknown-linux-musl/release/wink   # → statically linked
ldd target/x86_64-unknown-linux-musl/release/wink    # → not a dynamic executable

# receiver / sender-web
npm run dev:receiver              # 手机访问 https://<lan-ip>:5173（开发）
npm run build:sender              # → sender-web/dist/wink-sender.html（单文件）
npm run build:receiver            # → receiver/dist/（部署到静态服务器）
```

---

## 7. 测试用例清单（完整）

### 7.1 单元（TS + Rust 同值）

| # | 测试 | TS | Rust |
|---|---|---|---|
| T1 | `dlog(0.25/0.5/1/1.5/2/10/100)` 固定 hex | ✓ | ✓ |
| T2 | `solitonCdf(1)` = [1.0] | ✓ | ✓ |
| T3 | `solitonCdf(100)` 与 golden 相等 | ✓ | ✓ |
| T4 | `splitmix32(1234)` 前 10 个值固定 | ✓ | ✓ |
| T5 | `frameIndices(k=8, cdf, sessionId=1, seq=0)` 固定 | ✓ | ✓ |
| T6 | LT 往返：encode 200 帧 → decode → assemble 相等 | ✓ | ✓ |
| T7 | LT 往返丢帧 20%：仍能解出 | ✓ | ✓ |
| T8 | packFrame/parseFrame 往返 | ✓ | ✓ |
| T9 | packManifest/parseManifest 往返 | ✓ | ✓ |
| T10 | packFile/unpackFile 往返（gzip 开关两分支） | ✓ | ✓ |
| T11 | golden 向量断言（读 protocol/golden-vectors/） | ✓ | ✓ |
| T12 | safeFileName 剥离（`../evil`、`a\nb`） | ✓ | ✓ |

### 7.2 集成（人工）

| # | 场景 | 期望 |
|---|---|---|
| I1 | 终端发送 → 手机接收 | 文件完整，SHA-256 匹配 |
| I2 | sender-web 发送 → 手机接收 | 同上 |
| I3 | 遮挡摄像头 1s | 继续完成（喷泉容错） |
| I4 | 终端 80 列 vs 160 列 | 自动选不同 QR 版本，带宽差异可见 |
| I5 | 先扫帧流（无 manifest） | 仍能解码（自描述） |
| I6 | 文本片段 | 显示 + 复制 |
| I7 | 图片文件 | 页内预览 |
| I8 | zip 文件 | 直接下载 |
| I9 | 干净 Alpine 容器跑二进制 | 零依赖正常 |
| I10 | Windows 打开 sender.html | file:// 正常工作 |

---

## 8. 实施顺序（每个任务可独立提交）

1. **Task 1**: 仓库骨架（.gitignore/Cargo.toml/package.json/目录）→ commit
2. **Task 2**: protocol/spec.md + gen-vectors.ts 骨架 → commit
3. **Task 3**: shared/protocol.ts + fountain.ts + 测试（T1-T8）→ commit
4. **Task 4**: shared/container.ts + manifest.ts + 测试（T9-T12）→ commit
5. **Task 5**: gen-vectors.ts 生成 golden → commit
6. **Task 6**: sender-cli（protocol.rs/fountain.rs/qr.rs/terminal.rs/main.rs）+ 测试 → commit
7. **Task 7**: sender-cli golden 断言（读 golden-vectors）→ commit
8. **Task 8**: receiver（摄像头/zxing/解码循环/UI/进度/render）→ commit
9. **Task 9**: sender-web（manifest/参数面板/帧流/singlefile）→ commit
10. **Task 10**: 静态构建 + CI workflow → commit
11. **Task 11**: 端到端人工验证（I1-I10）
12. **Task 12**: docs + SKILL.md + tag v0.1.0

---

## 9. 风险与对策（实施时逐条检查）

| # | 风险 | 对策 |
|---|---|---|
| 1 | Rust/JS 浮点不一致 | dlog 纯 IEEE-754；golden 双端断言（T1-T3/T11） |
| 2 | u32 溢出语义 | wrapping_mul/wrapping_add；T4/T5 锁死 |
| 3 | zxing 返回 text vs bytes | 用 `decode()` 的 bytes 字段；发送端 byte mode |
| 4 | 终端 QR 太小 | 列数探测 + 自动选版本；文档建议全屏/大字体 |
| 5 | gzip 两端不一致 | compression 标志决定；T10 双分支 |
| 6 | 摄像头权限 | https/localhost；错误提示 |
| 7 | 大文件终端路径 | 块号 65535 限制 → 提前报错 |
| 8 | 移动端 Safari 摄像头 | getUserMedia + facingMode environment；`exact:60` 降级（decimen 经验） |
