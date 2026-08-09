// wink 发送端（单 HTML）：选文件 → 元信息 QR → 参数可调 → 帧流
import * as QRCode from 'qrcode';
import { LTEncoder } from '../../shared/fountain.ts';
import { packFrame, fnv1a, HEADER_LEN } from '../../shared/protocol.ts';
import { packFile, packSnippet } from '../../shared/container.ts';
import { buildManifest, packManifest } from '../../shared/manifest.ts';

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
let sessionId = 0;
let encoder: LTEncoder | null = null;
let streaming = false;
let streamTimer: ReturnType<typeof setInterval> | null = null;
let seq = 0;
let snippetText = '';

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
    } else {
      container = bytes;
    }
  }

  renderManifest();
  $('status').textContent = '已就绪 —— 接收端扫码后点开始';
  $('start-btn').style.display = 'inline-block';
}

function currentParams() {
  const fps = Number(($('fps') as HTMLInputElement).value);
  const qrVersion = Number(($('qr-size') as HTMLSelectElement).value);
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

function renderManifest() {
  if (!container) return;
  const { fps, qrVersion, blockLen, payloadCap } = currentParams();
  const k = Math.max(1, Math.ceil(container.length / blockLen));
  const m = buildManifest({
    payloadType: fileName === '文本片段' ? 1 : 0,
    compression: 0,
    codec: 0,
    name: fileName,
    originalSize: container.length,
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

/** 渲染指定 seq 的帧到二维码 + 更新进度条（暂停时跳帧用，立即显示目标帧） */
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
