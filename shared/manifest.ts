// wink 元信息帧（Manifest）—— 协议协商与传输预览
//
// 选文件后发送端先显示元信息 QR（永远黑白，保证可扫），
// codec 字段声明帧流编码（v0.1 只实现 0=黑白）。
// 字节布局见 protocol/spec.md 第 4 节。

import { MANIFEST_MAGIC, fnv1a, safeFileName } from './protocol';

export type Codec = 0 | 1 | 2; // 0=黑白 1=四色 2=八色
export type Layout = 0 | 1 | 2 | 3 | 4; // 0=1x1 1=1x2 2=1x3 3=2x2 4=2x3

/** 布局 → (行, 列) */
export const LAYOUT_GRID: Record<Layout, { rows: number; cols: number }> = {
  0: { rows: 1, cols: 1 },
  1: { rows: 1, cols: 2 },
  2: { rows: 1, cols: 3 },
  3: { rows: 2, cols: 2 },
  4: { rows: 2, cols: 3 },
};

export interface Manifest {
  version: number; // 2
  payloadType: 0 | 1; // 0=file 1=text
  compression: 0 | 1 | 2 | 3; // 0=none 1=gzip 2=brotli 3=xz
  codec: Codec;
  layout: Layout; // 多码网格布局（v2 新增）
  name: string;
  originalSize: number;
  transmittedSize: number;
  k: number;
  blockLen: number;
  sessionId: number;
  qrVersion: number;
  fps: number;
  estSeconds: number;
  payloadFnv: number; // 0 = unknown
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// v2 头部长度 = 37（36 + 1 layout 字节）
const HEADER_LEN_V2 = 37;

export function packManifest(m: Manifest): Uint8Array {
  const nameBytes = textEncoder.encode(safeFileName(m.name));
  const out = new Uint8Array(HEADER_LEN_V2 + nameBytes.length);
  const dv = new DataView(out.buffer);
  out.set(MANIFEST_MAGIC, 0);
  dv.setUint8(4, m.version);
  dv.setUint8(5, m.payloadType);
  dv.setUint8(6, m.compression);
  dv.setUint8(7, m.codec);
  dv.setUint8(8, m.layout);
  dv.setUint16(9, nameBytes.length, true);
  dv.setUint32(11, m.originalSize, true);
  dv.setUint32(15, m.transmittedSize, true);
  dv.setUint16(19, m.k, true);
  dv.setUint16(21, m.blockLen, true);
  dv.setUint16(23, m.sessionId, true);
  dv.setUint16(25, m.qrVersion, true);
  dv.setUint16(27, m.fps, true);
  dv.setUint32(29, m.estSeconds, true);
  dv.setUint32(33, m.payloadFnv, true);
  out.set(nameBytes, HEADER_LEN_V2);
  return out;
}

export function parseManifest(bytes: Uint8Array): Manifest | null {
  if (bytes.length < HEADER_LEN_V2) return null;
  for (let i = 0; i < MANIFEST_MAGIC.length; i++) {
    if (bytes[i] !== MANIFEST_MAGIC[i]) return null;
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = dv.getUint8(4);
  if (version !== 2) return null; // 老 version 1 不再解析（接收端提示更新）
  const nameLen = dv.getUint16(9, true);
  if (bytes.length !== HEADER_LEN_V2 + nameLen) return null;
  const layout = dv.getUint8(8) as Layout;
  if (!(layout in LAYOUT_GRID)) return null;
  return {
    version,
    payloadType: dv.getUint8(5) as 0 | 1,
    compression: dv.getUint8(6) as 0 | 1 | 2 | 3,
    codec: dv.getUint8(7) as Codec,
    layout,
    name: safeFileName(textDecoder.decode(bytes.subarray(HEADER_LEN_V2))),
    originalSize: dv.getUint32(11, true),
    transmittedSize: dv.getUint32(15, true),
    k: dv.getUint16(19, true),
    blockLen: dv.getUint16(21, true),
    sessionId: dv.getUint16(23, true),
    qrVersion: dv.getUint16(25, true),
    fps: dv.getUint16(27, true),
    estSeconds: dv.getUint32(29, true),
    payloadFnv: dv.getUint32(33, true),
  };
}

/** 构建 Manifest（发送端用）：算 k/estSeconds */
export function buildManifest(opts: {
  payloadType: 0 | 1;
  compression: 0 | 1 | 2 | 3;
  codec: Codec;
  layout: Layout;
  name: string;
  originalSize: number;
  transmittedSize: number;
  blockLen: number;
  sessionId: number;
  qrVersion: number;
  fps: number;
  payloadFnv?: number;
}): Manifest {
  const k = Math.max(1, Math.ceil(opts.transmittedSize / opts.blockLen));
  return {
    version: 2,
    payloadType: opts.payloadType,
    compression: opts.compression,
    codec: opts.codec,
    layout: opts.layout,
    name: opts.name,
    originalSize: opts.originalSize,
    transmittedSize: opts.transmittedSize,
    k,
    blockLen: opts.blockLen,
    sessionId: opts.sessionId,
    qrVersion: opts.qrVersion,
    fps: opts.fps,
    estSeconds: Math.ceil((k * 1.15) / opts.fps),
    payloadFnv: opts.payloadFnv ?? 0,
  };
}

/** 容器 FNV（发送端对文件容器做预校验） */
export function containerFnv(container: Uint8Array): number {
  return fnv1a(container);
}
