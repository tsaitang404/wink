// wink 喷泉码（LT，Luby transform）—— 跨语言确定性实现
//
// 移植自 decimen-optical-transfer (MIT)。核心是跨语言一致性：
// - dlog：确定性自然对数，只用 IEEE-754 基础运算（禁止 Math.log）
// - splitmix32：纯整数运算（见 protocol.ts）
// - solitonCdf：robust-soliton 分布
// - frameIndices：逆 CDF 采样块子集
//
// Rust 端必须逐位复现（golden 向量断言锁定）。

import { splitmix32 } from './protocol';

const LN2 = 0.6931471805599453;
const SOLITON_C = 0.1;
const SOLITON_DELTA = 0.5;

/**
 * 确定性自然对数：精确 IEEE-754 运算（range reduction + atanh 级数）。
 * 不用 Math.log（libm 近似，JS 引擎之间/Rust 可能差 1 ulp，会静默失步）。
 */
export function dlog(x: number): number {
  let e = 0;
  let m = x;
  while (m >= 1.5) {
    m /= 2;
    e++;
  }
  while (m < 0.75) {
    m *= 2;
    e--;
  }
  const z = (m - 1) / (m + 1);
  const z2 = z * z;
  let term = z;
  let sum = 0;
  for (let n = 1; n <= 21; n += 2) {
    sum += term / n;
    term *= z2;
  }
  return e * LN2 + 2 * sum;
}

/** robust-soliton degree CDF for k source blocks */
export function solitonCdf(k: number): Float64Array {
  const cdf = new Float64Array(k);
  if (k === 1) {
    cdf[0] = 1;
    return cdf;
  }
  const R = Math.max(1, SOLITON_C * dlog(k / SOLITON_DELTA) * Math.sqrt(k));
  const spike = Math.min(k, Math.ceil(k / R));
  let total = 0;
  for (let d = 1; d <= k; d++) {
    const rho = d === 1 ? 1 / k : 1 / (d * (d - 1));
    let tau = 0;
    if (d < spike) tau = R / (d * k);
    else if (d === spike) tau = (R * Math.max(0, dlog(R / SOLITON_DELTA))) / k;
    total += rho + tau;
    cdf[d - 1] = total;
  }
  for (let i = 0; i < k; i++) cdf[i] = cdf[i]! / total;
  cdf[k - 1] = 1;
  return cdf;
}

/** 会话+序列号 → PRNG 种子 */
function frameSeed(sessionId: number, seq: number): number {
  let h = (Math.imul(sessionId + 1, 0x9e3779b1) ^ (seq + 0x85ebca6b)) | 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) | 0;
}

/**
 * 帧 seq 的块子集索引 —— 双端必须完全一致。
 * 逆 CDF 采样 degree + Fisher-Yates/去重采样块索引。
 */
export function frameIndices(
  k: number,
  cdf: Float64Array,
  sessionId: number,
  seq: number,
): number[] {
  const rnd = splitmix32(frameSeed(sessionId, seq));
  const u = rnd() * 2 ** -32;
  let lo = 0;
  let hi = k - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid]! >= u) hi = mid;
    else lo = mid + 1;
  }
  const d = Math.min(k, lo + 1);
  if (d > k >> 3) {
    const scratch = new Uint32Array(k);
    for (let i = 0; i < k; i++) scratch[i] = i;
    const out: number[] = new Array<number>(d);
    for (let i = 0; i < d; i++) {
      const j = i + (rnd() % (k - i));
      const t = scratch[i]!;
      scratch[i] = scratch[j]!;
      scratch[j] = t;
      out[i] = scratch[i]!;
    }
    return out;
  }
  const set = new Set<number>();
  while (set.size < d) set.add(rnd() % k);
  return [...set];
}

function xorInto(dst: Uint32Array, src: Uint32Array): void {
  for (let i = 0; i < dst.length; i++) dst[i] = (dst[i]! ^ src[i]!) >>> 0;
}

export class LTEncoder {
  readonly k: number;
  private readonly words: number;
  private readonly blocks: Uint32Array;
  private readonly cdf: Float64Array;

  constructor(payload: Uint8Array, readonly blockLen: number, readonly sessionId: number) {
    this.k = Math.max(1, Math.ceil(payload.length / blockLen));
    this.words = Math.ceil(blockLen / 4);
    this.blocks = new Uint32Array(this.k * this.words);
    const bytes = new Uint8Array(this.blocks.buffer);
    for (let b = 0; b < this.k; b++) {
      const src = payload.subarray(b * blockLen, Math.min((b + 1) * blockLen, payload.length));
      bytes.set(src, b * this.words * 4);
    }
    this.cdf = solitonCdf(this.k);
  }

  encode(seq: number): Uint8Array {
    const idx = frameIndices(this.k, this.cdf, this.sessionId, seq);
    const out = new Uint32Array(this.words);
    for (const b of idx) {
      const off = b * this.words;
      for (let w = 0; w < this.words; w++) out[w] = (out[w]! ^ this.blocks[off + w]!) >>> 0;
    }
    return new Uint8Array(out.buffer, 0, this.blockLen);
  }

  /**
   * 找到生成 degree-1 帧且只包含目标块的 seq（重发指定块用）。
   * 扫描有限范围（默认 8192 个候选），找到即返回；找不到返回 null。
   * 该帧与普通帧完全同构，接收端用同一 seq 重新计算 indices → 直接解出该块。
   */
  findDeg1Seq(block: number, fromSeq = 0, scanLimit = 8192): number | null {
    if (block < 0 || block >= this.k) return null;
    for (let i = 0; i < scanLimit; i++) {
      const s = (fromSeq + i) >>> 0;
      const idx = frameIndices(this.k, this.cdf, this.sessionId, s);
      if (idx.length === 1 && idx[0] === block) return s;
    }
    return null;
  }

  /** 枚举所有 seq → degree-1 块映射（用于"已发送哪些块"视图） */
  deg1BlockAt(seq: number): number | null {
    const idx = frameIndices(this.k, this.cdf, this.sessionId, seq);
    if (idx.length === 1 && idx[0] !== undefined) return idx[0];
    return null;
  }
}

interface PendingFrame {
  idx: Set<number>;
  words: Uint32Array;
}

export class LTDecoder {
  private readonly words: number;
  private readonly cdf: Float64Array;
  private readonly solved: (Uint32Array | null)[];
  private readonly byBlock = new Map<number, Set<PendingFrame>>();
  private readonly seen = new Set<number>();
  solvedCount = 0;
  framesNew = 0;
  framesDup = 0;

  constructor(
    readonly k: number,
    readonly blockLen: number,
    readonly sessionId: number,
    readonly totalLen: number,
  ) {
    this.words = Math.ceil(blockLen / 4);
    this.cdf = solitonCdf(k);
    this.solved = new Array<Uint32Array | null>(k).fill(null);
  }

  get isComplete(): boolean {
    return this.solvedCount >= this.k;
  }

  /** 块状态：0=灰（未涉及）1=红（收到帧引用但未解出）2=绿（已解出） */
  blockState(b: number): 0 | 1 | 2 {
    if (this.solved[b]) return 2;
    if (this.byBlock.has(b)) return 1;
    return 0;
  }

  /** 已收到的帧 seq 位图（进度条按帧顺序显示用） */
  receivedSeqs(): Set<number> {
    return this.seen;
  }

  addFrame(seq: number, block: Uint8Array): void {
    if (this.seen.has(seq)) {
      this.framesDup++;
      return;
    }
    this.seen.add(seq);
    this.framesNew++;
    if (this.isComplete) return;

    const idx = new Set(frameIndices(this.k, this.cdf, this.sessionId, seq));
    const words = new Uint32Array(this.words);
    new Uint8Array(words.buffer).set(block.subarray(0, this.blockLen));
    for (const b of [...idx]) {
      const s = this.solved[b];
      if (s) {
        xorInto(words, s);
        idx.delete(b);
      }
    }
    if (idx.size === 0) return;
    if (idx.size === 1) {
      this.resolve(idx.values().next().value!, words);
      return;
    }
    const pf: PendingFrame = { idx, words };
    for (const b of idx) {
      let set = this.byBlock.get(b);
      if (!set) {
        set = new Set();
        this.byBlock.set(b, set);
      }
      set.add(pf);
    }
  }

  private resolve(b0: number, w0: Uint32Array): void {
    const queue: [number, Uint32Array][] = [[b0, w0]];
    while (queue.length > 0) {
      const [b, w] = queue.pop()!;
      if (this.solved[b]) continue;
      this.solved[b] = w;
      this.solvedCount++;
      const waiting = this.byBlock.get(b);
      if (!waiting) continue;
      this.byBlock.delete(b);
      for (const pf of waiting) {
        xorInto(pf.words, w);
        pf.idx.delete(b);
        if (pf.idx.size === 1) {
          const r = pf.idx.values().next().value!;
          this.byBlock.get(r)?.delete(pf);
          if (!this.solved[r]) queue.push([r, pf.words]);
        }
      }
    }
  }

  assemble(): Uint8Array | null {
    if (!this.isComplete) return null;
    const out = new Uint8Array(this.totalLen);
    for (let b = 0; b < this.k; b++) {
      const start = b * this.blockLen;
      const len = Math.min(this.blockLen, this.totalLen - start);
      if (len > 0) out.set(new Uint8Array(this.solved[b]!.buffer, 0, len), start);
    }
    return out;
  }
}
