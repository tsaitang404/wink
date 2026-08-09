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
  initSenderBlocks(encoder.k);
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

/** 发送端块网格：红块=degree-1 未发出（可能未收到），点击重发该块 */
function initSenderBlocks(k: number) {
  const grid = $('sender-blocks');
  grid.innerHTML = '';
  $('block-count').textContent = `K=${k} 块`;
  for (let i = 0; i < k; i++) {
    const d = document.createElement('div');
    d.className = 'blk snd';
    d.dataset.idx = String(i);
    d.style.cssText = 'width:8px;height:8px;border-radius:2px;background:#3a3a3a;cursor:pointer';
    d.title = `块 ${i}`;
    d.addEventListener('click', () => resendBlock(i));
    grid.appendChild(d);
  }
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

/** 进度条：seq 位置显示 + 拖动跳转 */
function setupSeqSlider(k: number) {
  const slider = $('seq-slider') as HTMLInputElement;
  const max = Math.max(1000, Math.ceil(k * 1.3));
  slider.max = String(max);
  slider.value = '0';
  $('seq-label').textContent = '0';
  slider.addEventListener('input', () => {
    const target = Number(slider.value) >>> 0;
    $('seq-label').textContent = String(target);
    // 拖动时若在传输中，跳转到该位置继续（重新渲染下一帧）
    if (streaming && encoder) {
      seq = target;
      $('status').textContent = `⏭ 跳到帧 ${target} 继续`;
    }
  });
}

function updateSeqSlider(s: number) {
  const slider = $('seq-slider') as HTMLInputElement;
  if (!slider || Number(slider.value) > s) return; // 用户拖动中不覆盖
  slider.value = String(s);
  $('seq-label').textContent = String(s);
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
