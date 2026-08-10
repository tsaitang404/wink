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
import { parseManifest, LAYOUT_GRID } from '../../shared/manifest.ts';

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
let miniMode = false;
const receivedFiles: Array<{ name: string; type: string; bytes: Uint8Array; time: number }> = [];

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
    if (!stream) {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 } },
        audio: false,
      });
      video = $('cam') as HTMLVideoElement;
      video.srcObject = stream;
    }
    // 强制重新激活画面（隐藏后 play 可能暂停）
    video.srcObject = stream;
    await video.play();
    // 彻底重置接收状态（新会话）
    decoding = false;
    decoder = null;
    manifest = null;
    currentIdentity = '';
    framesNeeded = 0;
    framesGot = 0;
    // 状态机：从隐藏/完成态恢复 → 原样显示
    leaveHiddenMode();
    $('manifest-card').style.display = 'none';
    $('progress-wrap').style.display = 'none';
    $('result').style.display = 'none';
    $('start-btn').style.display = 'none';
    setStatus('等待 wink… 对准发送端的二维码');
    decoding = true;
    requestAnimationFrame(decodeLoop);
  } catch (e) {
    setStatus(`❌ 摄像头失败: ${(e as Error).message}`);
  }
}

function enterHiddenMode() {
  miniMode = true;
  $('video-wrap').classList.add('hidden');
  $('start-btn').style.display = 'inline-block';
  $('start-btn').textContent = '▶ 继续接收';
  setStatus('✅ 接收完成 —— 点击继续接收');
}

function leaveHiddenMode() {
  miniMode = false;
  $('video-wrap').classList.remove('hidden');
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
    // 临时调试：显示每帧识别码数（多码诊断）
    const dbg = document.getElementById('debug-multi');
    if (dbg) {
      const kinds = results.map((r) => {
        const b = r.bytes;
        if (b.length >= 4 && b[0] === MANIFEST_MAGIC[0] && b[1] === MANIFEST_MAGIC[1]) return 'M';
        if (b.length > HEADER_LEN && b[0] === FRAME_MAGIC) return 'F';
        return '?';
      });
      dbg.textContent = `每帧识别 ${results.length} 码 [${kinds.join('')}]` + (manifest ? ` · layout=${manifest.layout}` : '');
    }
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
  const g = LAYOUT_GRID[m.layout];
  $('mf-layout').textContent =
    m.layout === 0 ? '单码' : `${g.rows}×${g.cols}（${g.rows * g.cols} 码）`;
  $('mf-est').textContent = fmtDuration(m.estSeconds);
}

function fmtDuration(s: number): string {
  const sec = Math.max(0, Math.round(s));
  if (sec < 60) return `${sec} 秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`;
  return `${Math.floor(sec / 3600)} 时 ${Math.floor((sec % 3600) / 60)} 分`;
}

// 速率格式化：B/s → KB/s → MB/s
function fmtRate(bps: number): string {
  if (bps >= 1024 * 1024) return `${(bps / 1024 / 1024).toFixed(1)} MB/s`;
  if (bps >= 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${Math.round(bps)} B/s`;
}

// 剩余时间（别名 fmtDuration，秒输入）
function fmtDur(s: number): string {
  return fmtDuration(s);
}

function showStreamHeader(h: ReturnType<typeof parseFrame> extends null ? never : Parameters<typeof streamIdentity>[0]) {
  $('progress-wrap').style.display = 'block';
  $('progress-stats').textContent = `接收中… 帧 ${framesGot}/${framesNeeded}`;
  // 帧时间线：按 seq 顺序，已收绿
  renderFrameTimeline();
  // 块网格：真实 K 块，三色状态，点击气泡
  const grid = $('block-grid');
  grid.innerHTML = '';
  const tip = $('blk-tip') as HTMLElement;
  for (let i = 0; i < h.k; i++) {
    const d = document.createElement('div');
    d.className = 'blk';
    d.dataset.idx = String(i);
    d.addEventListener('click', (e) => {
      tip.textContent = `块 #${i}${stateLabel(d.className)}`;
      tip.style.display = 'block';
      tip.style.left = `${e.clientX + 8}px`;
      tip.style.top = `${e.clientY - 30}px`;
    });
    grid.appendChild(d);
  }
  // 点击其他区域隐藏气泡
  grid.addEventListener('mouseleave', () => {
    tip.style.display = 'none';
  });
}

function stateLabel(cls: string): string {
  if (cls.includes('solved')) return ' · 已解出 ✅';
  if (cls.includes('pending')) return ' · 收到未解出 ⏳';
  return ' · 未收到';
}

function renderFrameTimeline() {
  if (!decoder) return;
  const seqs = decoder.receivedSeqs();
  const timeline = $('frame-timeline');
  timeline.innerHTML = '';
  const total = Math.max(1, framesNeeded);
  // 没收到帧：空位图
  if (seqs.size === 0) {
    const pctSpan = document.createElement('span');
    pctSpan.className = 'ft-pct';
    pctSpan.textContent = '0%';
    timeline.appendChild(pctSpan);
    return;
  }
  // 窗口起点 = 收到的第一个帧 seq（喷泉码不需要固定起点，
  // 接收端中途对准时前面帧已丢失，固定 0..N 会让位图一直灰）
  let first = Infinity;
  for (const s of seqs) {
    if (s < first) first = s;
  }
  const CELLS = 120;
  // 总帧数少（≤120）不压缩：每帧一格，收到=绿 没收到=灰
  if (total <= CELLS) {
    for (let i = 0; i < total; i++) {
      const s = first + i;
      const div = document.createElement('div');
      div.className = 'ft' + (seqs.has(s) ? ' got' : '');
      const pct = Math.floor((i / total) * 100);
      div.title = `帧 ${s} · ${pct}%`;
      div.addEventListener('click', (e) => {
        const tip = $('blk-tip') as HTMLElement;
        tip.textContent = `帧 ${s} · ${pct}%`;
        tip.style.display = 'block';
        tip.style.left = `${e.clientX + 8}px`;
        tip.style.top = `${e.clientY - 30}px`;
      });
      timeline.appendChild(div);
    }
  } else {
    // 总帧多才聚合：每格覆盖 total/CELLS 帧
    const bucket = total / CELLS;
    for (let c = 0; c < CELLS; c++) {
      const from = Math.floor(c * bucket);
      const to = Math.min(total, Math.floor((c + 1) * bucket));
      const count = to - from;
      let gotCount = 0;
      for (let i = from; i < to; i++) {
        if (seqs.has(first + i)) gotCount++;
      }
      // 三态：全收=绿 部分=橙 无=灰
      const cls = gotCount === 0 ? 'ft' : gotCount >= count ? 'ft got' : 'ft partial';
      const div = document.createElement('div');
      div.className = cls;
      const pctLow = Math.floor((from / total) * 100);
      const pctHigh = Math.ceil((to / total) * 100);
      const absFrom = first + from;
      const absTo = first + to;
      div.title = `帧 ${absFrom}-${absTo} · ${pctLow}-${pctHigh}% · 收到 ${gotCount}/${count}`;
      div.addEventListener('click', (e) => {
        const tip = $('blk-tip') as HTMLElement;
        tip.textContent = `帧 ${absFrom}-${absTo} · ${pctLow}-${pctHigh}% · 收到 ${gotCount}/${count}`;
        tip.style.display = 'block';
        tip.style.left = `${e.clientX + 8}px`;
        tip.style.top = `${e.clientY - 30}px`;
      });
      timeline.appendChild(div);
    }
  }
  // 右侧总百分比标签：窗口 first..first+total 内的有效帧
  let inRange = 0;
  for (let i = 0; i < total; i++) {
    if (seqs.has(first + i)) inRange++;
  }
  const pctTotal = Math.min(100, Math.floor((inRange / total) * 100));
  const pctSpan = document.createElement('span');
  pctSpan.className = 'ft-pct';
  pctSpan.textContent = `${pctTotal}%`;
  timeline.appendChild(pctSpan);
}

function updateProgress(dec: LTDecoder, got: number) {
  // 主进度 = 块进度（真实、确定）：已解块/总块数
  const pct = Math.min(100, (dec.solvedCount / Math.max(1, dec.k)) * 100);
  $('progress-fill').style.width = `${pct}%`;
  const elapsed = ((performance.now() - startTime) / 1000).toFixed(0);
  // 有效帧 = 新帧（去重后）；无效帧 = 重复帧（总收 = 有效+无效，无需单列）
  const valid = dec.framesNew;
  const invalid = dec.framesDup;
  // 平均速率：有效帧 × 块长 / 耗时（块 = 每帧有效 payload；manifest 有 blockLen 才显示）
  let rateTxt = '';
  const blockLen = manifest?.blockLen ?? 0;
  const elSec = (performance.now() - startTime) / 1000;
  if (blockLen > 0 && elSec > 1 && valid > 0) {
    const bytesPerSec = (valid * blockLen) / elSec;
    const totalBytes = manifest?.transmittedSize ?? 0;
    const doneBytes = valid * blockLen;
    let remain = '';
    if (totalBytes > doneBytes && bytesPerSec > 0) {
      const remSec = (totalBytes - doneBytes) / bytesPerSec;
      remain = ` · 剩余 ${fmtDur(remSec)}`;
    }
    rateTxt = ` · ${fmtRate(bytesPerSec)}${remain}`;
  }
  $('progress-stats').textContent =
    `块 ${dec.solvedCount}/${dec.k} (${pct.toFixed(0)}%) · 帧 ${valid}/期望~${framesNeeded} · 无效 ${invalid} · ${elapsed}s${rateTxt}`;
  // 码率检测：总平均速度
  updateFpsHint(dec);
  // 帧时间线（丢帧诊断，非进度）
  renderFrameTimeline();
  // 块网格：真实 K 块逐块三色（灰=未收 橙=收到未解出 绿=已解出）
  const grid = $('block-grid');
  const cells = grid.children;
  for (let i = 0; i < cells.length; i++) {
    const st = dec.blockState(i);
    cells[i]!.className = st === 2 ? 'blk solved' : st === 1 ? 'blk pending' : 'blk';
  }
}

// 码率检测：总平均速度 = 有效新帧数 / 总耗时（实时速度波动大，用平均更稳）
function updateFpsHint(dec: LTDecoder) {
  const hint = $('fps-hint');
  const elapsed = (performance.now() - startTime) / 1000;
  if (dec.framesNew < 5 || elapsed < 1) {
    hint.style.display = 'none';
    return;
  }
  const avgFps = dec.framesNew / elapsed;
  const sendFps = manifest?.fps ?? 0;
  if (sendFps > 0 && avgFps < sendFps * 0.7) {
    const recommended = Math.max(1, Math.floor(avgFps * 0.8));
    hint.textContent = `⚠️ 平均解码 ${avgFps.toFixed(1)} fps < 发送 ${sendFps} fps —— 建议发送端降到 ${recommended} fps`;
    hint.style.display = 'block';
  } else if (sendFps > 0) {
    hint.textContent = `平均解码 ${avgFps.toFixed(1)} fps · 发送 ${sendFps} fps · 匹配 ✓`;
    hint.style.display = 'block';
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
    // 完成标准 = 块全部解出（进度条基于块，此时必为 100%）
    $('progress-fill').style.width = '100%';
    const valid = decoder?.framesNew ?? 0;
    $('progress-stats').textContent =
      `✅ 完成 · 块 ${decoder?.solvedCount ?? 0}/${decoder?.k ?? 0} (100%) · 帧 ${valid}/期望~${framesNeeded} · 无效 ${decoder?.framesDup ?? 0}`;
    // 块网格已全绿（真实解出状态）；帧位图如实保留（诊断用）
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

  // 加入文件历史列表
  receivedFiles.push({ name, type, bytes, time: Date.now() });
  addFileToList({ name, type, bytes, time: Date.now() });

  // 接收完成 → 镜头缩小成迷你窗，按钮可点击恢复
  $('result').style.display = 'block';
  enterHiddenMode();
  setStatus('✅ 接收完成 —— 点击下方文件保存，或点镜头继续接收');
}

function addFileToList(f: { name: string; type: string; bytes: Uint8Array; time: number }) {
  const list = $('file-list');
  $('file-list-wrap').style.display = 'block';
  const item = document.createElement('div');
  item.className = 'file-item';
  const safe = safeFileName(f.name);
  const mime = f.type.split(';')[0]!.toLowerCase();
  const icon = mime.startsWith('image/') ? '🖼' : mime.startsWith('video/') ? '🎬' : mime.startsWith('text/') ? '📄' : mime.startsWith('audio/') ? '🎵' : '📦';
  const time = new Date(f.time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  item.innerHTML = `
    <span class="fname">${icon} ${safe}</span>
    <span class="fmeta">${fmtSize(f.bytes.length)} · ${time}</span>
    <button>💾</button>
  `;
  item.querySelector('button')!.onclick = () => {
    const blob = new Blob([f.bytes as BlobPart], { type: f.type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = safe;
    a.click();
  };
  list.prepend(item);
}

$('start-btn').addEventListener('click', () => {
  // 未启动时点击 → 启动；完成后（迷你态）点击 → 恢复全屏继续
  startCamera();
});

// 镜头点击：隐藏态点击 → 恢复继续接收
const camVideo = $('cam');
camVideo.addEventListener('click', () => {
  if (miniMode) {
    startCamera();
  }
});
