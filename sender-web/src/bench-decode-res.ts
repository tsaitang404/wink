// 降分辨率对各 QR 版本解码的影响测试
import * as QRCode from 'qrcode';
import { readBarcodesFromImageData } from 'zxing-wasm/full';

const QR_CAP: number[] = [0, 17, 32, 53, 78, 106, 134, 154, 192, 230, 271,
  321, 367, 425, 458, 520, 586, 644, 718, 792, 858,
  929, 1003, 1091, 1171, 1273, 1367, 1465, 1528, 1628, 1732,
  1840, 1952, 2068, 2188, 2303, 2431, 2563, 2699, 2809, 2953];

function qrSeg(bytes: Uint8Array) { return [{ data: bytes, mode: 'byte' as const }]; }
function med(a: number[]) { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? 0; }

async function genQr(data: Uint8Array, v: number, w: number): Promise<ImageData> {
  const c = document.createElement('canvas');
  await QRCode.toCanvas(c, qrSeg(data) as never, { errorCorrectionLevel: 'L', margin: 2, width: w, version: v });
  return c.getContext('2d')!.getImageData(0, 0, c.width, c.height);
}

function scaleImageData(src: ImageData, targetW: number): ImageData {
  const c = document.createElement('canvas');
  c.width = targetW;
  c.height = Math.round(targetW * src.height / src.width);
  const ctx = c.getContext('2d')!;
  // 画原图到小 canvas
  const tmp = document.createElement('canvas');
  tmp.width = src.width;
  tmp.height = src.height;
  tmp.getContext('2d')!.putImageData(src, 0, 0);
  ctx.drawImage(tmp, 0, 0, c.width, c.height);
  return ctx.getImageData(0, 0, c.width, c.height);
}

async function benchDecode(img: ImageData, n = 20): Promise<{ ok: boolean; ms: number }> {
  let ok = false;
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    const results = await readBarcodesFromImageData(img, { formats: ['QRCode'], tryHarder: true });
    times.push(performance.now() - t0);
    if (results.length > 0) ok = true;
  }
  return { ok, ms: med(times) };
}

export async function runDecodeResTest() {
  const r: string[] = ['=== 降分辨率对各 QR 版本解码的影响 ===\n'];

  // 测试矩阵：QR 版本 × 渲染分辨率 × 解码分辨率
  const versions = [15, 20, 27, 40];
  const renderSizes = [400]; // 发送端渲染尺寸
  const decodeSizes = [100, 150, 200, 256, 300, 400]; // 接收端解码尺寸

  for (const v of versions) {
    const cap = QR_CAP[v];
    const data = new Uint8Array(cap!).map((_, i) => i & 0xff);
    r.push(`--- v${v} (${cap}B 载荷) ---`);

    // 1. 先在原始分辨率测试
    const origImg = await genQr(data, v, 400);
    const orig = await benchDecode(origImg, 20);
    r.push(`  原始 ${origImg.width}×${origImg.height}: ${orig.ok ? '✓' : '✗'} ${orig.ms.toFixed(1)}ms`);

    // 2. 降分辨率测试
    for (const ds of decodeSizes) {
      if (ds >= 400) continue; // 跳过原始尺寸
      const scaled = scaleImageData(origImg, ds);
      const result = await benchDecode(scaled, 20);
      const ratio = (orig.ms / result.ms).toFixed(1);
      r.push(`  降到 ${ds}×${scaled.height}: ${result.ok ? '✓' : '✗'} ${result.ms.toFixed(1)}ms (${ratio}×)`);
    }
    r.push('');
  }

  // 总结
  r.push('--- 总结 ---');
  r.push('如果低分辨率仍能解码 v40，说明可以安全降分辨率。');
  r.push('如果 v40 在低分辨率下失败，需要按版本自适应分辨率。');

  const out = r.join('\n');
  console.log(out);

  const pre = document.createElement('pre');
  pre.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;background:#111;color:#0f0;font-size:12px;padding:16px;overflow:auto;white-space:pre-wrap';
  pre.textContent = out;
  document.body.appendChild(pre);
}
