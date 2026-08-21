// zxing-wasm 解码性能测试
import * as QRCode from 'qrcode';
import { readBarcodesFromImageData } from 'zxing-wasm/full';

const QR_CAP: number[] = [0, 17, 32, 53, 78, 106, 134, 154, 192, 230, 271,
  321, 367, 425, 458, 520, 586, 644, 718, 792, 858,
  929, 1003, 1091, 1171, 1273, 1367, 1465, 1528, 1628, 1732,
  1840, 1952, 2068, 2188, 2303, 2431, 2563, 2699, 2809, 2953];

function qrSeg(bytes: Uint8Array) { return [{ data: bytes, mode: 'byte' as const }]; }
function med(a: number[]) { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? 0; }

async function genQr(data: Uint8Array, v: number, w = 400): Promise<ImageData> {
  const c = document.createElement('canvas');
  await QRCode.toCanvas(c, qrSeg(data) as never, { errorCorrectionLevel: 'L', margin: 2, width: w, version: v });
  return c.getContext('2d')!.getImageData(0, 0, c.width, c.height);
}

async function benchDecode(img: ImageData, n = 50): Promise<number[]> {
  const t: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await readBarcodesFromImageData(img, { formats: ['QRCode'], tryHarder: true });
    t.push(performance.now() - t0);
  }
  return t;
}

export async function runZxingBench() {
  const r: string[] = ['=== zxing-wasm 解码性能 ===\n'];

  for (const v of [15, 20, 27, 40]) {
    const cap = QR_CAP[v];
    const data = new Uint8Array(cap!).map((_, i) => i & 0xff);
    const img = await genQr(data, v);
    const times = await benchDecode(img, 50);
    const m = med(times);
    const sorted = [...times].sort((a, b) => a - b);
    r.push(`v${v} (${cap}B, ${img.width}×${img.height}): 中位 ${m.toFixed(1)}ms → ${(1000 / m).toFixed(1)} 解码/秒`);
  }

  r.push('\n--- 分辨率影响 (v20) ---');
  const d20 = new Uint8Array(838).map((_, i) => i & 0xff);
  for (const w of [200, 300, 400, 600, 800]) {
    const img = await genQr(d20, 20, w);
    const times = await benchDecode(img, 30);
    r.push(`  ${w}×${img.height}: ${med(times).toFixed(1)}ms → ${(1000 / med(times)).toFixed(1)}/s`);
  }

  r.push('\n--- 摄像头帧率 vs 解码 (v27) ---');
  const d27 = new Uint8Array(1445).map((_, i) => i & 0xff);
  const img27 = await genQr(d27, 27);
  const t27 = await benchDecode(img27, 50);
  const m27 = med(t27);
  for (const fps of [30, 60, 90, 120]) {
    const ok = m27 < 1000 / fps;
    const eff = ok ? fps : Math.floor(1000 / m27);
    r.push(`  ${fps}fps: ${ok ? '✓' : '✗跳帧'} → 有效 ${eff}fps → ${(1445 * eff / 1024).toFixed(1)} KB/s`);
  }
  r.push(`\nv27 解码中位 ${m27.toFixed(1)}ms`);

  const out = r.join('\n');
  console.log(out);
  const pre = document.createElement('pre');
  pre.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;background:#111;color:#0f0;font-size:12px;padding:16px;overflow:auto;white-space:pre-wrap';
  pre.textContent = out;
  document.body.appendChild(pre);
}
