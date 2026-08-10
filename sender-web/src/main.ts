// wink 发送端（单 HTML）：选文件 → 元信息 QR → 参数可调 → 帧流
import * as QRCode from 'qrcode';
import { LTEncoder } from '../../shared/fountain.ts';
import { packFrame, fnv1a, HEADER_LEN } from '../../shared/protocol.ts';
import { packFile, packSnippet } from '../../shared/container.ts';
import { buildManifest, packManifest, LAYOUT_GRID, type Layout } from '../../shared/manifest.ts';

const $ = (id: string) => document.getElementById(id)!;
const canvas = $('qr') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

// QR 版本 → payload 容量（byte mode, ECC L，标准 v1-v40）
const QR_CAPACITY: Record<number, number> = {
  1: 17, 2: 32, 3: 53, 4: 78, 5: 106, 6: 134, 7: 154, 8: 192, 9: 230, 10: 271,
  11: 321, 12: 367, 13: 425, 14: 458, 15: 520, 16: 586, 17: 644, 18: 718, 19: 792, 20: 858,
  21: 929, 22: 1003, 23: 1091, 24: 1171, 25: 1273, 26: 1367, 27: 1465, 28: 1528, 29: 1628, 30: 1732,
  31: 1840, 32: 1952, 33: 2068, 34: 2188, 35: 2303, 36: 2431, 37: 2563, 38: 2699, 39: 2809, 40: 2953,
};

let fileBytes: Uint8Array | null = null;
let fileName = '';
let fileType = '';
let container: Uint8Array | null = null;
let containerCompressed = false;
let sessionId = 0;
let encoder: LTEncoder | null = null;
let streaming = false;
let streamTimer: ReturnType<typeof setInterval> | null = null;
let seq = 0;
let snippetText = '';
let layout: Layout = 0; // 多码布局（0=单码）

function pickFile() {
  $('file-input').click();
}

$('pick-btn').addEventListener('click', pickFile);
$('file-input').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  await loadPayload(file.name, file.type || 'application/octet-stream', bytes);
});

$('paste-btn').addEventListener('click', async () => {
  const text = prompt('粘贴要发送的文本（≤ 4MB）：');
  if (text == null) return;
  snippetText = text;
  const bytes = new TextEncoder().encode(text);
  const snip = packSnippet(text);
  await loadPayload('文本片段', 'text/plain', snip, bytes.length);
});

async function loadPayload(name: string, type: string, bytes: Uint8Array, displaySize?: number) {
  fileBytes = bytes;
  fileName = name;
  fileType = type;
  sessionId = (Math.random() * 0xffff) | 0;
  streaming = false;
  if (streamTimer) clearInterval(streamTimer);
  $('start-btn').style.display = 'none';
  $('stop-btn').style.display = 'none';
  $('filename').textContent = `${name} · ${fmtSize(displaySize ?? bytes.length)}`;
  $('status').textContent = '已选择，生成元信息二维码…';

  // 打包容器（文件场景：传原始字节；文本场景：bytes 已是 WNKT 容器）
  if (type !== 'text/plain' || true) {
    // 文件：packFile 产生容器；文本：bytes 是 WNKT 容器
    if (name !== '文本片段') {
      const packed = await packFile(name, type, bytes);
      container = packed.container;
      containerCompressed = packed.compression !== 'none';
    } else {
      container = bytes;
    }
  }

  renderManifest();
  $('status').textContent = '已就绪 —— 接收端扫码后点开始';
  $('start-btn').style.display = 'inline-block';
}

function currentParams() {
  let fps = Number(($('fps') as HTMLInputElement).value);
  let qrVersion = Number(($('qr-size') as HTMLSelectElement).value);
  // 多码时版本上限：码越小，模块越密，接收端难扫
  // 1x2/1x3 → 最多 v20；2x2/2x3 → 最多 v15（每码 400px 下保证 ~4px/模块）
  const maxV = layout === 0 ? 40 : layout <= 2 ? 20 : 15;
  if (qrVersion > maxV) qrVersion = maxV;
  // 多码时 fps 上限：屏幕刷新越快，摄像头滚动快门撕裂越严重（画面上下两帧混合）
  // 单码 30fps 可接受；多码码小，撕裂直接导致无法识别 → 强制 ≤15fps
  if (layout !== 0 && fps > 15) fps = 15;
  const payloadCap = QR_CAPACITY[qrVersion]! - HEADER_LEN;
  // 块长自动优化：填满 QR 容量（pad 最少，QR 变化明显）。
  // JS 端 qrSegments 强制 byte mode 单段，容量精确，无需余量（与 Rust CLI 一致）
  const blockLen = Math.max(64, payloadCap);
  return { fps, qrVersion, blockLen, payloadCap };
}

// qrcode 库需要 byte mode segment 才能编码二进制（默认按 UTF-8 会损坏）
function qrSegments(bytes: Uint8Array): Array<{ data: Uint8Array; mode: 'byte' }> {
  return [{ data: bytes, mode: 'byte' }];
}

async function drawQr(bytes: Uint8Array, qrVersion?: number) {
  await QRCode.toCanvas(canvas, qrSegments(bytes) as never, {
    errorCorrectionLevel: 'L',
    margin: 2,
    width: 400,
    version: qrVersion,
  });
}

/** 多码网格渲染：layout 布局下画 N 个码（每码临时 canvas → blit 到网格位置） */
async function drawGrid(frames: Array<{ bytes: Uint8Array; version?: number }>, lay: Layout) {
  const g = LAYOUT_GRID[lay];
  const n = g.rows * g.cols;
  // 动态画布：单码 400，多码按网格放大（每码 400，加间隔）
  const gap = 32; // 码间距（px）
  const cw = 400;
  canvas.width = g.cols * cw + (g.cols + 1) * gap;
  canvas.height = g.rows * cw + (g.rows + 1) * gap;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // 每码独立临时 canvas（qrcode toCanvas 只接受 canvas 元素）
  for (let p = 0; p < n; p++) {
    const row = Math.floor(p / g.cols);
    const col = p % g.cols;
    const x = gap + col * (cw + gap);
    const y = gap + row * (cw + gap);
    const tmp = document.createElement('canvas');
    tmp.width = cw;
    tmp.height = cw;
    // eslint-disable-next-line no-await-in-loop
    await QRCode.toCanvas(tmp, qrSegments(frames[p]?.bytes ?? new Uint8Array(0)) as never, {
      errorCorrectionLevel: 'L',
      margin: 2,
      width: cw,
      version: frames[p]?.version,
    });
    ctx.drawImage(tmp, x, y, cw, cw);
  }
}

function renderManifest() {
  if (!container || !fileBytes) return;
  const { fps, qrVersion, blockLen, payloadCap } = currentParams();
  const k = Math.max(1, Math.ceil(container.length / blockLen));
  const m = buildManifest({
    payloadType: fileName === '文本片段' ? 1 : 0,
    compression: containerCompressed ? 3 : 0, // 3=xz（发送端压缩标记）
    codec: 0,
    layout,
    name: fileName,
    originalSize: fileBytes.length,
    transmittedSize: container.length,
    blockLen,
    sessionId,
    qrVersion,
    fps,
    payloadFnv: fnv1a(container),
  });
  const manifestBytes = packManifest(m);
  const est = `${fmtDuration(m.estSeconds)}`;
  $('info-text').innerHTML = `K=<b>${k}</b> 块 · 预估 <b>${est}</b> @ ${fps}fps<br/>请接收端先扫码预览，对准后开始`;
  void drawQr(manifestBytes);
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtDuration(s: number): string {
  if (s < 60) return `${s} 秒`;
  return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

let paused = false;

/** 启动主流帧循环（从当前 seq 继续） */
function startStream() {
  if (streamTimer) clearInterval(streamTimer);
  paused = false;
  const { fps } = currentParams();
  streamTimer = setInterval(() => {
    if (!encoder) return;
    renderFrameAt(seq);
    seq = (seq + 1) >>> 0;
  }, 1000 / fps);
}

/** 渲染指定画面：单码画 1 帧；多码画 N 帧（seq = 画面tick × N + 位置p） */
function renderFrameAt(s: number) {
  if (!encoder || !container) return;
  const { blockLen, qrVersion } = currentParams();
  const g = LAYOUT_GRID[layout];
  const n = g.rows * g.cols;
  if (layout === 0) {
    const block = encoder.encode(s);
    const frame = packFrame(
      { sessionId, seq: s, k: encoder.k, blockLen, totalLen: container.length, payloadFnv: fnv1a(container) },
      block,
    );
    void drawQr(frame, qrVersion);
  } else {
    // 多码：画面 tick = floor(s / n)，N 帧 seq 连续
    const tick = Math.floor(s / n);
    const frames: Array<{ bytes: Uint8Array; version?: number }> = [];
    for (let p = 0; p < n; p++) {
      const frameSeq = tick * n + p;
      const block = encoder.encode(frameSeq);
      const frame = packFrame(
        { sessionId, seq: frameSeq, k: encoder.k, blockLen, totalLen: container.length, payloadFnv: fnv1a(container) },
        block,
      );
      frames.push({ bytes: frame, version: qrVersion });
    }
    void drawGrid(frames, layout);
  }
  updateSeqSlider(s);
}

/** 暂停：停住当前帧（保持显示），操作后对焦用 */
function pause() {
  if (paused) return;
  paused = true;
  if (streamTimer) clearInterval(streamTimer);
  if (resendTimer) clearInterval(resendTimer);
  $('status').textContent = '⏸ 已暂停 —— 点击二维码或按空格继续';
}

/** 暂停 ↔ 继续 */
function togglePause() {
  if (!streaming) return;
  if (paused) {
    $('status').textContent = '🚀 传输中… 保持对准';
    startStream();
  } else {
    pause();
  }
}

function start() {
  if (!container) return;
  const { fps, qrVersion, blockLen } = currentParams();
  encoder = new LTEncoder(container, blockLen, sessionId);
  streaming = true;
  paused = false;
  seq = 0;
  $('start-btn').style.display = 'none';
  $('stop-btn').style.display = 'inline-block';
  $('sender-progress-wrap').style.display = 'block';
  $('status').textContent = '🚀 传输中… 保持对准';
  setupSeqSlider(encoder.k);
  startStream();
}

/** 重发指定块：优先找该块的 degree-1 帧（必解出），找不到降级为包含帧（概率推进） */
let resendTimer: ReturnType<typeof setInterval> | null = null;

/** 帧进度：可点击/拖动跳转，播放完循环（进度从零开始） */
let totalFrames = 0;
let sliderBound = false;
function setupSeqSlider(k: number) {
  totalFrames = Math.ceil(k * 1.15);
  const slider = $('seq-slider') as HTMLInputElement;
  slider.max = String(totalFrames);
  slider.value = '0';
  updateSeqSlider(0);
  if (!sliderBound) {
    sliderBound = true;
    slider.addEventListener('input', (e) => {
      const target = Number(slider.value) >>> 0;
      // 气泡：帧号 + 百分比
      const tip = $('seq-tip') as HTMLElement;
      const pct = Math.floor((target / Math.max(1, totalFrames)) * 100);
      tip.textContent = `帧 ${target} · ${pct}%`;
      tip.style.display = 'block';
      const rect = (e.target as HTMLElement).getBoundingClientRect();
      const ratio = target / Math.max(1, totalFrames);
      tip.style.left = `${rect.left + rect.width * ratio - 30}px`;
      tip.style.top = `${rect.top - 28}px`;
      // 拖动时：跳到该帧并暂停，且立即渲染目标帧（暂停中也能看到对应帧）
      if (streaming && encoder) {
        seq = target;
        if (!paused) {
          paused = true;
          if (streamTimer) clearInterval(streamTimer);
          if (resendTimer) clearInterval(resendTimer);
        }
        renderFrameAt(seq);
        $('status').textContent = `⏭ 已显示帧 ${target} (${pct}%) —— 点击二维码或按空格继续`;
      }
    });
    slider.addEventListener('change', () => {
      $('seq-tip').style.display = 'none';
    });
  }
}

function updateSeqSlider(s: number) {
  const label = $('seq-label');
  // 循环：seq 到总帧数后归零重新走
  const cycle = s % Math.max(1, totalFrames);
  const slider = $('seq-slider') as HTMLInputElement;
  // 始终同步 slider.value（程序赋值不触发 input 事件，不影响用户拖动；
  // 之前 activeElement 检查导致拖动后 focus 残留 → label 归零但滑块不动）
  slider.value = String(cycle);
  label.textContent = `${cycle} / ~${totalFrames}`;
}

/** 块输入框：从此块开始 —— 跳到该块的帧，暂停并立即显示 */
function blockFromInput() {
  const input = $('block-input') as HTMLInputElement;
  const b = Number(input.value);
  if (!Number.isInteger(b) || !encoder || b < 0 || b >= encoder.k) {
    $('status').textContent = `⚠️ 块号无效（0-${encoder?.k ? encoder.k - 1 : '?'}）`;
    return;
  }
  let s = encoder.findDeg1Seq(b, seq, 8192);
  if (s === null) s = encoder.findAnySeq(b, seq, 65536);
  if (s === null) {
    $('status').textContent = `⚠️ 块 ${b}：65536 帧内未找到任何包含它的帧`;
    return;
  }
  // 跳到该块的帧，暂停并立即渲染（暂停中就能看到目标帧，对焦后继续）
  seq = s;
  if (!paused) {
    paused = true;
    if (streamTimer) clearInterval(streamTimer);
    if (resendTimer) clearInterval(resendTimer);
  }
  renderFrameAt(seq);
  $('status').textContent = `⏭ 已显示块 #${b} 的帧 ${s} —— 点击二维码或按空格继续`;
}

function stop() {
  streaming = false;
  if (streamTimer) clearInterval(streamTimer);
  if (resendTimer) clearInterval(resendTimer);
  $('start-btn').style.display = 'inline-block';
  $('stop-btn').style.display = 'none';
  $('status').textContent = '已停止 —— 可调整参数重新开始';
  renderManifest();
}

$('start-btn').addEventListener('click', start);
$('stop-btn').addEventListener('click', stop);
$('block-start').addEventListener('click', blockFromInput);
$('block-input').addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter') blockFromInput();
  e.stopPropagation();
});

// 参数变化时重新渲染 manifest
for (const id of ['fps', 'qr-size']) {
  $(id).addEventListener('input', () => {
    $('fps-label').textContent = ($('fps') as HTMLInputElement).value;
    if (container && !streaming) renderManifest();
  });
}

// 多码布局变化：更新状态 + 重渲染 manifest（未开始传输时）
$('qr-layout').addEventListener('change', (e) => {
  layout = Number((e.target as HTMLSelectElement).value) as Layout;
  // 重设 canvas 为单码尺寸（renderManifest 会重画 manifest 单码）
  canvas.width = 400;
  canvas.height = 400;
  // fps 标签同步多码限速
  $('fps-label').textContent = currentParams().fps.toString();
  if (container && !streaming) renderManifest();
});

// 点击二维码 = 暂停/继续（留对焦时间）
canvas.addEventListener('click', () => {
  togglePause();
});

// 空格 = 暂停/继续（输入框内不触发）
window.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.code === 'Space') {
    const t = e.target as HTMLElement;
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return;
    e.preventDefault();
    togglePause();
  }
});
