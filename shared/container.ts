// wink 文件/文本容器打包（TS 单一权威实现）
//
// 容器字节布局见 protocol/spec.md 第 2、3 节。
// 跨语言：Rust 端复制此布局 + golden 断言。

import {
  FILE_MAGIC,
  TEXT_MAGIC,
  FILE_HEADER_LEN,
  MAX_FILE_BYTES,
  MAX_SNIPPET_BYTES,
  fnv1a,
  safeFileName,
} from './protocol';
import * as lzmaWasm from 'lzma-wasm';

// lzma-wasm：兼容 ESM/CJS interop（Node tsx 命名导出解析不同，统一 namespace 取）
type LzmaModule = {
  initWasm?: () => Promise<unknown>;
  compress?: (d: Uint8Array, o?: { format?: 'xz'; level?: number }) => Uint8Array;
  decompress?: (d: Uint8Array) => Uint8Array;
};
function lzmaMod(): LzmaModule {
  const m = lzmaWasm as unknown as LzmaModule & { default?: LzmaModule };
  return (m.initWasm ? m : m.default ?? m) as LzmaModule;
}

// lzma-wasm：懒初始化（wasm 加载一次）
let lzmaReady: Promise<unknown> | null = null;
async function lzmaInit(): Promise<void> {
  if (!lzmaReady) {
    lzmaReady = lzmaMod().initWasm?.() ?? Promise.resolve();
  }
  await lzmaReady;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export type CompressionMode = 'none' | 'gzip' | 'brotli' | 'xz';

export interface PackedFile {
  container: Uint8Array;
  compression: CompressionMode;
  originalSize: number;
  transmittedSize: number;
}

export interface UnpackedFile {
  name: string;
  type: string;
  sha256: Uint8Array;
  bytes: Uint8Array;
  compression: CompressionMode;
}

async function digest(bytes: Uint8Array<ArrayBufferLike>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(
    await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource),
  );
}

// xz 压缩/解压（lzma-wasm，浏览器 & Node 都可用）
// 不可用时返回 null（packFile 降级不压缩；unpackFile 抛错）
async function xzAsync(bytes: Uint8Array): Promise<Uint8Array | null> {
  await lzmaInit();
  const compress = lzmaMod().compress;
  if (!compress) return null;
  try {
    return compress(bytes, { format: 'xz', level: 6 });
  } catch {
    return null;
  }
}

async function unxzAsync(bytes: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  await lzmaInit();
  const decompress = lzmaMod().decompress;
  if (!decompress) throw new Error('lzma-wasm unavailable');
  const out = decompress(bytes);
  if (out.length > maxBytes) {
    throw new Error('The recovered file expands past its declared length.');
  }
  return out;
}

// 流式解压（gzip/brotli 旧格式兼容，浏览器 DecompressionStream）
async function streamDecompress(
  bytes: Uint8Array,
  maxBytes: number,
  format: CompressionFormat,
): Promise<Uint8Array> {
  const inflated = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream(format));
  const reader = inflated.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('The recovered file expands past its declared length.');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// 预压缩类型（gzip 无益，跳过）
const PRECOMPRESSED_TYPES = new Set([
  'application/gzip',
  'application/java-archive',
  'application/vnd.rar',
  'application/x-7z-compressed',
  'application/x-brotli',
  'application/x-bzip',
  'application/x-bzip2',
  'application/x-gzip',
  'application/x-lzma',
  'application/x-rar-compressed',
  'application/x-xz',
  'application/x-zip-compressed',
  'application/zip',
  'application/zstd',
]);
const COMPRESSIBLE_IMAGES = /^image\/(bmp|x-ms-bmp|svg\+xml|tiff|x-icon|vnd\.microsoft\.icon)$/;
const COMPRESSIBLE_AUDIO = /^audio\/(wav|x-wav|wave|vnd\.wave|aiff|x-aiff|basic|l16)$/;

export function isPrecompressedType(type: string): boolean {
  const media = type.split(';')[0]!.trim().toLowerCase();
  if (media.startsWith('video/')) return true;
  if (media.startsWith('image/')) return !COMPRESSIBLE_IMAGES.test(media);
  if (media.startsWith('audio/')) return !COMPRESSIBLE_AUDIO.test(media);
  if (media.startsWith('application/vnd.openxmlformats-officedocument.')) return true;
  if (media.startsWith('application/vnd.oasis.opendocument.')) return true;
  if (media.endsWith('+zip')) return true;
  return PRECOMPRESSED_TYPES.has(media);
}

export async function packFile(name: string, type: string, bytes: Uint8Array): Promise<PackedFile> {
  if (bytes.length === 0) throw new Error('Choose a non-empty file.');
  if (bytes.length > MAX_FILE_BYTES) throw new Error(`Files are limited to 64 MB in this browser build.`);

  const nameBytes = textEncoder.encode(safeFileName(name));
  const typeBytes = textEncoder.encode(type || 'application/octet-stream');
  if (nameBytes.length > 0xffff || typeBytes.length > 0xffff) {
    throw new Error('The file name or media type is too long.');
  }

  const tryCompress = bytes.length >= 768 && !isPrecompressedType(type);
  const [sha256, compressed] = await Promise.all([
    digest(bytes),
    tryCompress ? xzAsync(bytes) : Promise.resolve(undefined),
  ]);
  const useCompression =
    compressed != null && compressed.length + 64 < bytes.length;
  const transmitted = useCompression ? compressed : bytes;
  const compression: CompressionMode = useCompression ? 'xz' : 'none';

  const out = new Uint8Array(
    FILE_HEADER_LEN + nameBytes.length + typeBytes.length + transmitted.length,
  );
  const view = new DataView(out.buffer);
  out.set(FILE_MAGIC, 0);
  view.setUint8(4, useCompression ? 3 : 0);
  view.setUint16(5, nameBytes.length, true);
  view.setUint16(7, typeBytes.length, true);
  view.setUint32(9, bytes.length, true);
  view.setUint32(13, transmitted.length, true);
  out.set(sha256, 17);
  out.set(nameBytes, FILE_HEADER_LEN);
  out.set(typeBytes, FILE_HEADER_LEN + nameBytes.length);
  out.set(transmitted, FILE_HEADER_LEN + nameBytes.length + typeBytes.length);
  return { container: out, compression, originalSize: bytes.length, transmittedSize: transmitted.length };
}

export async function unpackFile(container: Uint8Array): Promise<UnpackedFile> {
  if (container.length < FILE_HEADER_LEN) throw new Error('The recovered file header is incomplete.');
  for (let i = 0; i < FILE_MAGIC.length; i++) {
    if (container[i] !== FILE_MAGIC[i]) throw new Error('The recovered file header is invalid.');
  }
  const view = new DataView(container.buffer, container.byteOffset, container.byteLength);
  const compressionByte = view.getUint8(4);
  if (compressionByte > 3) throw new Error('The recovered file uses unsupported compression.');
  const compression: CompressionMode =
    compressionByte === 3
      ? 'xz'
      : compressionByte === 2
        ? 'brotli'
        : compressionByte === 1
          ? 'gzip'
          : 'none';
  const nameLength = view.getUint16(5, true);
  const typeLength = view.getUint16(7, true);
  const fileLength = view.getUint32(9, true);
  const transmittedLength = view.getUint32(13, true);
  const dataOffset = FILE_HEADER_LEN + nameLength + typeLength;
  if (
    fileLength === 0 ||
    fileLength > MAX_FILE_BYTES ||
    transmittedLength === 0 ||
    transmittedLength > MAX_FILE_BYTES ||
    dataOffset + transmittedLength !== container.length
  ) {
    throw new Error('The recovered file length does not match its header.');
  }
  const transmitted = container.slice(dataOffset);
  let bytes: Uint8Array;
  if (compression === 'xz') {
    bytes = await unxzAsync(transmitted, fileLength);
  } else if (compression === 'gzip' || compression === 'brotli') {
    bytes = await streamDecompress(
      transmitted,
      fileLength,
      compression === 'brotli' ? ('br' as CompressionFormat) : 'gzip',
    );
  } else {
    bytes = transmitted;
  }
  if (bytes.length !== fileLength) {
    throw new Error('The decompressed file length does not match its header.');
  }
  return {
    name: safeFileName(textDecoder.decode(container.subarray(FILE_HEADER_LEN, FILE_HEADER_LEN + nameLength))),
    type: textDecoder.decode(container.subarray(FILE_HEADER_LEN + nameLength, dataOffset)) || 'application/octet-stream',
    sha256: container.slice(17, 49),
    bytes,
    compression,
  };
}

export async function verifyFile(file: UnpackedFile): Promise<boolean> {
  const actual = await digest(file.bytes);
  return actual.every((value, index) => value === file.sha256[index]);
}

// ─────────────────────────────────────────────
// 文本容器（WNKT）
// ─────────────────────────────────────────────

export function packSnippet(text: string): Uint8Array {
  const bytes = textEncoder.encode(text);
  if (bytes.length > MAX_SNIPPET_BYTES) throw new Error('Text snippets are limited to 4 MB.');
  const out = new Uint8Array(8 + bytes.length);
  out.set(TEXT_MAGIC, 0);
  new DataView(out.buffer).setUint32(4, bytes.length, true);
  out.set(bytes, 8);
  return out;
}

export function unpackSnippet(container: Uint8Array): string {
  if (container.length < 8) throw new Error('Text container too short.');
  for (let i = 0; i < TEXT_MAGIC.length; i++) {
    if (container[i] !== TEXT_MAGIC[i]) throw new Error('Not a text container.');
  }
  const len = new DataView(container.buffer, container.byteOffset, container.byteLength).getUint32(4, true);
  if (8 + len !== container.length) throw new Error('Text container length mismatch.');
  return textDecoder.decode(container.subarray(8));
}
