// wink 发送端（单 HTML）：选文件 → 接收端地址 QR → 参数可调 → 帧流
import * as QRCode from 'qrcode';
import { LTEncoder } from '../../shared/fountain.ts';
import { packFrame, fnv1a, HEADER_LEN } from '../../shared/protocol.ts';
import { packFile, packSnippet } from '../../shared/container.ts';
import { buildManifest, packManifest } from '../../shared/manifest.ts';

const $ = (id: string) => document.getElementById(id)!;
const canvas = $('qr') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

// 接收端地址（固定 Pages 地址）
const RECEIVER_URL = 'https://tsaitang404.github.io/wink/';

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
let containerGzip = false;
let sessionId = 0;
let encoder: LTEncoder | null = null;
let streaming = false;
let streamTimer: ReturnType<typeof setInterval> | null = null;
let seq = 0;
let snippetText = '';

// ── 文件选择 ──

function pickFile() {
  const input = $('file-input') as HTMLInputElement;
  input.value = '';
  input.click();
}

$('pick-btn').addEventListener('click', pickFile);
$('file-input').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  await loadPayload(file.name, file.type || 'application/octet-stream', bytes);
});

// ── 粘贴文本 ──

$('paste-btn').addEventListener('click', async () => {
  const text = prompt('粘贴要发送的文本（≤ 4MB）：');
  if (text == null) return;
  snippetText = text;
  const bytes = new TextEncoder().encode(text);
  const snip = packSnippet(text);
  await loadPayload('文本片段', 'text/plain', snip, bytes.length);
});

// ── 拖拽文件 (#7) ──

document.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.stopPropagation();
  $('status').textContent = '📥 松手释放文件';
});

document.addEventListener('drop', async (e) => {
  e.preventDefault();
  e.stopPropagation();
  const file = e.dataTransfer?.files[0];
  if (!file) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  await loadPayload(file.name, file.type || 'application/octet-stream', bytes);
});

// ── 剪贴板粘贴文件 (#7) ──

document.addEventListener('paste', async (e) => {
  // 如果焦点在输入框内，不处理（让浏览器正常粘贴）
  const t = e.target as HTMLElement;
  if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return;

  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.kind === 'file') {
      const file = item.getAsFile();
      if (file) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        await loadPayload(file.name, file.type || 'application/octet-stream', bytes);
        return;
      }
    }
  }
  // 如果剪贴板没有文件，检查是否有文本
  const text = e.clipboardData?.getData('text');
  if (text && text.length > 0 && text.length <= 4 * 1024 * 1024) {
    snippetText = text;
    const bytes = new TextEncoder().encode(text);
    const snip = packSnippet(text);
    await loadPayload('文本片段', 'text/plain', snip, bytes.length);
  }
});

// ── 加载载荷 ──

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
  $('status').textContent = '已选择，生成接收端地址二维码…';

  // 打包容器（文件场景：传原始字节；文本场景：bytes 已是 WNKT 容器）
  if (name !== '文本片段') {
    const packed = await packFile(name, type, bytes);
    container = packed.container;
    containerGzip = packed.compression === 'gzip';
  } else {
    container = bytes;
  }

  showReceiverQr();
  $('status').textContent = '已就绪 —— 手机扫码打开接收端，对准后点开始';
  $('start-btn').style.display = 'inline-block';
}

// ── 参数 ──

function currentParams() {
  const fps = Number(($('fps') as HTMLInputElement).value);
  const qrVersion = Number(($('qr-size') as HTMLSelectElement).value);
  const payloadCap = QR_CAPACITY[qrVersion]! - HEADER_LEN;
  const blockLen = Math.max(64, payloadCap);
  return { fps, qrVersion, blockLen, payloadCap };
}

// ── QR 渲染 ──

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

/** 显示接收端地址二维码 (#2) */
function showReceiverQr() {
  const urlBytes = new TextEncoder().encode(RECEIVER_URL);
  void drawQr(urlBytes);
  $('info-text').innerHTML = `手机扫码打开接收端<br/>对准后点 <b>▶ 开始传输</b>`;
}

/** 显示元信息二维码（传输预览） */
function renderManifest() {
  if (!container || !fileBytes) return;
  const { fps, qrVersion, blockLen } = currentParams();
  const k = Math.max(1, Math.ceil(container.length / blockLen));
  const m = buildManifest({
    payloadType: fileName === '文本片段' ? 1 : 0,
    compression: containerGzip ? 1 : 0,
    codec: 0,
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
  if (s < 60) return `${Math.round(s)} 秒`;
  return `${Math.floor(s / 60)} 分 ${Math.round(s % 60)} 秒`;
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

/** 渲染指定 seq 的帧到二维码 + 更新进度条 */
function renderFrameAt(s: number) {
  if (!encoder || !container) return;
  const block = encoder.encode(s);
  const frame = packFrame(
    { sessionId, seq: s, k: encoder.k, blockLen: currentParams().blockLen, totalLen: container.length, payloadFnv: fnv1a(container) },
    block,
  );
  void drawQr(frame, currentParams().qrVersion);
  updateSeqSlider(s);
}

/** 暂停 */
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

/** 重发指定块 */
let resendTimer: ReturnType<typeof setInterval> | null = null;

/** 帧进度：可点击/拖动跳转 */
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
      const tip = $('seq-tip') as HTMLElement;
      const pct = Math.floor((target / Math.max(1, totalFrames)) * 100);
      tip.textContent = `帧 ${target} · ${pct}%`;
      tip.style.display = 'block';
      const rect = (e.target as HTMLElement).getBoundingClientRect();
      const ratio = target / Math.max(1, totalFrames);
      tip.style.left = `${rect.left + rect.width * ratio - 30}px`;
      tip.style.top = `${rect.top - 28}px`;
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
  const cycle = s % Math.max(1, totalFrames);
  const slider = $('seq-slider') as HTMLInputElement;
  slider.value = String(cycle);
  label.textContent = `${cycle} / ~${totalFrames}`;
}

/** 块输入框：从此块开始 */
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
  showReceiverQr();
}

$('start-btn').addEventListener('click', start);
$('stop-btn').addEventListener('click', stop);
$('block-start').addEventListener('click', blockFromInput);
$('block-input').addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter') blockFromInput();
  e.stopPropagation();
});

// 参数变化时重新渲染
for (const id of ['fps', 'qr-size']) {
  $(id).addEventListener('input', () => {
    $('fps-label').textContent = ($('fps') as HTMLInputElement).value;
    if (container && !streaming) showReceiverQr();
  });
}

// 点击二维码 = 暂停/继续
canvas.addEventListener('click', () => {
  togglePause();
});

// 空格 = 暂停/继续
window.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.code === 'Space') {
    const t = e.target as HTMLElement;
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return;
    e.preventDefault();
    togglePause();
  }
});
