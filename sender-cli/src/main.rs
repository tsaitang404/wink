// wink —— wink 光学文件传输（终端发送端）
//
// 流程：wink send <file> → 显示元信息 QR → 按回车开始 → 喷泉帧流
// 发送端零依赖：musl 静态编译单文件
//
// clippy 说明：协议字段是 u16/u32，文件大小 cast 截断受协议约束（受 65535 块 × 块长限制），
// 此处 allow 而非全改。

#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss,
    clippy::too_many_lines,
    clippy::items_after_statements,
    clippy::module_name_repetitions,
    clippy::ptr_as_ptr
)]

mod fountain;
mod protocol;
mod qr;

use std::io::Write;
use std::process::exit;

use fountain::LTEncoder;
use protocol::{fnv1a, pack_frame, FrameHeader};

const VERSION: &str = env!("CARGO_PKG_VERSION");

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 || args[1] != "send" {
        print_usage();
        exit(1);
    }
    let path = &args[2];
    let fps: u32 = parse_arg(&args, "--fps", 30);
    let block_len: usize = parse_arg(&args, "--block", 128) as usize;

    // 1. 读文件
    let data = match std::fs::read(path) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("❌ 无法读取 {path}: {e}");
            exit(1);
        }
    };
    if data.is_empty() {
        eprintln!("❌ 文件为空");
        exit(1);
    }
    let name = path
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("file")
        .to_string();
    eprintln!("📄 {name} · {} bytes", data.len());

    // 2. 打包容器（无压缩，v0.1 简版；文件名用 UTF-8）
    let name_bytes = name.as_bytes();
    let container = pack_container(&data, name_bytes);
    eprintln!("📦 容器 {} bytes", container.len());

    // 3. 随机 session
    let session_id = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos()
        % 0xffff) as u16;

    // 4. 元信息 QR
    let manifest = build_manifest_bytes(name_bytes, &container, session_id, fps, block_len);
    let (manifest_ansi, _v) = qr::render_ansi(&manifest, 2);

    // 主循环：显示 manifest → 按 Enter 开始帧流 → 按 q 停止回到 manifest
    let enc = LTEncoder::new(&container, block_len, session_id);
    let payload_fnv = fnv1a(&container);
    let total_len = container.len() as u32;
    let mut total_sent: u64 = 0;
    let start_all = std::time::Instant::now();

    loop {
        // 显示元信息 QR（在主屏幕，不用备用屏）
        eprintln!("📡 元信息 QR —— 接收端扫码预览，按 Enter 开始（q 退出）");
        print!("{manifest_ansi}");
        std::io::stdout().flush().ok();

        // 等待 Enter（q 直接退出）
        if !wait_enter_or_q() {
            clear_screen();
            eprintln!(
                "👋 已退出 · 共发送 {total_sent} 帧 · {}s",
                start_all.elapsed().as_secs()
            );
            break;
        }

        // 进入备用屏幕（不会滚动污染主屏）
        enter_alt_screen();
        let termios = enter_raw_mode();
        eprintln!("\n🚀 开始传输 @ {fps}fps（按 q 停止，回到元信息）");
        let start = std::time::Instant::now();
        let mut seq: u32 = 0;

        loop {
            let block = enc.encode(seq);
            let header = FrameHeader {
                session_id,
                seq,
                k: enc.k as u16,
                block_len: block_len as u16,
                total_len,
                payload_fnv,
            };
            let frame = pack_frame(&header, &block);
            let (ansi, _v) = qr::render_ansi(&frame, 2);
            // 光标归位 + 覆盖渲染（不滚动），不用清屏避免闪烁
            print!("\x1b[H{ansi}");
            print_status(seq, enc.k, fps, start.elapsed());
            std::io::stdout().flush().ok();

            if key_pressed('q') {
                break;
            }
            std::thread::sleep(std::time::Duration::from_secs_f64(1.0 / f64::from(fps)));
            seq = seq.wrapping_add(1);
        }

        // 退出备用屏 + 恢复 termios
        restore_termios(termios);
        leave_alt_screen();
        total_sent += u64::from(seq);
        eprintln!(
            "\n⏹ 已停止 · 本轮 {seq} 帧 · {}s",
            start.elapsed().as_secs()
        );
        eprintln!("────────────────────────────");
    }
}

fn print_usage() {
    eprintln!(
        "wink {VERSION} — 对镜头 wink 传输文件\n\
         \n\
         用法:\n\
         \x20 wink send <file> [--fps 30] [--block 128]\n\
         \n\
         选项:\n\
         \x20 --fps 1-60   帧率（默认 30）\n\
         \x20 --block N    块长字节（默认 128）"
    );
}

fn parse_arg(args: &[String], key: &str, default: u32) -> u32 {
    args.iter()
        .position(|a| a == key)
        .and_then(|i| args.get(i + 1))
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

/// 文件容器：magic WNK1 + nameLen + dataLen + sha256 + data
/// 与 TS packFile 布局兼容（compression=0，typeLen=0）
fn pack_container(data: &[u8], name: &[u8]) -> Vec<u8> {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(data);
    let sha = hasher.finalize();

    let mut out = Vec::with_capacity(49 + name.len() + data.len());
    out.extend_from_slice(&[0x57, 0x4e, 0x4b, 0x31]); // WNK1
    out.push(0); // compression none
    out.extend_from_slice(&(name.len() as u16).to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // typeLen = 0
    out.extend_from_slice(&(data.len() as u32).to_le_bytes()); // originalSize
    out.extend_from_slice(&(data.len() as u32).to_le_bytes()); // transmittedSize
    out.extend_from_slice(sha.as_slice()); // SHA-256（真实计算）
    out.extend_from_slice(name);
    out.extend_from_slice(data);
    out
}

/// 元信息帧（manifest）：与 TS packManifest 布局一致
fn build_manifest_bytes(
    name: &[u8],
    container: &[u8],
    session_id: u16,
    fps: u32,
    block_len: usize,
) -> Vec<u8> {
    let k = container.len().div_ceil(block_len).max(1);
    let est = (k as u64 * 115 / 100).div_ceil(u64::from(fps)) as u32;
    let mut out = Vec::with_capacity(36 + name.len());
    out.extend_from_slice(&[0x57, 0x4e, 0x4b, 0x4d]); // WNKM
    out.push(1); // version
    out.push(0); // payloadType file
    out.push(0); // compression
    out.push(0); // codec 黑白
    out.extend_from_slice(&(name.len() as u16).to_le_bytes());
    out.extend_from_slice(&(container.len() as u32).to_le_bytes()); // originalSize
    out.extend_from_slice(&(container.len() as u32).to_le_bytes()); // transmittedSize
    out.extend_from_slice(&(k as u16).to_le_bytes());
    out.extend_from_slice(&(block_len as u16).to_le_bytes());
    out.extend_from_slice(&session_id.to_le_bytes());
    out.extend_from_slice(&15u16.to_le_bytes()); // qrVersion 建议
    out.extend_from_slice(&(fps as u16).to_le_bytes());
    out.extend_from_slice(&est.to_le_bytes());
    out.extend_from_slice(&fnv1a(container).to_le_bytes()); // payloadFnv
    out.extend_from_slice(name);
    out
}

fn clear_screen() {
    print!("\x1b[2J\x1b[H");
}

fn print_status(seq: u32, k: usize, fps: u32, elapsed: std::time::Duration) {
    let need = (k as f64 * 1.15) as u32;
    let secs = elapsed.as_secs();
    eprintln!("\x1b[Kwink · 帧 {seq} · K={k} · 需求≈{need} · {fps}fps · {secs}s · 按 q 停止");
}

// ── 终端控制：备用屏幕 + raw mode ─────────────────────────────

/// 进入备用屏幕缓冲（像 vim/top：不污染主屏幕，退出时还原）
fn enter_alt_screen() {
    print!("\x1b[?1049h");
    std::io::stdout().flush().ok();
}

/// 退出备用屏幕缓冲
fn leave_alt_screen() {
    print!("\x1b[?1049l");
    std::io::stdout().flush().ok();
}

/// 进入 raw mode：关闭 canonical（行缓冲）和 echo，让单键立即可读
/// 返回原始 termios 用于恢复
#[allow(unsafe_code)]
fn enter_raw_mode() -> libc::termios {
    use std::os::fd::AsRawFd;
    let fd = std::io::stdin().as_raw_fd();
    let mut termios: libc::termios = unsafe { std::mem::zeroed() };
    unsafe {
        libc::tcgetattr(fd, &raw mut termios);
        let raw = termios;
        let mut new = raw;
        new.c_lflag &= !(libc::ICANON | libc::ECHO);
        new.c_cc[libc::VMIN] = 0;
        new.c_cc[libc::VTIME] = 0;
        libc::tcsetattr(fd, libc::TCSANOW, &raw const new);
    }
    termios
}

/// 恢复 termios
#[allow(unsafe_code)]
fn restore_termios(termios: libc::termios) {
    use std::os::fd::AsRawFd;
    let fd = std::io::stdin().as_raw_fd();
    unsafe {
        libc::tcsetattr(fd, libc::TCSANOW, &raw const termios);
    }
}

/// 非阻塞检查 stdin 是否有指定按键（用 poll，不阻塞）
/// 需要 raw mode 才能读到单键
#[allow(unsafe_code)]
fn key_pressed(key: char) -> bool {
    use std::os::fd::AsRawFd;
    let fd = std::io::stdin().as_raw_fd();
    let mut fds = [libc::pollfd {
        fd,
        events: libc::POLLIN,
        revents: 0,
    }];
    let r = unsafe { libc::poll(fds.as_mut_ptr(), 1, 0) };
    if r <= 0 {
        return false;
    }
    let mut buf = [0u8; 64];
    let n = unsafe { libc::read(fd, buf.as_mut_ptr() as *mut libc::c_void, buf.len()) };
    if n <= 0 {
        return false;
    }
    buf[..n as usize].iter().any(|&b| b as char == key)
}

/// 等待 Enter（返回 true）或 q（返回 false）。canonical 模式行缓冲即可。
#[allow(unsafe_code)]
fn wait_enter_or_q() -> bool {
    use std::os::fd::AsRawFd;
    let fd = std::io::stdin().as_raw_fd();
    let mut termios: libc::termios = unsafe { std::mem::zeroed() };
    unsafe {
        libc::tcgetattr(fd, &raw mut termios);
        let mut new = termios;
        new.c_lflag &= !libc::ICANON; // 关 canonical，单键返回
        new.c_lflag &= !libc::ECHO;
        new.c_cc[libc::VMIN] = 1;
        new.c_cc[libc::VTIME] = 0;
        libc::tcsetattr(fd, libc::TCSANOW, &raw const new);
    }
    let mut buf = [0u8; 1];
    let n = unsafe { libc::read(fd, buf.as_mut_ptr() as *mut libc::c_void, 1) };
    unsafe {
        libc::tcsetattr(fd, libc::TCSANOW, &raw const termios);
    }
    if n <= 0 {
        return false;
    }
    buf[0] != b'q'
}
