// wink 协议核心（TS 单一权威实现）
//
// 跨语言确定性铁律：
// - 本文件是协议字节布局的唯一事实源（Rust 端复制 + golden 断言锁死）
// - 所有整数运算必须与 Rust u32 wrapping 语义一致
// - 协议路径禁止 Math.log/Math.random（用 dlog / splitmix32）

// ─────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────

export const FRAME_MAGIC = 0x57; // 'W'
export const FRAME_VERSION = 0x01;
export const HEADER_LEN = 20; // magic(1)+version(1)+sessionId(2)+seq(4)+k(2)+blockLen(2)+totalLen(4)+payloadFnv(4)

export const FILE_MAGIC = new Uint8Array([0x57, 0x4e, 0x4b, 0x31]); // "WNK1"
export const TEXT_MAGIC = new Uint8Array([0x57, 0x4e, 0x4b, 0x54]); // "WNKT"
export const MANIFEST_MAGIC = new Uint8Array([0x57, 0x4e, 0x4b, 0x4d]); // "WNKM"

export const FILE_HEADER_LEN = 49;
export const MAX_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_FILE_LABEL = `${MAX_FILE_BYTES / 1024 / 1024} MB`;
export const MAX_SOURCE_BLOCKS = 0xffff;
export const MAX_SNIPPET_BYTES = 4 * 1024 * 1024;

// ─────────────────────────────────────────────
// FNV-1a（纯 u32 整数运算，与 Rust wrapping 一致）
// ─────────────────────────────────────────────

export function fnv1a(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ─────────────────────────────────────────────
// splitmix32（确定性 PRNG，纯整数运算）
// JS: Math.imul ≡ Rust: wrapping_mul
// JS: >>> ≡ Rust: >> (u32)
// ─────────────────────────────────────────────

export function splitmix32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x9e3779b9) | 0;
    let t = s ^ (s >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    t ^= t >>> 15;
    return t >>> 0;
  };
}

// ─────────────────────────────────────────────
// 帧头
// ─────────────────────────────────────────────

export interface FrameHeader {
  sessionId: number; // u16
  seq: number; // u32
  k: number; // u16
  blockLen: number; // u16
  totalLen: number; // u32
  payloadFnv: number; // u32
}

export function packFrame(h: FrameHeader, block: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER_LEN + block.length);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, FRAME_MAGIC);
  dv.setUint8(1, FRAME_VERSION);
  dv.setUint16(2, h.sessionId, true);
  dv.setUint32(4, h.seq, true);
  dv.setUint16(8, h.k, true);
  dv.setUint16(10, h.blockLen, true);
  dv.setUint32(12, h.totalLen, true);
  dv.setUint32(16, h.payloadFnv, true);
  out.set(block, HEADER_LEN);
  return out;
}

export function parseFrame(
  bytes: Uint8Array,
): { header: FrameHeader; block: Uint8Array } | null {
  if (bytes.length <= HEADER_LEN) return null;
  if (bytes[0] !== FRAME_MAGIC || bytes[1] !== FRAME_VERSION) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header: FrameHeader = {
    sessionId: dv.getUint16(2, true),
    seq: dv.getUint32(4, true),
    k: dv.getUint16(8, true),
    blockLen: dv.getUint16(10, true),
    totalLen: dv.getUint32(12, true),
    payloadFnv: dv.getUint32(16, true),
  };
  if (header.k === 0 || header.blockLen === 0 || header.totalLen === 0) return null;
  if (bytes.length !== HEADER_LEN + header.blockLen) return null;
  return { header, block: bytes.subarray(HEADER_LEN) };
}

/** 流标识：任何字段变化即重置（防 sessionId 16 位碰撞静默错乱） */
export function streamIdentity(h: FrameHeader): string {
  return `${h.sessionId}:${h.k}:${h.blockLen}:${h.totalLen}:${h.payloadFnv}`;
}

// ─────────────────────────────────────────────
// 安全文件名
// ─────────────────────────────────────────────

export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned === '' || cleaned === '.' || cleaned === '..'
    ? 'transfer.bin'
    : cleaned;
}
