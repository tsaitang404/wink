// wink 性能测试工具 —— 测量 QR 渲染 + LT 编码实际速度
import * as QRCode from 'qrcode';
import { LTEncoder, LTDecoder } from '../../shared/fountain.ts';
import { packFrame, fnv1a, HEADER_LEN } from '../../shared/protocol.ts';

const QR_CAPACITY: Record<number, number> = {
  1: 17, 2: 32, 3: 53, 4: 78, 5: 106, 6: 134, 7: 154, 8: 192, 9: 230, 10: 271,
  11: 321, 12: 367, 13: 425, 14: 458, 15: 520, 16: 586, 17: 644, 18: 718, 19: 792, 20: 858,
  21: 929, 22: 1003, 23: 1091, 24: 1171, 25: 1273, 26: 1367, 27: 1465, 28: 1528, 29: 1628, 30: 1732,
  31: 1840, 32: 1952, 33: 2068, 34: 2188, 35: 2303, 36: 2431, 37: 2563, 38: 2699, 39: 2809, 40: 2953,
};

function qrSegments(bytes: Uint8Array): Array<{ data: Uint8Array; mode: 'byte' }> {
  return [{ data: bytes, mode: 'byte' }];
}

function median(arr: number[]): number {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

async function benchQrRender(canvas: HTMLCanvasElement, data: Uint8Array, version: number, iterations = 50): Promise<number> {
  const times: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    await QRCode.toCanvas(canvas, qrSegments(data) as never, {
      errorCorrectionLevel: 'L',
      margin: 2,
      width: 400,
      version,
    });
    times.push(performance.now() - t0);
  }
  return median(times);
}

function benchLtEncode(data: Uint8Array, blockLen: number, iterations = 100): { ms: number; frames: number } {
  const times: number[] = [];
  let totalFrames = 0;
  for (let i = 0; i < iterations; i++) {
    const encoder = new LTEncoder(data, blockLen, 1);
    const framesNeeded = Math.ceil(encoder.k * 1.15);
    const t0 = performance.now();
    for (let seq = 0; seq < framesNeeded; seq++) encoder.encode(seq);
    times.push(performance.now() - t0);
    totalFrames += framesNeeded;
  }
  return { ms: median(times), frames: totalFrames / iterations };
}

function benchLtDecode(data: Uint8Array, blockLen: number, iterations = 20): number {
  const times: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const encoder = new LTEncoder(data, blockLen, 1);
    const decoder = new LTDecoder(encoder.k, blockLen, 1, data.length);
    const framesNeeded = Math.ceil(encoder.k * 1.15);
    const t0 = performance.now();
    for (let seq = 0; seq < framesNeeded; seq++) {
      decoder.addFrame(seq, encoder.encode(seq));
    }
    times.push(performance.now() - t0);
  }
  return median(times);
}

export async function runBenchmarks() {
  const canvas = document.createElement('canvas');
  canvas.width = 400;
  canvas.height = 400;
  const r: string[] = [];

  r.push('=== wink 性能测试 ===\n');

  // QR 渲染速度
  r.push('--- QR 渲染速度 ---');
  for (const v of [15, 20, 27, 40]) {
    const cap = QR_CAPACITY[v]!;
    const data = new Uint8Array(cap).map((_, i) => i & 0xff);
    const ms = await benchQrRender(canvas, data, v, 30);
    r.push(`  v${v} (${cap}B): ${ms.toFixed(1)}ms → 理论 ${(1000 / ms).toFixed(1)} fps`);
  }

  // LT 编码速度
  r.push('\n--- LT 编码速度 ---');
  const sizes: [string, number][] = [['1KB', 1024], ['10KB', 10240], ['100KB', 102400], ['1MB', 1048576]];
  for (const [label, size] of sizes) {
    const data = new Uint8Array(size).map((_, i) => (i * 13 + 7) & 0xff);
    const { ms, frames } = benchLtEncode(data, 838, 10);
    r.push(`  ${label}: ${ms.toFixed(1)}ms/轮 (${frames} 帧) → ${(size / ms * 1000 / 1024).toFixed(0)} KB/s`);
  }

  // LT 解码速度
  r.push('\n--- LT 解码速度 ---');
  for (const [label, size] of sizes) {
    const data = new Uint8Array(size).map((_, i) => (i * 13 + 7) & 0xff);
    const ms = benchLtDecode(data, 838, 10);
    r.push(`  ${label}: ${ms.toFixed(1)}ms → ${(size / ms * 1000 / 1024).toFixed(0)} KB/s`);
  }

  // 真实场景模拟
  r.push('\n--- 真实场景 (30fps, QR渲染+解码延迟) ---');
  for (const v of [15, 20, 27, 40]) {
    const cap = QR_CAPACITY[v]!;
    const payloadCap = cap - HEADER_LEN;
    const data = new Uint8Array(payloadCap).map((_, i) => i & 0xff);
    const qrMs = await benchQrRender(canvas, data, v, 20);
    const decMs = benchLtDecode(data, payloadCap, 5);
    const totalFrameMs = qrMs + decMs;
    const effectiveFps = Math.min(30, 1000 / totalFrameMs);
    const bw = payloadCap * effectiveFps;
    r.push(`  v${v} (${payloadCap}B): QR ${qrMs.toFixed(1)}ms + 解码 ${decMs.toFixed(1)}ms = ${(effectiveFps).toFixed(1)}fps → ${(bw / 1024).toFixed(1)} KB/s`);
  }

  const output = r.join('\n');
  console.log(output);

  const pre = document.createElement('pre');
  pre.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;background:#111;color:#0f0;font-size:12px;padding:16px;overflow:auto;white-space:pre-wrap';
  pre.textContent = output;
  document.body.appendChild(pre);
}
