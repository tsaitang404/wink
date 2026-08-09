# wink 编码与测试规范 v0.1

> 项目：/data/code/wink —— 眨眼式光学文件传输
> 适用：所有贡献者、所有代码（TypeScript + Rust）
> 目的：跨语言一致性是 wink 的生命线（发送端 Rust 与接收端 TS 必须逐位一致），本规范把代码风格和测试纪律钉死，防止任何一侧悄悄偏离。

---

## 1. 编码规范

### 1.1 总原则

1. **可移植性 > 本地优化**：任何代码都可能被移植到另一端（TS ↔ Rust）。禁止使用语言特有、无法在另一端等价表达的技巧。
2. **确定性 > 优雅**：跨语言字节一致优先于"更聪明的写法"。dlog 用纯 IEEE-754，splitmix32 用 wrapping 整数运算，不用 `Math.log`/`f64::ln` 等 libm 依赖。
3. **单一事实源**：协议常量（magic/HEADER_LEN/MAX_FILE_BYTES）在 TS 的 `shared/` 定义，Rust 端**复制** + 金标准向量断言锁定，不许各写各的。
4. **无魔法数字**：wire format 里的字节偏移、大小全部命名常量。
5. **注释说明"为什么"**，不解释"是什么"（代码本身已表达）。

### 1.2 TypeScript 规范

**工具**：
- `tsc --noEmit` 类型检查（strict 模式）
- ESLint + `@typescript-eslint/recommended`
- Prettier（默认配置，单引号、尾逗号、宽度 100）

**规则**：
- `strict: true`（TS 配置）
- 显式类型：禁止 `any`（协议边界除外，用 `unknown` + 断言）
- 只用 `Uint8Array`/`DataView` 做字节操作，禁止 `Buffer`（浏览器端不能用）
- 所有 `pack*`/`parse*` 函数返回完整类型，不做隐式转换
- 常量用 `export const UPPER_SNAKE = ...`
- 文件命名：`kebab-case.ts`
- 测试文件：`*.test.ts` 与源码同目录或 `tests/`

**禁止**：
- `Math.log` / `Math.sqrt` 用在协议关键路径（用 `dlog` / 显式运算）
- 依赖运行时环境的 `Math.random`（协议里全部用 splitmix32）
- `new Date()` 进协议

### 1.3 Rust 规范

**工具**：
- `rustfmt`（默认配置）
- `clippy`（`cargo clippy -- -D warnings` 必须零警告）
- `cargo test` 必须全绿

**规则**：
- `#![deny(unsafe_code)]`——纯安全 Rust，零 unsafe
- 整数运算显式 `wrapping_*`（与 JS 溢出语义一致），禁止 `-C overflow-checks=off` 依赖
- `f64` 运算保持 IEEE-754 语义（Rust 默认即如此）
- 所有字节布局用 `u8` 数组 + 手写打包（不用 `byteorder` 的差异行为）
- 错误用 `Result<T, String>` 或自定义 `enum`，不用 `panic!`（库路径）；`main` 的致命错误可 `process::exit`
- 文件命名：`snake_case.rs`
- 测试：`#[cfg(test)] mod tests` 内联 + `tests/` 集成测试（golden）

**禁止**：
- `unsafe`
- 依赖 `libm` 的 `f64::ln`/`f64::sqrt` 在协议路径（用 `dlog` 系列）
- 未处理 `Result`（`unwrap` 仅限测试/启动参数）

### 1.4 跨语言命名对应

| TS | Rust | 说明 |
|---|---|---|
| `dlog` | `dlog` | 同名同实现 |
| `solitonCdf` | `soliton_cdf` | 函数名 snake_case，语义一致 |
| `splitmix32` | `splitmix32` | 同名 |
| `frameIndices` | `frame_indices` | 命名风格差异，行为一致 |
| `packFrame` | `pack_frame` | 同上 |
| `MAX_FILE_BYTES` | `MAX_FILE_BYTES` | 常量同名同值 |

---

## 2. 测试规范

### 2.1 测试分层

| 层 | 位置 | 工具 | 职责 |
|---|---|---|---|
| L1 单元 | TS `tests/*.test.ts`、Rust 内联 `#[cfg(test)]` | `node --test` / `cargo test` | 单函数确定性 |
| L2 跨语言一致性 | Rust `tests/golden.rs` | `cargo test` | 读 golden-vectors 断言字节相等 |
| L3 集成 | 人工 + CI | — | 端到端（终端/网页 → 手机） |

### 2.2 金标准向量（L2 核心，跨语言一致性的唯一保险）

**位置**：`protocol/golden-vectors/`（提交进 git）

**生成**：`npm run gen-vectors`（TS 实现生成，单一权威）→ 提交 → Rust 端 `tests/golden.rs` 读取断言。

**必须生成的向量**（与 impl-spec 一致）：

| 文件 | 内容 | 断言方 |
|---|---|---|
| `dlog-vector.tsv` | `dlog(x)` 对 500 个固定 x 的 hex | TS + Rust |
| `soliton-k100.bin` | `solitonCdf(100)` 原始 Float64 字节 | TS + Rust |
| `frame-session1.bin` | 固定 sessionId=1/seq=0/k=4/blockLen=16 的完整帧 | TS + Rust |
| `container-sample.bin` | 固定文件名/类型/内容的文件容器 | TS + Rust |
| `manifest-sample.bin` | 固定 Manifest 样例 | TS + Rust |

**规则**：
- 向量文件**提交进 git**（不是运行时生成）
- 任何协议改动 → 重新生成 + 重新提交（breaking change 有记录）
- Rust/TS 任何一侧改实现 → 跑 golden 断言，不等价就 FAIL

### 2.3 单元测试命名与断言

**TS**：
```ts
import { test } from "node:test";
import assert from "node:assert/strict";

test("dlog matches golden values", () => { ... });
```

**Rust**：
```rust
#[test]
fn dlog_matches_golden_values() { ... }
```

**命名规则**：`<行为>_<场景>`，如 `pack_frame_roundtrip`、`soliton_cdf_k1_returns_one`。

**断言要求**：
- 浮点比较：用**字节相等**（`Buffer.equals` / 位模式）或 `assert.equal(hex)`，不用 `≈`
- 字节比较：`assert.deepEqual(Uint8Array)` / `assert_eq!(Vec<u8>)`
- 涉及 wire format 的测试必须锁定**精确字节**，不允许"语义等价"

### 2.4 确定性测试（防回归重点）

| # | 测试 | 防什么 |
|---|---|---|
| T1 | `dlog` 500 个固定值 | Rust/JS libm 偏差 |
| T2 | `solitonCdf` 固定字节 | 分布漂移 |
| T3 | `splitmix32(1234)` 前 10 值 | PRNG 漂移 |
| T4 | `frameIndices(k=8, sessionId=1, seq=0)` | 采样漂移 |
| T5 | LT 往返 + 丢帧 20% | 编解码一致 |
| T6 | 金标准向量 | 全链路字节 |

### 2.5 测试执行命令（CI 强制）

```bash
# TS 侧（根目录）
npm test                      # 全部 L1 单测
npm run gen-vectors           # 重新生成 golden（手动，提交前）

# Rust 侧
cd sender-cli && cargo test   # L1 单测 + L2 golden 断言

# CI（.github/workflows/ci.yml）
# 1. npm install && npm test
# 2. cd sender-cli && cargo test
# 3. cargo clippy -- -D warnings
# 4. cargo fmt --check
# 5. npx prettier --check .
# 6. npx tsc --noEmit
```

### 2.6 覆盖要求

- 协议核心（protocol/fountain/container/manifest）：**行覆盖 ≥ 90%**（`cargo tarpaulin` / `c8`）
- 测试必须覆盖：gzip 两分支、文本/文件两类型、k=1 边界、空文件、大文件上限、丢帧率 0%/20%/50%
- 无法测试的分支（如摄像头硬件）在代码注释标注 `// NOCLIP: hardware-dependent` 并人工验证

---

## 3. 提交纪律

1. 每个 Task 独立 commit，消息格式：`type(scope): subject`（`feat(protocol): add manifest frame` / `fix(fountain): dlog range reduction`）
2. 协议改动必须**同时**提交 golden 向量更新
3. 提交前必须跑：`npm test && cd sender-cli && cargo test && cargo clippy -- -D warnings`
4. CI 失败不允许合入

---

## 4. 检查清单（每次提交前过一遍）

- [ ] `cargo fmt` 无 diff
- [ ] `cargo clippy -- -D warnings` 零警告
- [ ] `cargo test` 全绿（含 golden）
- [ ] `npm test` 全绿
- [ ] `npx prettier --check .` 通过
- [ ] `npx tsc --noEmit` 通过
- [ ] golden 向量与实现一致（任何协议改动后重新生成）
- [ ] 无 unsafe / 无协议路径 libm
