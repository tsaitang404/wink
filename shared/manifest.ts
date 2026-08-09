// wink 元信息帧（Manifest）—— 协议协商与传输预览
//
// 选文件后发送端先显示元信息 QR（永远黑白，保证可扫），
// codec 字段声明帧流编码（v0.1 只实现 0=黑白）。
// 字节布局见 protocol/spec.md 第 4 节。

import { MANIFEST_MAGIC, fnv1a, safeFileName } from './protocol';

export type Codec = 0 | 1 | 2; // 0=黑白 1=四色 2=八色

export interface Manifest {
  version: number; // 1
  payloadType: 0 | 1; // 0=file 1=text
  compression: 0 | 1;
  codec: Codec;
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

export function packManifest(m: Manifest): Uint8Array {
  const nameBytes = textEncoder.encode(safeFileName(m.name));
  const out = new Uint8Array(36 + nameBytes.length);
  const dv = new DataView(out.buffer);
  out.set(MANIFEST_MAGIC, 0);
  dv.setUint8(4, m.version);
  dv.setUint8(5, m.payloadType);
  dv.setUint8(6, m.compression);
  dv.setUint8(7, m.codec);
  dv.setUint16(8, nameBytes.length, true);
  dv.setUint32(10, m.originalSize, true);
  dv.setUint32(14, m.transmittedSize, true);
  dv.setUint16(18, m.k, true);
  dv.setUint16(20, m.blockLen, true);
  dv.setUint16(22, m.sessionId, true);
  dv.setUint16(24, m.qrVersion, true);
  dv.setUint16(26, m.fps, true);
  dv.setUint32(28, m.estSeconds, true);
  dv.setUint32(32, m.payloadFnv, true);
  out.set(nameBytes, 36);
  return out;
}

export function parseManifest(bytes: Uint8Array): Manifest | null {
  if (bytes.length < 36) return null;
  for (let i = 0; i < MANIFEST_MAGIC.length; i++) {
    if (bytes[i] !== MANIFEST_MAGIC[i]) return null;
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = dv.getUint8(4);
  if (version !== 1) return null;
  const nameLen = dv.getUint16(8, true);
  if (bytes.length !== 36 + nameLen) return null;
  return {
    version,
    payloadType: dv.getUint8(5) as 0 | 1,
    compression: dv.getUint8(6) as 0 | 1,
    codec: dv.getUint8(7) as Codec,
    name: safeFileName(textDecoder.decode(bytes.subarray(36))),
    originalSize: dv.getUint32(10, true),
    transmittedSize: dv.getUint32(14, true),
    k: dv.getUint16(18, true),
    blockLen: dv.getUint16(20, true),
    sessionId: dv.getUint16(22, true),
    qrVersion: dv.getUint16(24, true),
    fps: dv.getUint16(26, true),
    estSeconds: dv.getUint32(28, true),
    payloadFnv: dv.getUint32(32, true),
  };
}

/** 构建 Manifest（发送端用）：算 k/estSeconds */
export function buildManifest(opts: {
  payloadType: 0 | 1;
  compression: 0 | 1;
  codec: Codec;
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
    version: 1,
    payloadType: opts.payloadType,
    compression: opts.compression,
    codec: opts.codec,
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
