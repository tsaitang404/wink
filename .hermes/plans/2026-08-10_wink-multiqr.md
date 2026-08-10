# wink v0.10.0 多码（Multi-QR）规划

> 版本基线：当前正式版 v0.9.6（Latest）。多码 = 新功能 + 协议 version bump → **v0.10.0**。
> 若只做小修则 v0.9.7。用户确认按 v0.10.0 规划。

## 状态：✅ 已实施完成（2026-08-10）

- 协议：manifest v2 + layout（TS/Rust/golden 一致）
- receiver：layout 显示（解码循环原生支持多码）
- sender-web：布局下拉 + canvas 网格（实测 2x2 四码渲染 ✅）
- sender-cli：--grid 参数 + ANSI 网格（实测 2x2/1x3 渲染 ✅）
- 剩余：真实摄像头带宽实测（设备端验证，需真机）

---

## 1. 协议设计

### 1.1 manifest version 2 + layout 字段

字节布局（version 2）：
```
| 偏移 | 大小 | 字段 |
|------|------|------|
| 0  | 4 | magic "WNKM" |
| 4  | u8 | version = 2 |
| 5  | u8 | payloadType |
| 6  | u8 | compression |
| 7  | u8 | codec：0=黑白（多码仍 0） |
| 8  | u8 | layout：0=1x1 1=1x2 2=1x3 3=2x2 4=2x3 |
| 9  | u16 | nameLen（原 8 → 顺延 9） |
| 11 | u32 | originalSize |
| 15 | u32 | transmittedSize |
| 19 | u16 | k |
| 21 | u16 | blockLen |
| 23 | u16 | sessionId |
| 25 | u16 | qrVersion（每码建议版本） |
| 27 | u16 | fps（建议） |
| 29 | u32 | estSeconds |
| 33 | 4 | payloadFnv |
| 37 | nameLen | 文件名 |
```
- layout 枚举：`0=1x1(单码) 1=1x2 2=1x3 3=2x2 4=2x3`
- **version 2 与 version 1 不兼容**（偏移全变）——老接收端读到 version=2 显示"接收端需更新"，不尝试解析
- 帧格式**零改动**（每码独立 sessionId+seq+payload）

### 1.2 golden 向量
- `manifest-v2-layout1.bin`（1x2）等各 layout 字节序列，Rust/TS 双端断言

---

## 2. seq 分配（关键设计）

**画面 tick t（0,1,2...）× 位置 p（0..N-1）→ `seq = t * N + p`**

```
1x2 布局：tick 0 → seq {0,1}，tick 1 → seq {2,3}，tick 2 → seq {4,5}...
2x2 布局：tick 0 → seq {0,1,2,3}，tick 1 → seq {4,5,6,7}...
```

**为什么这样**：
- 接收端天然按 seq 去重/位图显示，无需感知画面边界
- 同画面 N 码 seq 连续 → 位图上"N 连号"清晰显示每画面完整性
- 丢帧诊断：位图缺口 = 哪一帧丢

**位置→seq 映射**（发送端）：
```rust
let base = tick * N;
for p in 0..N {
    let seq = base + p;
    let frame = enc.encode(seq);
    render_at(grid_position(p), frame);
}
```

**接收端**：无感知（每帧独立喂 LTDecoder）。

---

## 3. 布局几何

### 3.1 网格定义（发送端）
```
1x2:  [0][1]              （横向 2）
1x3:  [0][1][2]           （横向 3）
2x2:  [0][1]              （2 行 2 列）
      [2][3]
2x3:  [0][1][2]           （2 行 3 列）
      [3][4][5]
```
位置 p → (row, col)：`row = p / cols, col = p % cols`

### 3.2 quiet zone（关键）
每个码保留 **4 模块安静区**（QR 标准 minimum），码间距 ≥ 8 模块（两码各 4）：
```
┌──────┐  ┌──────┐
│  QR  │  │  QR  │   ← 码间距 = 8 模块（白）
│      │  │      │
└──────┘  └──────┘
```

---

## 4. sender-cli（Rust）实现

### 4.1 参数
```
--grid 1x2 | 1x3 | 2x2 | 2x3    （不传 = 单码 1x1）
```

### 4.2 ANSI 渲染
- 每码渲染为 `render_ansi()` 返回的行数组（半块字符）
- 网格拼接：**每行拼接各码的对应行**，行间留空行（quiet zone）
- 定位：`\x1b[H` 到屏幕顶部，按行序输出全部码（网格整体一屏）
- 每码行数 = 模块数/2 + quiet，需逐行对齐（不足补空格）

### 4.3 版本联动（自动降版本）
- 终端列宽 / 码列数 = 每码可用列 → 最大版本 = `(cols_per_code*2 - 8 - 17)/4`
- 不传 -v 时：按布局自动算每码版本；传 -v 时：用 -v 但警告放不下则降
- block_len 按每码版本容量算

### 4.4 帧循环
```
每 tick：
  base = tick * N
  for p in 0..N:
      render_frame_at(grid_pos(p), base + p)
  sleep(1/fps); tick += 1
```

---

## 5. sender-web（TS）实现

### 5.1 UI
- 布局下拉：关闭/1x2/1x3/2x2/2x3
- 版本下拉联动：多码时可用版本上限降低

### 5.2 canvas 渲染
- canvas 网格分区，每码 `QRCode.toCanvas` 到子区域
- 码间距 = 8 模块像素
- 同 tick 内 N 码一次绘制（避免画面撕裂：先全画再上屏）

### 5.3 帧循环
同 CLI：`seq = tick*N + p`

---

## 6. receiver（TS）实现

### 6.1 manifest 解析
- version 2：读 layout（偏移 8）
- 显示"2x2 四码"等提示
- version 1：老逻辑（单码）

### 6.2 解码（已支持，可选优化）
- 现状：全图 `readBarcodesFromImageData` → results 循环 → handleBytes —— **已兼容**
- **可选优化：按布局区域裁剪**——每 region 独立 getImageData + 解码
  - 优点：每码更高分辨率（zxing 单码识别率提升）、可独立阈值
  - 缺点：多一次裁剪；布局已知时裁剪区域更准
  - **v0.10.0 不做**（全图识别已可用），v0.11 再优化

### 6.3 位图/块网格
- 零改动（seq 去重天然支持多码）

---

## 7. 版本选择表（自动联动）

| 布局 | 每码版本（估） | 每码容量 | 每画面容量 | 带宽增益(30fps) |
|---|---|---|---|---|
| 1x1 | v40 | 2953B | 2953B | 基准 ~88KB/s |
| 1x2 | v20 | 858B | 1716B | ×0.6（码小）→ 实际 ×1.6 靠解码率高 |
| 2x2 | v15 | 520B | 2080B | ×1.4 理论，×2-3 实测（分辨率分摊） |
| 2x3 | v12 | 367B | 2202B | ×1.5 理论 |

**注意**：多码不是线性增益——每码变小 + 摄像头分辨率分摊。**2x2 是甜点**（实测验证）。

---

## 8. 兼容性

| 场景 | 行为 |
|---|---|
| 新发送端 + 新接收端 | 多码正常工作 |
| 新发送端（多码）+ 老接收端 | 老接收端 version=2 报"需更新"，不崩 |
| 老发送端（单码）+ 新接收端 | layout=0 单码，完全兼容 |
| 单码模式 | 走 version 2 但 layout=0，字节几乎同 v1（偏移不同） |

---

## 9. 测试计划

- [ ] golden：manifest v2 各 layout 字节（Rust vs TS）
- [ ] 单码回归：layout=0 全链路不变
- [ ] seq 分配单测：tick*N+p 映射
- [ ] sender-cli 1x2/2x2 ANSI 渲染（宽度/对齐）
- [ ] sender-web canvas 网格（视觉截图）
- [ ] 端到端：2x2 实测带宽 vs 单码

---

## 10. 实施顺序

1. **协议**：manifest v2 + layout（shared/manifest.ts + sender-cli main.rs + golden）
2. **receiver**：version 2 解析 + layout 显示（解码循环已兼容）
3. **sender-web**：布局下拉 + canvas 网格（浏览器可测，最快）
4. **sender-cli**：--grid + ANSI 网格 + 版本联动
5. **实测验收**：各布局真实带宽，确定甜点

## 11. 风险

- zxing 多码识别率待实测（tryHarder 单码优先可能影响）
- 终端 80 列下 2x3 每码仅 ~22 列 → v4 左右，容量太小无意义 → **限制：每码最小 v10，低于则拒绝该布局**
- 接收端解码耗时 ×N → fps 下降 → 带宽非线性
- 摄像头对焦：多码视野大，离远 → 每码像素少 → 识别率降
