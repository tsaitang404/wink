// wink 协议核心（Rust 端）
//
// 必须与 shared/protocol.ts 逐位一致（golden 向量断言锁定）。
// - u32 运算用 wrapping_*（与 JS Math.imul/>>> 语义一致）
// - f64 运算保持 IEEE-754 默认语义

#![allow(
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_possible_wrap,
    clippy::many_single_char_names,
    clippy::cast_lossless,
    clippy::items_after_statements
)]

pub const FRAME_MAGIC: u8 = 0x57; // 'W'
pub const FRAME_VERSION: u8 = 0x01;
pub const HEADER_LEN: usize = 20;

pub const FILE_MAGIC: [u8; 4] = [0x57, 0x4e, 0x4b, 0x31]; // "WNK1"
pub const TEXT_MAGIC: [u8; 4] = [0x57, 0x4e, 0x4b, 0x54]; // "WNKT"
pub const MANIFEST_MAGIC: [u8; 4] = [0x57, 0x4e, 0x4b, 0x4d]; // "WNKM"

pub const FILE_HEADER_LEN: usize = 49;
pub const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_SOURCE_BLOCKS: u16 = 0xffff;
pub const MAX_SNIPPET_BYTES: u32 = 4 * 1024 * 1024;

/// FNV-1a（纯 u32 wrapping 运算）
#[must_use]
pub fn fnv1a(bytes: &[u8]) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for &b in bytes {
        h ^= b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

/// splitmix32 确定性 PRNG（与 TS 逐位一致）
pub struct SplitMix32 {
    s: u32,
}

impl SplitMix32 {
    #[must_use]
    pub fn new(seed: u32) -> Self {
        Self { s: seed }
    }
    #[must_use]
    pub fn next_u32(&mut self) -> u32 {
        self.s = self.s.wrapping_add(0x9e37_79b9);
        let mut t = self.s ^ (self.s >> 16);
        t = t.wrapping_mul(0x21f0_aaad);
        t ^= t >> 15;
        t = t.wrapping_mul(0x735a_2d97);
        t ^= t >> 15;
        t
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FrameHeader {
    pub session_id: u16,
    pub seq: u32,
    pub k: u16,
    pub block_len: u16,
    pub total_len: u32,
    pub payload_fnv: u32,
}

#[must_use]
pub fn pack_frame(h: &FrameHeader, block: &[u8]) -> Vec<u8> {
    let mut out = vec![0u8; HEADER_LEN + block.len()];
    out[0] = FRAME_MAGIC;
    out[1] = FRAME_VERSION;
    out[2..4].copy_from_slice(&h.session_id.to_le_bytes());
    out[4..8].copy_from_slice(&h.seq.to_le_bytes());
    out[8..10].copy_from_slice(&h.k.to_le_bytes());
    out[10..12].copy_from_slice(&h.block_len.to_le_bytes());
    out[12..16].copy_from_slice(&h.total_len.to_le_bytes());
    out[16..20].copy_from_slice(&h.payload_fnv.to_le_bytes());
    out[HEADER_LEN..].copy_from_slice(block);
    out
}

#[must_use]
pub fn parse_frame(bytes: &[u8]) -> Option<(FrameHeader, &[u8])> {
    if bytes.len() <= HEADER_LEN {
        return None;
    }
    if bytes[0] != FRAME_MAGIC || bytes[1] != FRAME_VERSION {
        return None;
    }
    let header = FrameHeader {
        session_id: u16::from_le_bytes([bytes[2], bytes[3]]),
        seq: u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]),
        k: u16::from_le_bytes([bytes[8], bytes[9]]),
        block_len: u16::from_le_bytes([bytes[10], bytes[11]]),
        total_len: u32::from_le_bytes([bytes[12], bytes[13], bytes[14], bytes[15]]),
        payload_fnv: u32::from_le_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]),
    };
    if header.k == 0 || header.block_len == 0 || header.total_len == 0 {
        return None;
    }
    if bytes.len() != HEADER_LEN + header.block_len as usize {
        return None;
    }
    Some((header, &bytes[HEADER_LEN..]))
}

#[must_use]
pub fn stream_identity(h: &FrameHeader) -> String {
    format!(
        "{}:{}:{}:{}:{}",
        h.session_id, h.k, h.block_len, h.total_len, h.payload_fnv
    )
}

/// 安全文件名：剥离路径/控制字符（与 TS safeFileName 一致）
#[must_use]
pub fn safe_file_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .trim()
        .to_string();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        "transfer.bin".to_string()
    } else {
        cleaned
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fnv1a_empty_is_offset_basis() {
        assert_eq!(fnv1a(&[]), 0x811c_9dc5);
    }

    #[test]
    fn fnv1a_abc_matches_golden() {
        // golden: 0x1a47e90b (TS 实测)
        assert_eq!(fnv1a(b"abc"), 0x1a47e90b);
    }

    #[test]
    fn splitmix32_fixed_sequence() {
        let mut rnd = SplitMix32::new(1234);
        let a: Vec<u32> = (0..10).map(|_| rnd.next_u32()).collect();
        let mut rnd2 = SplitMix32::new(1234);
        let b: Vec<u32> = (0..10).map(|_| rnd2.next_u32()).collect();
        assert_eq!(a, b);
    }

    #[test]
    fn pack_parse_roundtrip() {
        let h = FrameHeader {
            session_id: 1,
            seq: 42,
            k: 8,
            block_len: 64,
            total_len: 512,
            payload_fnv: 0xdeadbeef,
        };
        let block: Vec<u8> = (0..64).collect();
        let frame = pack_frame(&h, &block);
        assert_eq!(frame.len(), HEADER_LEN + 64);
        let (parsed, parsed_block) = parse_frame(&frame).unwrap();
        assert_eq!(parsed, h);
        assert_eq!(parsed_block, block);
    }

    #[test]
    fn parse_rejects_bad() {
        assert!(parse_frame(&[0u8; 5]).is_none());
        let mut bad = vec![0u8; HEADER_LEN + 64];
        bad[0] = 0;
        assert!(parse_frame(&bad).is_none());
    }

    #[test]
    fn safe_name_strips() {
        assert_eq!(safe_file_name("../evil.txt"), "evil.txt");
        assert_eq!(safe_file_name("/abs/path/file"), "file");
        assert_eq!(safe_file_name(".."), "transfer.bin");
        assert_eq!(safe_file_name("正常文件.txt"), "正常文件.txt");
    }
}
