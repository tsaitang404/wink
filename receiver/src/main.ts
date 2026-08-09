// wink 接收端主逻辑：摄像头 → zxing 解码 → 帧识别 → 喷泉解码 → 呈现
import { readBarcodesFromImageData } from 'zxing-wasm/full';
import { LTDecoder } from '../../shared/fountain.ts';
import {
  FRAME_MAGIC,
  HEADER_LEN,
  FILE_MAGIC,
  TEXT_MAGIC,
  MANIFEST_MAGIC,
  parseFrame,
  streamIdentity,
  safeFileName,
} from '../../shared/protocol.ts';
import { unpackFile, unpackSnippet, verifyFile } from '../../shared/container.ts';
import { parseManifest } from '../../shared/manifest.ts';

const $ = (id: string) => document.getElementById(id)!;

let video: HTMLVideoElement = document.createElement('video');
let stream: MediaStream | null = null;
let decoding = false;
let manifest: ReturnType<typeof parseManifest> | null = null;
let decoder: LTDecoder | null = null;
let currentIdentity = '';
let framesNeeded = 0;
let framesGot = 0;
let startTime = 0;

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function setStatus(msg: string) {
  $('status').textContent = msg;
}

async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 } },
      audio: false,
    });
    video = $('cam') as HTMLVideoElement;
    video.srcObject = stream;
    await video.play();
    setStatus('等待旗语… 对准发送端的二维码');
    $('start-btn').textContent = '📷 摄像头已启动';
    decoding = true;
    requestAnimationFrame(decodeLoop);
  } catch (e) {
    setStatus(`❌ 摄像头失败: ${(e as Error).message}`);
  }
}

async function decodeLoop() {
  if (!decoding || video.readyState < 2) {
    requestAnimationFrame(decodeLoop);
    return;
  }
  try {
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(video, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const results = await readBarcodesFromImageData(imageData, {
      formats: ['QRCode'],
      tryHarder: true,
    });
    for (const r of results) {
      if (r.bytes.length > 0) handleBytes(r.bytes);
    }
  } catch {
    // 解码失败/无码，忽略
  }
  requestAnimationFrame(decodeLoop);
}

function handleBytes(bytes: Uint8Array) {
  // 1. 元信息帧
  if (bytes.length >= 4 && bytes[0] === MANIFEST_MAGIC[0] && bytes[1] === MANIFEST_MAGIC[1]) {
    const m = parseManifest(bytes);
    if (m) {
      manifest = m;
      currentIdentity = '';
      showManifest(m);
      // 预建解码器（帧流开始后直接喂）
      if (m.payloadType === 0) {
        decoder = new LTDecoder(m.k, m.blockLen, m.sessionId, m.transmittedSize);
        framesNeeded = Math.ceil(m.k * 1.15);
        framesGot = 0;
      }
      setStatus('已收到传输预览，等待帧流…');
    }
    return;
  }
  // 2. 帧流帧
  if (bytes.length > HEADER_LEN && bytes[0] === FRAME_MAGIC) {
    const parsed = parseFrame(bytes);
    if (!parsed) return;
    const { header, block } = parsed;
    const identity = streamIdentity(header);
    if (identity !== currentIdentity) {
      // 新流：重置解码器
      currentIdentity = identity;
      decoder = new LTDecoder(header.k, header.blockLen, header.sessionId, header.totalLen);
      framesNeeded = Math.ceil(header.k * 1.15);
      framesGot = 0;
      startTime = performance.now();
      showStreamHeader(header);
    }
    if (decoder) {
      decoder.addFrame(header.seq, block);
      framesGot = decoder.framesNew;
      updateProgress(decoder, framesGot);
      if (decoder.isComplete) {
        const container = decoder.assemble();
        if (container) onComplete(container);
      }
    }
    return;
  }
  // 3. 文件/文本容器（异常直达：无 manifest 场景）
  if (bytes.length >= 4 && bytes[0] === FILE_MAGIC[0] && bytes[1] === FILE_MAGIC[1]) {
    onComplete(bytes);
    return;
  }
  if (bytes.length >= 4 && bytes[0] === TEXT_MAGIC[0] && bytes[1] === TEXT_MAGIC[1]) {
    onTextComplete(bytes);
  }
}

function showManifest(m: NonNullable<ReturnType<typeof parseManifest>>) {
  const card = $('manifest-card');
  card.style.display = 'block';
  $('mf-name').textContent = m.name;
  $('mf-size').textContent = fmtSize(m.originalSize);
  $('mf-k').textContent = String(m.k);
  $('mf-fps').textContent = `${m.fps} fps`;
  $('mf-est').textContent = fmtDuration(m.estSeconds);
}

function fmtDuration(s: number): string {
  if (s < 60) return `${s} 秒`;
  return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

function showStreamHeader(h: ReturnType<typeof parseFrame> extends null ? never : Parameters<typeof streamIdentity>[0]) {
  $('progress-wrap').style.display = 'block';
  $('progress-stats').textContent = `接收中… 帧 ${framesGot}/${framesNeeded}`;
  // 块网格
  const grid = $('block-grid');
  grid.innerHTML = '';
  const cellCount = Math.min(h.k, 400);
  for (let i = 0; i < cellCount; i++) {
    const d = document.createElement('div');
    d.className = 'blk';
    d.dataset.idx = String(i);
    grid.appendChild(d);
  }
}

function updateProgress(dec: LTDecoder, got: number) {
  const pct = Math.min(100, (got / framesNeeded) * 100);
  $('progress-fill').style.width = `${pct}%`;
  const elapsed = ((performance.now() - startTime) / 1000).toFixed(0);
  const dupRate = got > 0 ? ((dec.framesDup / (dec.framesNew + dec.framesDup)) * 100).toFixed(0) : '0';
  $('progress-stats').textContent = `帧 ${got}/${framesNeeded} · 已解块 ${dec.solvedCount}/${dec.k} · ${elapsed}s · 重复 ${dupRate}%`;
  // 更新块网格（聚合显示 solved 比例）
  const grid = $('block-grid');
  const cells = grid.children;
  if (cells.length > 0) {
    const ratio = dec.solvedCount / dec.k;
    const filled = Math.floor(ratio * cells.length);
    for (let i = 0; i < cells.length; i++) {
      cells[i]!.className = i < filled ? 'blk solved' : 'blk';
    }
  }
}

async function onComplete(container: Uint8Array) {
  decoding = false;
  try {
    const file = await unpackFile(container);
    const ok = await verifyFile(file);
    if (!ok) {
      setStatus('❌ SHA-256 校验失败，文件损坏！');
      return;
    }
    showResult(file.name, file.type, file.bytes);
  } catch (e) {
    setStatus(`❌ 解析失败: ${(e as Error).message}`);
  }
}

function onTextComplete(container: Uint8Array) {
  decoding = false;
  try {
    const text = unpackSnippet(container);
    showResult('文本片段', 'text/plain', new TextEncoder().encode(text));
  } catch (e) {
    setStatus(`❌ 文本解析失败: ${(e as Error).message}`);
  }
}

function showResult(name: string, type: string, bytes: Uint8Array) {
  $('result').style.display = 'block';
  $('file-meta').textContent = `${safeFileName(name)} · ${fmtSize(bytes.length)} · ${type}`;
  const textPreview = $('text-preview') as HTMLElement;
  const img = $('media-preview') as HTMLImageElement;
  const vid = $('media-video') as HTMLVideoElement;
  const copyBtn = $('copy-btn') as HTMLButtonElement;
  textPreview.style.display = 'none';
  img.style.display = 'none';
  vid.style.display = 'none';
  copyBtn.style.display = 'none';

  const mime = type.split(';')[0]!.toLowerCase();
  const blob = new Blob([bytes as BlobPart], { type });
  const url = URL.createObjectURL(blob);

  if (mime.startsWith('text/') || mime.includes('javascript') || mime === 'application/json') {
    if (bytes.length < 64 * 1024) {
      textPreview.textContent = new TextDecoder().decode(bytes);
      textPreview.style.display = 'block';
      copyBtn.style.display = 'inline-block';
      copyBtn.onclick = () => navigator.clipboard.writeText(textPreview.textContent!);
    }
  } else if (mime.startsWith('image/')) {
    img.src = url;
    img.style.display = 'block';
  } else if (mime.startsWith('video/')) {
    vid.src = url;
    vid.style.display = 'block';
  } else if (mime.startsWith('audio/')) {
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.src = url;
    audio.style.cssText = 'width:100%;margin-bottom:10px';
    $('result').insertBefore(audio, $('file-meta'));
  }

  const saveBtn = $('save-btn') as HTMLButtonElement;
  saveBtn.onclick = () => {
    const a = document.createElement('a');
    a.href = url;
    a.download = safeFileName(name);
    a.click();
  };
  setStatus('✅ 接收完成');
}

$('start-btn').addEventListener('click', startCamera);
