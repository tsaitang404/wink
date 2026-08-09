// wink 发送端（单 HTML）：选文件 → 元信息 QR → 参数可调 → 帧流
import * as QRCode from 'qrcode';
import { LTEncoder } from '../../shared/fountain.ts';
import { packFrame, fnv1a, HEADER_LEN } from '../../shared/protocol.ts';
import { packFile, packSnippet } from '../../shared/container.ts';
import { buildManifest, packManifest } from '../../shared/manifest.ts';

const $ = (id: string) => document.getElementById(id)!;
const canvas = $('qr') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

// QR 版本 → payload 容量（byte mode, ECC L）
const QR_CAPACITY: Record<number, number> = {
  15: 539,
  20: 858,
  27: 1465,
  40: 2953,
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
  // 块长自动优化：取帧载荷的 1/8（保证每帧能 XOR 多个块，喷泉效率高）
  // 上限 512 避免块数太少；下限 64 避免块数爆炸
  const blockLen = Math.min(512, Math.max(64, Math.floor(payloadCap / 8)));
  return { fps, qrVersion, blockLen, payloadCap };
}

// qrcode 库需要 byte mode segment 才能编码二进制（默认按 UTF-8 会损坏）
function qrSegments(bytes: Uint8Array): Array<{ data: Uint8Array; mode: 'byte' }> {
  return [{ data: bytes, mode: 'byte' }];
}

async function drawQr(bytes: Uint8Array) {
  await QRCode.toCanvas(canvas, qrSegments(bytes) as never, {
    errorCorrectionLevel: 'L',
    margin: 2,
    width: 400,
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

function start() {
  if (!container) return;
  const { fps, qrVersion, blockLen } = currentParams();
  encoder = new LTEncoder(container, blockLen, sessionId);
  streaming = true;
  seq = 0;
  $('start-btn').style.display = 'none';
  $('stop-btn').style.display = 'inline-block';
  $('sender-progress-wrap').style.display = 'block';
  $('status').textContent = '🚀 传输中… 保持对准';
  setupSeqSlider(encoder.k);
  streamTimer = setInterval(() => {
    if (!encoder) return;
    const block = encoder.encode(seq);
    const frame = packFrame(
      { sessionId, seq, k: encoder.k, blockLen, totalLen: container!.length, payloadFnv: fnv1a(container!) },
      block,
    );
    void drawQr(frame);
    updateSeqSlider(seq);
    seq = (seq + 1) >>> 0;
  }, 1000 / fps);
}

/** 重发指定块：扫描找到该块的 degree-1 帧 seq，临时连续发送 10 帧 */
let resendTimer: ReturnType<typeof setInterval> | null = null;
function resendBlock(b: number) {
  if (!encoder || !container) return;
  const s = encoder.findDeg1Seq(b, seq);
  if (s === null) {
    $('status').textContent = `⚠️ 块 ${b}：8192 帧内未找到 degree-1 帧`;
    return;
  }
  // 中断当前流 10 帧，发送该块重试
  if (streamTimer) clearInterval(streamTimer);
  if (resendTimer) clearInterval(resendTimer);
  const { fps } = currentParams();
  let n = 0;
  resendTimer = setInterval(() => {
    const block = encoder!.encode(s);
    const frame = packFrame(
      { sessionId, seq: s, k: encoder!.k, blockLen: currentParams().blockLen, totalLen: container!.length, payloadFnv: fnv1a(container!) },
      block,
    );
    void drawQr(frame);
    $('status').textContent = `🔁 重发块 #${b}（帧 ${s}）… ${n + 1}/10`;
    n++;
    if (n >= 10) {
      if (resendTimer) clearInterval(resendTimer);
      // 恢复主流
      if (streamTimer) clearInterval(streamTimer);
      streamTimer = setInterval(() => {
        if (!encoder) return;
        const block2 = encoder.encode(seq);
        const frame2 = packFrame(
          { sessionId, seq, k: encoder.k, blockLen: currentParams().blockLen, totalLen: container!.length, payloadFnv: fnv1a(container!) },
          block2,
        );
        void drawQr(frame2);
        updateSeqSlider(seq);
        seq = (seq + 1) >>> 0;
      }, 1000 / fps);
      $('status').textContent = '🚀 传输中… 保持对准';
    }
  }, 1000 / fps);
}

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
      // 拖动时若在传输中，跳到该帧继续
      if (streaming && encoder) {
        seq = target;
        $('status').textContent = `⏭ 跳到帧 ${target} (${pct}%) 继续`;
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
  const pct = (cycle / Math.max(1, totalFrames)) * 100;
  const slider = $('seq-slider') as HTMLInputElement;
  if (document.activeElement !== slider) slider.value = String(cycle);
  label.textContent = `${cycle} / ~${totalFrames}`;
}

/** 块输入框：从此块开始 / 重播此块 */
function blockFromInput(mode: 'start' | 'resend') {
  const input = $('block-input') as HTMLInputElement;
  const b = Number(input.value);
  if (!Number.isInteger(b) || !encoder || b < 0 || b >= encoder.k) {
    $('status').textContent = `⚠️ 块号无效（0-${encoder?.k ? encoder.k - 1 : '?'}）`;
    return;
  }
  const s = encoder.findDeg1Seq(b, seq, 8192);
  if (s === null) {
    $('status').textContent = `⚠️ 块 ${b}：8192 帧内未找到 degree-1 帧`;
    return;
  }
  if (mode === 'start') {
    // 从此块开始：跳到该块的 degree-1 帧继续主流
    seq = s;
    $('status').textContent = `⏭ 从块 #${b} 开始（帧 ${s}）继续`;
  } else {
    resendBlock(b);
  }
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
$('block-start').addEventListener('click', () => blockFromInput('start'));
$('block-resend').addEventListener('click', () => blockFromInput('resend'));
$('block-input').addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter') blockFromInput('resend');
});

// 参数变化时重新渲染 manifest
for (const id of ['fps', 'qr-size']) {
  $(id).addEventListener('input', () => {
    $('fps-label').textContent = ($('fps') as HTMLInputElement).value;
    if (container && !streaming) renderManifest();
  });
}

canvas.addEventListener('click', () => {
  canvas.requestFullscreen?.().catch(() => {});
});
