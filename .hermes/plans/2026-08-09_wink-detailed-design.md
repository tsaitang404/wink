# wink 详细设计 v0.1

> 项目：/data/code/wink —— 旗语式光学文件传输
> 日期：2026-08-09
> 参考：decimen-optical-transfer（MIT）算法移植；本设计是落地实现规格，不是概念讨论。

---

## 1. 总体架构

```
发送端（任选其一）                    接收端（手机）
┌────────────────────┐  光信道  ┌────────────────────┐
│ sender-cli (Rust)  │  QR 帧流  │ receiver (网页)     │
│  终端 ANSI 渲染    │ ────────► │  摄像头 + zxing     │
│  OR                │  无反向通道 │  → 喷泉解码 → 文件  │
│ sender-web (HTML)  │          │                    │
│  canvas 渲染       │          │                    │
└────────────────────┘          └────────────────────┘
```

**三个组件共享同一协议**（`protocol/spec.md` + golden-vectors 保证一致），互相兼容：
- sender-cli 可以传给 receiver
- sender-web 可以传给 receiver
- 两发送端完全同协议，无差异

---

## 2. 线格式（wire format）——精确字节布局

### 2.1 帧头（FrameHeader）16 字节，小端

| 偏移 | 大小 | 字段 | 说明 |
|---|---|---|---|
| 0 | u8 | magic | `0x57`（wink 的 W） |
| 1 | u8 | version | `0x01` |
| 2 | u16 | sessionId | 随机（每次发送端启动更换） |
| 4 | u32 | seq | 帧序号，驱动喷泉 PRNG（0..2^32-1 循环） |
| 8 | u16 | k | 源块数量（≤ 0xFFFF） |
| 10 | u16 | blockLen | 本帧载荷字节数（≥1） |
| 12 | u32 | totalLen | 文件容器总长（≥1） |
| 16 | u32 | payloadFnv | 容器 FNV-1a 校验 |

**关键设计（移植 decimen）：`streamIdentity`** = `sessionId:k:blockLen:totalLen:payloadFnv`
- 接收端锁流靠它，**任何字段不一致就重置**（不只是新 sessionId）
- 防止 sessionId 16 位碰撞导致静默错乱
- 发送端重启同文件 → 同 k/sessionId/seq 生成同帧，接收端自然续上

### 2.2 文件容器（Container）

| 偏移 | 大小 | 字段 |
|---|---|---|
| 0 | 4 | magic `"WNK1"`（0x53 0x4D 0x50 0x31） |
| 4 | u8 | compression：0=none, 1=gzip |
| 5 | u16 | nameLen（文件名 UTF-8 字节数，≤0xFFFF） |
| 7 | u16 | typeLen（MIME 类型字节数） |
| 9 | u32 | originalSize（解压后字节数） |
| 13 | u32 | transmittedSize（传输字节数） |
| 17 | 32 | sha256（原始字节 SHA-256） |
| 49 | nameLen | 文件名（UTF-8） |
| 49+nameLen | typeLen | MIME 类型 |
| 49+nameLen+typeLen | transmittedSize | 文件字节（或 gzip 流） |

- 容器总长 = `49 + nameLen + typeLen + transmittedSize`（= totalLen）
- payloadFnv = FNV-1a(整个容器)
- gzip 仅当 `compressed.length + 64 < originalSize` 且类型非预压缩（图片/视频/zip 等跳过，移植 decimen 的 `isPrecompressedType`）

### 2.3 文本容器（Text Snippet，v0.1 简单版）

| 偏移 | 大小 | 字段 |
|---|---|---|
| 0 | 4 | magic `"WNKT"`（0x53 0x4D 0x50 0x54） |
| 4 | u32 | len（UTF-8 字节数，≤ 4MB） |
| 8 | len | 文本 UTF-8 |

- 接收端识别：magic 区分 文件/文本
- 文本展示 + 复制按钮，不落盘

### 2.4 元信息帧（Manifest Frame）—— v0.1 关键交互设计

**选文件后发送端先显示一个元信息 QR（不是流）**，用户确认/调整参数后点"开始"才播放帧流。接收端扫到元信息帧即显示"即将接收：文件 X、大小、块数、预估时间"。

**元信息帧是独立 QR（单个可解，不参与喷泉）**，载荷为紧凑二进制：

| 偏移 | 大小 | 字段 |
|---|---|---|
| 0 | 4 | magic `"WNKM"`（0x53 0x4D 0x50 0x4D） |
| 4 | u8 | protocol version = 1 |
| 5 | u8 | 载荷类型：0=文件 1=文本 |
| 6 | u8 | 压缩：0=none 1=gzip |
| 7 | u8 | **codec：0=黑白QR 1=4色QR 2=8色QR（协议可协商）** |
| 8 | u16 | nameLen（UTF-8 文件名长度） |
| 10 | u32 | originalSize（解压后字节数） |
| 14 | u32 | transmittedSize（传输字节数） |
| 18 | u16 | k（源块数） |
| 20 | u16 | blockLen（每帧载荷） |
| 22 | u16 | sessionId（本次传输会话） |
| 24 | u16 | 建议 QR 版本（发送端当前配置） |
| 26 | u16 | 建议帧率 fps |
| 28 | u32 | 预估时间秒 = ceil(1.15×k / fps) |
| 32 | 4 | 容器 FNV-1a（预校验，可空=0） |
| 36 | nameLen | 文件名 UTF-8 |

**codec 可协商（2026-08-09 用户核心想法）**：
- 元信息帧本身**永远黑白 QR**（最可靠，保证能扫码）
- codec 字段声明**帧流**用什么编码，接收端按声明选择解码器
- 好处：协议不锁定单一编码——可以试错、演进、按场景选最优
- v0.1 实现 codec 0（黑白）；codec 1/2（彩色）作为 v0.2 实验通道（协议已预留）

**彩色 QR（codec 1/2，理论增益）**：

| codec | 每模块额外 bit | v40 帧载荷 | @30fps 带宽 | 对比 |
|---|---|---|---|---|
| 0 黑白 | 0 | 2953 B | 86.5 KB/s | 基准 |
| 1 四色 | 2 bit（黑/红/绿/蓝） | ~9218 B（×3.1） | ~270 KB/s | 超 libcimbar 2.5× |
| 2 八色 | 3 bit | ~12351 B（×4.2） | ~362 KB/s | 超 libcimbar 3.4× |

**彩色实现思路（v0.2 实验）**：
- 结构：保持 QR 定位角/格式信息/掩码（zxing 能定位 + 解出模块矩阵），**数据模块填充颜色**
- 每模块承载：黑白位（标准解码）+ 颜色位（额外 bit）——接收端先用 zxing 灰度路径解出模块矩阵和黑白数据，再对每个模块做**颜色分类**（读原始彩色帧 RGB，最近邻到 4/8 色），拼出额外字节
- 复杂度：主要是颜色分类器的可靠性（白平衡/色偏/摩尔纹），需要校准（元信息帧可带调色板）
- **只在前端（sender-web 真屏幕）做**——终端颜色不可靠（色域/主题覆盖），永远黑白
- 失败回退：接收端彩色解码错误率过高 → 提示切换黑白（发送端改 codec 重新开始）



**接收端**：
1. 摄像头扫到元信息帧 → 显示"收到：文件 X · 4.2 MB · K=65535 · 预估 3 分 20 秒 @30fps"
2. 自动进入等待帧流状态（sessionId/k/blockLen 已知）
3. 帧流开始后按已知参数解码，进度 = 已收帧/1.15K
4. 若先收到帧流（没扫到元信息）→ 按帧头自描述信息解码（兼容：帧头已有全部参数）

**动态 ETA（2026-08-09 用户确认的价值点）**：
- 元信息帧给出**静态预估**（按建议 fps 的理想值）
- 帧流开始后**动态校准**：统计实际解码 fps（丢帧后有效帧率），剩余时间 = 剩余所需帧 / 实时有效 fps
- 传输预览卡实时显示：已收帧/需求帧、当前有效速率、已用时间、**剩余时间（动态）**
- 有效 fps 显著低于建议 fps（手机慢/距离远）时提示"可提高发送端帧率或调近摄像头"
- 断流重连后重新平滑

**块级可视化（2026-08-09 用户要求）**：
- 元信息帧给出 K → 接收端渲染 **K 格块网格**（或按文件大小比例聚合的固定宽度网格，K 大时每格代表多块）
- **已解出的块**（solved）高亮着色，未解的灰显——这是解码进度，不是帧接收进度
- 关键认知：喷泉帧是块的 XOR 组合，**收到帧 ≠ 解出块**；peeling cascade 后段爆发，所以块网格前期增长慢、后期瞬间填满（与 decimen 的教训一致：帧数线性、块数 hockey-stick）
- 双指标显示：**已收帧/需求帧**（信道质量，线性）+ **已解块/K**（解码进度，后段爆发）
- 悬停/点击块网格可查看：该块对应的缺失块索引区间（v0.1 仅展示，不交互）

**精准补充（v0.2+，2026-08-09 用户提出的演进方向）**：
- 问题：喷泉码 v0.1 是纯单向信道，缺块只能靠冗余帧兜底（1.15×），无法精准补
- 演进方案：**辅助反向通道**——接收端通过局域网（WebSocket/HTTP 到本地小服务器，即"服务端定位"）把已解块位图（K bits）报给发送端
- 发送端收到位图后：
  - **方式 A（简单）**：只补发未解块的**原始块**（非喷泉帧，直接发 block index + bytes），接收端填洞
  - **方式 B（加权喷泉）**：调整帧采样分布，让新帧偏向覆盖缺失块，加速收敛
- 反向通道只做"补充"，主链路仍是光学喷泉——反向断掉不影响正常传输（冗余兜底）
- v0.1 不实现，但协议预留：帧头 streamIdentity 已含 k/blockLen，块网格数据结构（位图）在接收端本地就有，未来只需加一个上报端点

---

## 3. 喷泉码（Fountain Code）——逐位确定性规格

**这是整个项目最容易翻车的部分。** 发送端（Rust）与接收端（JS）必须生成**比特一致**的 soliton 分布和帧采样。任何 1 ulp 偏差 = 静默失败（接收端永远解不出）。

### 3.1 dlog —— 确定性自然对数（移植 decimen）

`Math.log`/`f64::ln` 都是 libm 实现近似，JS 引擎之间、Rust 与 JS 之间可能差 1 ulp。**必须用纯 IEEE-754 基础运算重建 ln**：

```
dlog(x):
  e = 0; m = x
  while m >= 1.5: m /= 2; e++
  while m < 0.75: m *= 2; e--
  z = (m-1)/(m+1); z2 = z*z
  term = z; sum = 0
  for n = 1,3,5,...,21: sum += term/n; term *= z2
  return e * LN2 + 2*sum        # LN2 = 0.6931471805599453
```

- TS 版：`f64` 运算（Float64Array 天然 f64）
- Rust 版：`f64` 运算，`/`、`*`、`+` 全部 IEEE-754 精确语义（Rust 保证）
- **测试**：两端对同一输入序列（如 0.5..1000 步进）断言逐位相等

### 3.2 solitonCdf —— robust-soliton 分布

```
solitonCdf(k):
  if k == 1: return [1.0]
  R = max(1, 0.1 * dlog(k / 0.5) * sqrt(k))
  spike = min(k, ceil(k / R))
  total = 0
  for d in 1..k:
    rho = (d==1) ? 1/k : 1/(d*(d-1))
    tau = 0
    if d < spike:  tau = R/(d*k)
    elif d == spike: tau = (R * max(0, dlog(R/0.5))) / k
    total += rho + tau
    cdf[d-1] = total
  for i in 0..k-1: cdf[i] /= total
  cdf[k-1] = 1.0
```

### 3.3 splitmix32 —— 确定性 PRNG（整数运算）

```
splitmix32(seed):
  s = seed | 0
  next():
    s = (s + 0x9e3779b9) | 0
    t = s ^ (s >>> 16)
    t = (t * 0x21f0aaad) | 0   # 注意 JS Math.imul = Rust u32.wrapping_mul
    t ^= t >>> 15
    t = (t * 0x735a2d97) | 0
    t ^= t >>> 15
    return t >>> 0
```

**Rust 对应**：`u32::wrapping_add` / `wrapping_mul` / `wrapping_shr`（与 JS 32 位溢出语义完全一致）

### 3.4 frameSeed —— 会话+序列号派生种子

```
frameSeed(sessionId, seq):
  h = (sessionId+1) * 0x9e3779b1 ^ (seq + 0x85ebca6b)   # u32 溢出
  h = (h ^ (h>>>13)) * 0xc2b2ae35
  return h ^ (h>>>16)
```

### 3.5 frameIndices —— 帧的块子集

```
frameIndices(k, cdf, sessionId, seq):
  rnd = splitmix32(frameSeed(sessionId, seq))
  u = rnd() / 2^32                    # 0..1
  二分查找 cdf 得到 degree d（逆 CDF 采样）
  if d > k/8:                         # 大 degree → 部分 Fisher-Yates
    scratch = [0..k-1]
    for i in 0..d-1:
      j = i + (rnd() % (k-i))
      swap(scratch[i], scratch[j])
    return scratch[0..d]
  else:                               # 小 degree → 集合去重采样
    set = {}
    while set.size < d: set.add(rnd() % k)
    return set
```

**Rust 注意**：`rnd() % k` 是 u32 % usize，注意类型转换；Fisher-Yates 的 `rnd() % (k-i)` 同。必须与 JS 的 `%` 语义一致（都是整数取模，非负，安全）。

### 3.6 LT 编解码

**编码器**（发送端）：
```
LTEncoder(payload, blockLen, sessionId):
  k = ceil(payload.len / blockLen)
  words = ceil(blockLen / 4)
  blocks = 按块切分 payload（不足补 0）
  cdf = solitonCdf(k)
encode(seq) -> blockLen 字节:
  idx = frameIndices(k, cdf, sessionId, seq)
  out = 全 0（words 个 u32）
  for b in idx: out ^= blocks[b]
  return out 的前 blockLen 字节
```

**解码器**（接收端，peeling cascade）：
```
LTDecoder(k, blockLen, sessionId, totalLen):
  solved[] = null × k
  byBlock: Map<blockIdx, Set<pendingFrame>>
  framesNew / framesDup 计数
addFrame(seq, block):
  if seen(seq): dup++; return
  idx = frameIndices(k, cdf, sessionId, seq)
  words = block 转为 u32
  for b in idx:
    if solved[b]: words ^= solved[b]; idx.remove(b)
  if idx.empty: return
  if idx.size == 1: resolve(唯一b, words)
  else: 加入 byBlock 等待
resolve(b, w):   # peeling：解出 b，处理所有等它的帧
  solved[b] = w
  for pf in byBlock[b]: pf.words ^= w; pf.idx.remove(b)
    if pf.idx.size == 1: resolve(下一个)
assemble() -> 容器字节（按块拼接，截到 totalLen）
```

**进度显示**：显示**已收帧数 / 预估总帧**（K×1.15），不是已解块数——peeling 后段才集中爆发，显示块数会卡住像死机。

---

## 4. 容量与参数

| 参数 | 值 | 依据 |
|---|---|---|
| MAX_SOURCE_BLOCKS | 0xFFFF (65535) | 帧头 k 是 u16 |
| 文件上限 | 64 MB（同 decimen） | 容器 originalSize u32 |
| 文本上限 | 4 MB | 简单版 |
| soliton C | 0.1 | decimen 参数 |
| soliton δ | 0.5 | decimen 参数 |
| 冗余率 | ~1.15× | 喷泉理论值 |

**终端路径容量**（关键约束，2026-08-09 重新核算）：
- ANSI 半块字符（每字符 1 列 × 2 模块高），带宽由**终端列数 × 刷新率**决定，不是固定值
- 现代终端（kitty/alacritty/foot/WezTerm）60fps 重绘无压力；手机摄像头 60fps 采集
- sender-cli **动态探测终端列数**（ioctl/COLUMNS），自动选最大可用 QR 版本：

| 终端宽度 | QR | 载荷/帧 | @30fps | @60fps |
|---|---|---|---|---|
| 80 列 | v10 | 271B | 7.9 KB/s | 15.9 KB/s |
| 100 列 | v15 | 539B | 15.8 KB/s | 31.6 KB/s |
| 120 列 | v20 | 858B | 25.1 KB/s | 50.3 KB/s |
| 160 列 | v30 | 1626B | 47.6 KB/s | 95.3 KB/s |
| 200 列 | v40 | 2953B | 86.5 KB/s | 173 KB/s |

- 默认帧率 **30fps**（`--fps` 可调 1-60）
- 块长 = 载荷/帧的合理分块（≤ 帧载荷，向下取 2 的幂或固定 64B 起步）
- 文件上限 = `65535 × blockLen`（终端 v15/64B → 4MB；网页 v40/1024B → 64MB）
- **不做彩色编码**（libcimbar 4/8 色方案）——终端色域/主题覆盖/摄像头白平衡让颜色不可靠；黑白明暗是唯一稳健信道。彩色仅适合真屏幕（本项目的 sender-web 用标准 QR v40 已达 128 KB/s 量级）

**网页路径**：
- QR v40（177×177）→ 2953 字节 payload/frame，块长 1024B
- 帧率 60fps → 带宽 ≈ 128 KB/s（decimen 实测）

**帧尺寸选择**：
- sender-cli：默认 500B payload（QR v15），`--frame 271|500|861` 可选
- sender-web：默认 2953（QR v40），可降 1465（v27）

---

## 5. 发送端实现细节

### 5.1 sender-cli（Rust 静态二进制）

**Cargo.toml**：
```toml
[package]
name = "wink"
version = "0.1.0"
edition = "2021"

[dependencies]
qrcode = "0.14"
# 无其他依赖！gzip 可选：flate2（默认 static feature）或先不做压缩

[profile.release]
opt-level = 3
lto = true
strip = true
codegen-units = 1
panic = "abort"   # 减小体积
```

**CLI**：
```
wink send <file> [--fps 30] [--frame auto] [--text] [--quiet]
  --fps 1-60       帧率（默认 30，现代终端可到 60）
  --frame auto|271|500|858|1626|2953   QR 版本对应载荷；auto=按终端列数自动选最大
  --text           发送文本（stdin 或参数）
wink receive <dir>   # 可选：v0.2，CLI 解码（从摄像头/图片序列）
wink --version
```

**交互流程**（选文件后不立即流）：
1. 读文件 → 打包容器 → 探测终端列数 → 选 QR 版本/块长
2. **显示元信息 QR（WNKM）** + 状态行（文件/大小/K/预估时间）
3. 等用户按 **回车（或任意键）开始** —— 期间可 Ctrl+C 退出调整参数（--fps/--frame）
4. 开始后循环播放喷泉帧流，状态行显示当前 seq/K、已过时间
5. 另一键停止；信号 SIGINT 干净退出（恢复终端）

**ANSI 渲染（qr.rs）**：
- qrcode crate `QrCode::new(payload)` → 模块矩阵
- 每 2 行模块合成 1 行终端输出，用半块字符：
  - `█` 上黑下黑（U+2588）
  - `▀` 上黑下白（U+2580）
  - `▄` 上白下黑（U+2584）
  - ` ` 上白下白
- 加 4 模块安静区（quiet zone）
- 清屏 `\x1b[2J\x1b[H` + 逐帧输出 + `std::thread::sleep`（按 fps）
- 输出到 stderr 保留 stdout 干净（或 `--quiet` 关状态行）

**gzip 压缩**：flate2 crate（`default-features = false, features = ["rust_backend"]`）——纯 Rust，静态友好。

### 5.2 sender-web（单 HTML）

**vite.config.ts**：
```ts
import { viteSingleFile } from "vite-plugin-singlefile"
export default {
  plugins: [viteSingleFile()],
  build: { target: "es2020", assetsInlineLimit: 100000000 }
}
```

**渲染**：`qrcode` npm 包 `QRCode.toCanvas(canvas, payload)` 每帧重绘。

**交互流程（与 sender-cli 同构）**：
1. 选文件 → 打包容器 → 切块 → **显示元信息 QR（WNKM）** 在 canvas
2. 参数面板（开始前可调，调整后元信息 QR 实时更新）：
   - 帧率滑块（5-60fps，默认 30）
   - QR 尺寸滑块（对应版本 v10/v15/v20/v27/v40，默认 v40）
   - 块长选择（64/128/256/512/1024，默认自动 = 帧载荷）
   - 显示：K 块数、预估时间、建议接收端操作
3. 点 **▶ 开始** → 才播放帧流（sessionId 在开始瞬间固定，与元信息一致）
4. 全屏按钮（移动端友好）；流循环直到点停止
- file:// 直接可用（无 fetch、无 worker、无 SW——纯 canvas）

---

## 6. 接收端实现细节（receiver）

**依赖**：`zxing-wasm`（解码）+ 自写 fountain/protocol（TS，与 Rust 一致）

**流程**：
1. `getUserMedia({video: {facingMode: "environment"}})` 启动后置摄像头
2. 每帧（requestVideoFrameCallback 或 rAF）送 zxing-wasm worker 解码
3. 解出的字符串 → 二进制：
   - **magic "WNKM"** → 元信息帧 → 显示"即将接收：文件 X · 大小 · K · 预估时间"，进入等待流状态
   - **magic "WNK1"** → 容器帧（异常直达，兼容无 manifest 场景）→ 直接解码
   - **magic 0x57** → 帧流帧 → `parseFrame` 帧头检查 → 喷泉解码
4. `streamIdentity` 变化 → 重置解码器
5. `LTDecoder.addFrame(seq, block)` → `isComplete` → `assemble()` → 容器解析 → SHA-256 校验 → 下载/展示
6. 进度条：已收帧 / (K×1.15)，collapsible 诊断（fps、dup 率、goodput）

**关键 UI**：
- 扫描元信息帧后显示传输预览卡（文件名/大小/K/预估时间/建议帧率），与实际接收同步
- "没动静？"提示（像 decimen：先短延迟后长延迟）
- 断流自动重置（新 sessionId 自然重启）
- 文本片段 → 复制按钮；文件 → 预览 + 下载

**内容呈现（2026-08-09 用户要求）**——接收完成后按内容类型分流：

| 内容类型 | 判定 | 呈现方式 |
|---|---|---|
| 文本/代码 | MIME `text/*` 或 magic 文本 | **页内显示**（等宽字体，<64KB 直接内联；更大截断 + 下载完整） |
| HTML | `text/html` | 安全渲染（**iframe sandbox**，禁脚本/导航/弹窗）或显示源码 |
| 图片 | `image/*` | **页内预览**（img + 下载） |
| 视频/音频 | `video/*` `audio/*` | **页内播放器**（video/audio 标签，可拖动进度） |
| 压缩包/二进制 | 其他（zip/7z/tar/gz/pdf 等） | **直接下载**（下载按钮 + 文件大小显示） |
| 文本片段（WNKT） | magic | 显示 + 复制按钮（不落盘） |

**呈现安全（重要）**：
- HTML 一律 iframe sandbox（`sandbox="allow-same-origin"`，无 allow-scripts/allow-popups）——防恶意 HTML 文件在接收端执行
- 文本/代码显示不渲染（等宽字体 pre，防 XSS）
- 未知二进制不预览，只下载
- 文件名走 `safeFileName`（剥离路径/控制字符，与 decimen 一致）

**接收完成 UI**：
- 文本/代码：预览区 + "复制全文" + "下载"按钮
- 图片/视频：预览区 + 下载按钮
- 二进制：图标 + 文件名 + 大小 + "保存文件"（触发 download）
- 无论哪种，都显示 SHA-256 校验通过的标记（✓ 已校验）
- "接收另一个文件" 重新开始

---

## 7. 测试与验证策略

### 7.1 金标准向量（跨语言一致性的唯一保险）

`protocol/golden-vectors/` 下生成固定输入→固定字节的向量：
- `dlog-vector.tsv`：`dlog(x)` 对 500 个固定 x 的值（双端断言）
- `soliton-k100.bin`：k=100 的 CDF 原始字节
- `frame-session1-seq0-k4.bin`：固定 sessionId=1, seq=0, k=4, blockLen=16, payload="hello world 1234" 的完整帧字节
- `container-sample.bin`：固定文件名/类型/内容的完整容器字节

**生成方式**：先在 TS 实现 + 测试生成向量文件，Rust 端读取断言相等；再反向锁死。

### 7.2 单元测试（双端同值）

| 测试 | TS (node --test) | Rust (cargo test) |
|---|---|---|
| dlog 固定值 | ✓ | ✓（同一组数字） |
| solitonCdf k=1,2,100 | ✓ | ✓ |
| splitmix32 序列 | ✓ | ✓ |
| frameIndices k=8 | ✓ | ✓ |
| LT 编码→解码往返（模拟丢帧 20%） | ✓ | ✓ |
| pack/parseFrame 往返 | ✓ | ✓ |
| pack/unpackContainer 往返 | ✓ | ✓ |
| 金标准向量断言 | ✓ | ✓ |

### 7.3 集成验证（人工）

1. `cargo build --release --target x86_64-unknown-linux-musl` → `file wink` = statically linked
2. 终端 `wink send test.txt` → 手机接收页收到，SHA-256 匹配
3. 双击 `wink-sender.html` → 选文件 → 手机收到
4. 遮挡摄像头 1s → 继续完成
5. 干净 Alpine 容器跑二进制（验证零依赖）

---

## 8. 任务清单（实现顺序）

1. **协议 spec + 金标准生成器**（protocol/spec.md + scripts/gen-vectors.ts）
2. **TS fountain + protocol + 测试**（receiver 侧，向量落盘）
3. **Rust fountain + protocol + 测试**（断言向量相等）
4. **sender-cli QR 渲染**（ANSI 半块）
5. **sender-cli 主流程**（读文件→容器→喷泉→帧流）
6. **receiver 网页**（摄像头→zxing→解码→UI）
7. **sender-web 单 HTML**（canvas→qrcode）
8. **静态构建 + CI**（musl + windows-gnu + HTML 产物）
9. **文档 + SKILL.md + 演示**

---

## 9. 风险清单（实现时逐条检查）

| # | 风险 | 检查点 |
|---|---|---|
| 1 | Rust/JS 浮点不一致 | dlog/soliton 金标准向量双端断言 |
| 2 | Rust u32 溢出与 JS 不同 | splitmix32/frameSeed 全部用 wrapping_* 且测试锁死 |
| 3 | Rust `%` 与 JS `%` 语义（负数） | 所有取模都是非负 u32，安全；测试覆盖 |
| 4 | 终端 QR 太小扫不到 | 默认 v15 + 4 模块安静区；文档建议调大字体/全屏 |
| 5 | gzip 两端不一致 | 容器 compression 标志决定，无歧义 |
| 6 | FNV-1a 跨语言 | 纯 u32 整数运算，两端一致 |
| 7 | zxing-wasm 体积 | 单页内联（~1MB），接受 |
| 8 | 摄像头安全上下文 | receiver 必须 https/localhost；文档说明 |
| 9 | 大文件终端路径 | 块号 65535 限制 → 终端 ~4MB 上限，UI 提前报错 |
