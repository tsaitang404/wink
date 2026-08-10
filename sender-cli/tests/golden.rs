// 金标准向量断言 —— 跨语言一致性的唯一保险
//
// 读 protocol/golden-vectors/（TS 生成，已提交 git），
// 用 Rust 实现重新计算，断言字节相等。
// 任何一侧偏离 → 这里 FAIL。

use std::path::PathBuf;
use wink::fountain::{dlog, soliton_cdf};
use wink::protocol::{fnv1a, pack_frame, FrameHeader, SplitMix32};

fn vectors_dir() -> PathBuf {
    // 测试运行时 cwd = sender-cli/，向上两级到仓库根
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("protocol")
        .join("golden-vectors")
}

fn read(name: &str) -> Vec<u8> {
    std::fs::read(vectors_dir().join(name))
        .unwrap_or_else(|e| panic!("cannot read golden vector {name}: {e}"))
}

#[test]
fn golden_dlog_matches() {
    // dlog-vector.tsv: x\tdlog_hex
    // TS hex64 用 getBigUint64(0,false) 读小端内存 → 得到的是"小端字节序的数值"
    // Rust to_bits() 后需要按同样方式呈现：转小端字节序 hex
    let tsv = String::from_utf8(read("dlog-vector.tsv")).expect("tsv utf8");
    for (i, line) in tsv.lines().enumerate().skip(1) {
        let mut parts = line.split('\t');
        let x: f64 = parts.next().expect("x").parse().expect("f64");
        let hex = parts.next().expect("hex");
        let bits = dlog(x).to_bits();
        // 小端字节序呈现（与 TS getBigUint64 一致）
        let little = bits.swap_bytes();
        assert_eq!(format!("{little:016x}"), hex, "dlog({x}) line {}", i + 1);
    }
}

#[test]
fn golden_soliton_matches() {
    let expected = read("soliton-k100.bin");
    assert_eq!(expected.len(), 100 * 8);
    let cdf = soliton_cdf(100);
    for (i, v) in cdf.iter().enumerate() {
        let bytes = v.to_le_bytes();
        for (j, b) in bytes.iter().enumerate() {
            assert_eq!(*b, expected[i * 8 + j], "soliton[{}] byte {}", i, j);
        }
    }
}

#[test]
fn golden_frame_matches() {
    let expected = read("frame-session1.bin");
    // TS: sessionId=1, seq=0, k=4, blockLen=16, totalLen=100, payloadFnv=fnv1a("hello world 1234")
    let payload = b"hello world 1234";
    let payload_fnv = fnv1a(payload);
    let mut block = vec![0u8; 16];
    block[..payload.len()].copy_from_slice(payload);
    let header = FrameHeader {
        session_id: 1,
        seq: 0,
        k: 4,
        block_len: 16,
        total_len: 100,
        payload_fnv,
    };
    let frame = pack_frame(&header, &block);
    assert_eq!(frame, expected, "frame bytes differ");
}

#[test]
fn golden_splitmix32_matches() {
    let expected = read("splitmix32-seq.bin");
    assert_eq!(expected.len(), 64 * 4);
    let mut rnd = SplitMix32::new(1234);
    for i in 0..64 {
        let v = rnd.next_u32();
        let bytes = v.to_le_bytes();
        for (j, b) in bytes.iter().enumerate() {
            assert_eq!(*b, expected[i * 4 + j], "splitmix32[{}] byte {}", i, j);
        }
    }
}

#[test]
fn golden_manifest_matches() {
    // 由 TS 生成固定 manifest（v2, session 7, golden.txt, layout=3 2x2, k=ceil(1234/128)=10）
    let expected = read("manifest-sample.bin");
    // 手工重建与 TS buildManifest 相同的字节
    let name = b"golden.txt";
    let mut out = vec![0u8; 37 + name.len()];
    out[0..4].copy_from_slice(&[0x57, 0x4e, 0x4b, 0x4d]); // WNKM
    out[4] = 2; // version
    out[5] = 0; // payloadType file
    out[6] = 0; // compression none
    out[7] = 0; // codec 黑白
    out[8] = 3; // layout 2x2
    out[9..11].copy_from_slice(&(name.len() as u16).to_le_bytes());
    out[11..15].copy_from_slice(&1234u32.to_le_bytes()); // originalSize
    out[15..19].copy_from_slice(&1234u32.to_le_bytes()); // transmittedSize
    out[19..21].copy_from_slice(&10u16.to_le_bytes()); // k = ceil(1234/128) = 10
    out[21..23].copy_from_slice(&128u16.to_le_bytes()); // blockLen
    out[23..25].copy_from_slice(&7u16.to_le_bytes()); // sessionId
    out[25..27].copy_from_slice(&15u16.to_le_bytes()); // qrVersion
    out[27..29].copy_from_slice(&30u16.to_le_bytes()); // fps
    out[29..33].copy_from_slice(&1u32.to_le_bytes()); // estSeconds = ceil(10*1.15/30) = ceil(0.383) = 1
    out[33..37].copy_from_slice(&0x1234_5678u32.to_le_bytes()); // payloadFnv
    out[37..].copy_from_slice(name);
    assert_eq!(out, expected, "manifest bytes differ");
}

#[test]
fn golden_manifest_layout0_matches() {
    // layout=0（单码）回归：v2 最小布局
    let expected = read("manifest-layout0.bin");
    let name = b"a.bin";
    let mut out = vec![0u8; 37 + name.len()];
    out[0..4].copy_from_slice(&[0x57, 0x4e, 0x4b, 0x4d]); // WNKM
    out[4] = 2; // version
    out[5] = 0; // payloadType file
    out[6] = 0; // compression none
    out[7] = 0; // codec 黑白
    out[8] = 0; // layout 1x1
    out[9..11].copy_from_slice(&(name.len() as u16).to_le_bytes());
    out[11..15].copy_from_slice(&500u32.to_le_bytes()); // originalSize
    out[15..19].copy_from_slice(&500u32.to_le_bytes()); // transmittedSize
    out[19..21].copy_from_slice(&8u16.to_le_bytes()); // k = ceil(500/64) = 8
    out[21..23].copy_from_slice(&64u16.to_le_bytes()); // blockLen
    out[23..25].copy_from_slice(&3u16.to_le_bytes()); // sessionId
    out[25..27].copy_from_slice(&20u16.to_le_bytes()); // qrVersion
    out[27..29].copy_from_slice(&30u16.to_le_bytes()); // fps
    out[29..33].copy_from_slice(&1u32.to_le_bytes()); // estSeconds = ceil(8*1.15/30) = 1
    out[33..37].copy_from_slice(&0u32.to_le_bytes()); // payloadFnv
    out[37..].copy_from_slice(name);
    assert_eq!(out, expected, "manifest layout0 bytes differ");
}
