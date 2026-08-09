// wink 喷泉码（Rust 端）—— 与 shared/fountain.ts 逐位一致
//
// 跨语言铁律：
// - dlog: 只用 IEEE-754 基础运算（+ - * /），禁止 f64::ln
// - soliton_cdf: 同参数 C=0.1 δ=0.5
// - frame_indices: 逆 CDF 二分 + Fisher-Yates/去重采样
//
// clippy 说明：协议路径的 `as f64` cast 是安全的（k ≤ 65535、i32 范围），
// 为保持与 TS 移植的可读性，局部 allow 而非全改 From。

#![allow(
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_possible_wrap,
    clippy::many_single_char_names,
    clippy::cast_lossless,
    clippy::too_many_lines,
    clippy::module_name_repetitions
)]

use crate::protocol::SplitMix32;

const LN2: f64 = std::f64::consts::LN_2;
const SOLITON_C: f64 = 0.1;
const SOLITON_DELTA: f64 = 0.5;

/// 确定性自然对数（与 TS dlog 逐位一致）
#[must_use]
pub fn dlog(x: f64) -> f64 {
    let mut e: i32 = 0;
    let mut m = x;
    while m >= 1.5 {
        m /= 2.0;
        e += 1;
    }
    while m < 0.75 {
        m *= 2.0;
        e -= 1;
    }
    let z = (m - 1.0) / (m + 1.0);
    let z2 = z * z;
    let mut term = z;
    let mut sum = 0.0;
    let mut n = 1;
    while n <= 21 {
        sum += term / n as f64;
        term *= z2;
        n += 2;
    }
    (e as f64) * LN2 + 2.0 * sum
}

/// robust-soliton degree CDF
#[must_use]
pub fn soliton_cdf(k: usize) -> Vec<f64> {
    let mut cdf = vec![0.0f64; k];
    if k == 1 {
        cdf[0] = 1.0;
        return cdf;
    }
    let r = (SOLITON_C * dlog(k as f64 / SOLITON_DELTA) * (k as f64).sqrt()).max(1.0);
    let spike = ((k as f64) / r).ceil().min(k as f64) as usize;
    let mut total = 0.0;
    for d in 1..=k {
        let rho = if d == 1 {
            1.0 / k as f64
        } else {
            1.0 / ((d * (d - 1)) as f64)
        };
        let mut tau = 0.0;
        if d < spike {
            tau = r / (d as f64 * k as f64);
        } else if d == spike {
            tau = (r * (dlog(r / SOLITON_DELTA)).max(0.0)) / k as f64;
        }
        total += rho + tau;
        cdf[d - 1] = total;
    }
    for v in &mut cdf {
        *v /= total;
    }
    cdf[k - 1] = 1.0;
    cdf
}

fn frame_seed(session_id: u16, seq: u32) -> u32 {
    // TS: h = imul(sessionId+1, 0x9e3779b1) ^ (seq + 0x85ebca6b)
    let h = (session_id as u32)
        .wrapping_add(1)
        .wrapping_mul(0x9e37_79b1)
        ^ seq.wrapping_add(0x85eb_ca6b);
    // TS: h = imul(h ^ (h>>>13), 0xc2b2ae35)
    let h = (h ^ (h >> 13)).wrapping_mul(0xc2b2_ae35);
    // TS: return (h ^ (h>>>16)) | 0
    h ^ (h >> 16)
}

/// 帧 seq 的块子集（与 TS frameIndices 逐位一致）
#[must_use]
pub fn frame_indices(k: usize, cdf: &[f64], session_id: u16, seq: u32) -> Vec<usize> {
    let mut rnd = SplitMix32::new(frame_seed(session_id, seq));
    let u = rnd.next_u32() as f64 * 2f64.powi(-32);
    let mut lo = 0usize;
    let mut hi = k - 1;
    while lo < hi {
        let mid = (lo + hi) >> 1;
        if cdf[mid] >= u {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    let d = (lo + 1).min(k);
    if d > k >> 3 {
        // 大 degree：部分 Fisher-Yates
        let mut scratch: Vec<usize> = (0..k).collect();
        let mut out = Vec::with_capacity(d);
        for i in 0..d {
            let j = i + (rnd.next_u32() as usize % (k - i));
            scratch.swap(i, j);
            out.push(scratch[i]);
        }
        out
    } else {
        // 小 degree：去重采样
        let mut set = std::collections::HashSet::new();
        while set.len() < d {
            set.insert(rnd.next_u32() as usize % k);
        }
        set.into_iter().collect()
    }
}

pub struct LTEncoder {
    pub k: usize,
    words: usize,
    blocks: Vec<u32>,
    cdf: Vec<f64>,
    pub block_len: usize,
    session_id: u16,
}

impl LTEncoder {
    #[must_use]
    pub fn new(payload: &[u8], block_len: usize, session_id: u16) -> Self {
        let k = payload.len().div_ceil(block_len).max(1);
        let words = block_len.div_ceil(4);
        let mut blocks = vec![0u32; k * words];
        for (b, chunk) in payload.chunks(block_len).enumerate() {
            let base = b * words * 4;
            for (i, byte) in chunk.iter().enumerate() {
                blocks[(base + i) / 4] |= (*byte as u32) << ((i % 4) * 8);
            }
        }
        let cdf = soliton_cdf(k);
        Self {
            k,
            words,
            blocks,
            cdf,
            block_len,
            session_id,
        }
    }

    #[must_use]
    pub fn encode(&self, seq: u32) -> Vec<u8> {
        let idx = frame_indices(self.k, &self.cdf, self.session_id, seq);
        let mut out = vec![0u32; self.words];
        for &b in &idx {
            let off = b * self.words;
            for (w, item) in out.iter_mut().enumerate() {
                *item ^= self.blocks[off + w];
            }
        }
        let mut bytes = Vec::with_capacity(self.block_len);
        for w in &out {
            bytes.extend_from_slice(&w.to_le_bytes());
        }
        bytes.truncate(self.block_len);
        bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dlog_known_values() {
        assert_eq!(dlog(1.0), 0.0);
        assert_eq!(dlog(2.0), 0.6931471805599453);
        assert_eq!(dlog(std::f64::consts::E), 1.0);
        for x in [0.5f64, 1.5, 10.0, 100.0, 0.25] {
            assert!((dlog(x) - x.ln()).abs() < 1e-12, "dlog({x})");
        }
    }

    #[test]
    fn soliton_k1() {
        assert_eq!(soliton_cdf(1), vec![1.0]);
    }

    #[test]
    fn soliton_k100_sane() {
        let cdf = soliton_cdf(100);
        assert_eq!(cdf.len(), 100);
        assert_eq!(cdf[99], 1.0);
        for i in 1..100 {
            assert!(cdf[i] >= cdf[i - 1], "cdf[{i}] monotone");
        }
    }

    #[test]
    fn frame_indices_deterministic_in_range() {
        let k = 8;
        let cdf = soliton_cdf(k);
        let a = frame_indices(k, &cdf, 1, 0);
        let b = frame_indices(k, &cdf, 1, 0);
        assert_eq!(a, b);
        for idx in &a {
            assert!(*idx < k);
        }
    }

    #[test]
    fn lt_frames_deterministic_and_distinct() {
        let payload: Vec<u8> = (0..2048).map(|i| (i * 7 % 256) as u8).collect();
        let block_len = 64;
        let enc = LTEncoder::new(&payload, block_len, 7);
        for seq in 0..enc.k * 2 {
            let frame = enc.encode(seq as u32);
            assert_eq!(frame.len(), block_len);
        }
        assert_ne!(enc.encode(0), enc.encode(1));
    }
}
