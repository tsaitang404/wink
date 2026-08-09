# wink 协议规范 v0.1

wink 光学文件传输协议：屏幕/终端对镜头 wink 传文件。

**设计原则**：
- 单向信道，无反向通道，无握手
- 喷泉码（LT）：接收端收集任意 ~1.15K 个不同帧即可重建，丢帧只损失时间
- 自描述帧：接收端可中途锁定，发送端重启自动重置
- 跨语言确定性：TS（接收端/网页发送端）与 Rust（终端发送端）必须逐位一致

---

## 1. 帧头 FrameHeader（20 字节，小端）

| 偏移 | 大小 | 字段 | 说明 |
|---|---|---|---|
| 0 | u8 | magic | `0x57`（wink 的 W） |
| 1 | u8 | version | `0x01` |
| 2 | u16 | sessionId | 随机，每次发送端启动更换 |
| 4 | u32 | seq | 帧序号，驱动喷泉 PRNG |
| 8 | u16 | k | 源块数量（≤ 0xFFFF） |
| 10 | u16 | blockLen | 本帧载荷字节数（≥1） |
| 12 | u32 | totalLen | 文件容器总长（≥1） |
| 16 | u32 | payloadFnv | 容器 FNV-1a 校验 |

**streamIdentity** = `sessionId:k:blockLen:totalLen:payloadFnv`
接收端锁流靠它，任何字段不一致就重置。

## 2. 文件容器 Container

| 偏移 | 大小 | 字段 |
|---|---|---|
| 0 | 4 | magic `"WNK1"` |
| 4 | u8 | compression：0=none, 1=gzip |
| 5 | u16 | nameLen（文件名 UTF-8） |
| 7 | u16 | typeLen（MIME 类型） |
| 9 | u32 | originalSize（解压后） |
| 13 | u32 | transmittedSize（传输） |
| 17 | 32 | sha256（原始字节） |
| 49 | nameLen | 文件名 |
| 49+nameLen | typeLen | MIME |
| 49+nameLen+typeLen | transmittedSize | 文件字节（或 gzip） |

容器总长 = `49 + nameLen + typeLen + transmittedSize`。gzip 仅当 `compressed+64 < original` 且类型非预压缩。

## 3. 文本容器 Text Snippet

| 偏移 | 大小 | 字段 |
|---|---|---|
| 0 | 4 | magic `"WNKT"` |
| 4 | u32 | len（UTF-8，≤ 4MB） |
| 8 | len | 文本 |

## 4. 元信息帧 Manifest

| 偏移 | 大小 | 字段 |
|---|---|---|
| 0 | 4 | magic `"WNKM"` |
| 4 | u8 | version = 1 |
| 5 | u8 | payloadType：0=文件 1=文本 |
| 6 | u8 | compression |
| 7 | u8 | codec：0=黑白 1=四色 2=八色 |
| 8 | u16 | nameLen |
| 10 | u32 | originalSize |
| 14 | u32 | transmittedSize |
| 18 | u16 | k |
| 20 | u16 | blockLen |
| 22 | u16 | sessionId |
| 24 | u16 | qrVersion（建议） |
| 26 | u16 | fps（建议） |
| 28 | u32 | estSeconds = ceil(1.15*k/fps) |
| 32 | 4 | payloadFnv（预校验） |
| 36 | nameLen | 文件名 |

元信息帧永远黑白 QR（最可靠），codec 字段声明帧流编码。

## 5. 喷泉码参数

- 分布：robust-soliton，C=0.1，δ=0.5
- 冗余：1.15×（需求帧 = ceil(k × 1.15)）
- PRNG：splitmix32（确定性，u32 整数）
- dlog：确定性自然对数（纯 IEEE-754 运算，不用 libm）

## 6. 金标准向量

`protocol/golden-vectors/`：
- `dlog-vector.tsv`：500 个固定 x 的 dlog hex
- `soliton-k100.bin`：solitonCdf(100) 原始 Float64 字节
- `frame-session1.bin`：固定帧字节
- `container-sample.bin`：固定容器字节
- `manifest-sample.bin`：固定 manifest 字节

TS 生成（单一权威），Rust 断言相等。
