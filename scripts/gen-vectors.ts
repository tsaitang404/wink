// 生成金标准向量（跨语言一致性的唯一保险）
// 用法: npm run gen-vectors
// 输出: protocol/golden-vectors/*.bin|tsv （提交进 git，Rust 端断言相等）

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { dlog, solitonCdf, frameIndices } from '../shared/fountain.ts';
import { packFrame, fnv1a, splitmix32 } from '../shared/protocol.ts';
import { packManifest, buildManifest } from '../shared/manifest.ts';
import { packFile } from '../shared/container.ts';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'protocol', 'golden-vectors');
mkdirSync(outDir, { recursive: true });

// 1. dlog-vector.tsv: dlog(x) hex 对 500 个固定 x
function hex64(f: number): string {
  const buf = new ArrayBuffer(8);
  new Float64Array(buf)[0] = f;
  const dv = new DataView(buf);
  return dv.getBigUint64(0, false).toString(16).padStart(16, '0');
}
{
  const lines: string[] = ['x\tdlog_hex'];
  for (let i = 0; i < 500; i++) {
    const x = 0.25 + (i / 499) * 1000; // 0.25 .. 1000.25
    lines.push(`${x.toFixed(6)}\t${hex64(dlog(x))}`);
  }
  writeFileSync(join(outDir, 'dlog-vector.tsv'), lines.join('\n') + '\n');
  console.log('dlog-vector.tsv:', lines.length - 1, 'values');
}

// 2. soliton-k100.bin: Float64Array(100) little-endian 原始字节
{
  const cdf = solitonCdf(100);
  const buf = new ArrayBuffer(100 * 8);
  const f64 = new Float64Array(buf);
  f64.set(cdf);
  const bytes = new Uint8Array(buf);
  writeFileSync(join(outDir, 'soliton-k100.bin'), bytes);
  console.log('soliton-k100.bin:', bytes.length, 'bytes');
}

// 3. frame-session1.bin: 固定帧
{
  const sessionId = 1;
  const seq = 0;
  const k = 4;
  const blockLen = 16;
  const payload = new TextEncoder().encode('hello world 1234');
  const totalLen = 100; // 模拟容器长
  const payloadFnv = fnv1a(payload);
  const block = new Uint8Array(blockLen);
  block.set(payload.subarray(0, blockLen));
  const frame = packFrame({ sessionId, seq, k, blockLen, totalLen, payloadFnv }, block);
  writeFileSync(join(outDir, 'frame-session1.bin'), frame);
  console.log('frame-session1.bin:', frame.length, 'bytes');
}

// 4. container-sample.bin: 固定文件容器
{
  const bytes = new TextEncoder().encode('wink golden container payload 1234567890');
  const packed = await packFile('golden.txt', 'text/plain', bytes);
  writeFileSync(join(outDir, 'container-sample.bin'), packed.container);
  console.log('container-sample.bin:', packed.container.length, 'bytes, compression:', packed.compression);
}

// 5. manifest-sample.bin: 固定 manifest
{
  const m = buildManifest({
    payloadType: 0,
    compression: 0,
    codec: 0,
    name: 'golden.txt',
    originalSize: 1234,
    transmittedSize: 1234,
    blockLen: 128,
    sessionId: 7,
    qrVersion: 15,
    fps: 30,
    payloadFnv: 0x12345678,
  });
  writeFileSync(join(outDir, 'manifest-sample.bin'), packManifest(m));
  console.log('manifest-sample.bin:', packManifest(m).length, 'bytes');
}

// 6. splitmix32-seq.bin: splitmix32(1234) 前 64 个 u32 值（小端）
{
  const rnd = splitmix32(1234);
  const arr = new Uint32Array(64);
  for (let i = 0; i < 64; i++) arr[i] = rnd();
  writeFileSync(join(outDir, 'splitmix32-seq.bin'), new Uint8Array(arr.buffer));
  console.log('splitmix32-seq.bin:', 64 * 4, 'bytes');
}

console.log('全部金标准向量已生成 →', outDir);
