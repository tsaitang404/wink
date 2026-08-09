// wink —— wink 光学文件传输（终端发送端）
//
// 流程：wink <file> → 显示元信息 QR → 按空格开始 → 喷泉帧流
// 播放中：空格暂停/继续，b<块号>跳块、<帧号>跳帧、N%跳百分比（均暂停），q 退出
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
    // --version / -V：显示版本并正常退出
    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!("wink {VERSION}");
        exit(0);
    }
    // --help / -h：显示帮助并正常退出
    if args.iter().any(|a| a == "--help" || a == "-h") {
        print_usage();
        exit(0);
    }
    if args.len() < 2 {
        print_usage();
        exit(1);
    }
    // 用法：wink <file> [--fps 30] [--block N]  （无 send 子命令）
    let path = &args[1];
    let fps: u32 = parse_arg(&args, "--fps", 30);
    // QR 版本：-v<N>（如 -v15 / -v20 / -v40），不传则自动
    let qr_version: Option<u32> = args
        .iter()
        .find_map(|a| a.strip_prefix("-v").and_then(|s| s.parse().ok()))
        .filter(|v| (1..=40).contains(v));
    let block_len: Option<usize> = args
        .iter()
        .position(|a| a == "--block")
        .and_then(|i| args.get(i + 1))
        .and_then(|v| v.parse().ok());

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

    // 2. 打包容器（自动判断压缩：≥768B 且 gzip 省 ≥64B 才压缩）
    let name_bytes = name.as_bytes();
    let (container, container_gzip) = pack_container(&data, name_bytes);
    eprintln!(
        "📦 容器 {} bytes{}",
        container.len(),
        if container_gzip {
            format!("（gzip 压缩，原 {} → {}）", data.len(), container.len())
        } else {
            String::new()
        }
    );

    // 3. 随机 session
    let session_id = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos()
        % 0xffff) as u16;

    // 4. 帧流 QR 版本：-v 指定，否则按终端宽度选最大可容纳版本
    let frame_version = qr_version.unwrap_or_else(|| {
        let cols = terminal_cols().unwrap_or(80);
        // 可用模块宽 = 列数 × 2（半块字符），减安静区；换算版本 vN = (模块数-17)/4
        let max_modules = ((cols as usize) * 2).saturating_sub(8).clamp(21, 177);
        ((max_modules - 17) / 4).clamp(1, 40) as u32
    });

    // 5. 块长：不传则自动优化 —— 尽量填满所选 QR 版本容量（pad 最少，QR 变化明显）
    //    关键：LT 的 degree 不影响帧大小（一帧始终 block_len 字节，XOR 任意个块长度不变），
    //    所以 block_len 可以 = 容量，每帧装满，数据区几乎全变
    //    （qr.rs 已强制 byte mode 单段，容量表精确，无需分段余量）
    let block_len = block_len.unwrap_or_else(|| {
        let capacity = qr_capacity_l(frame_version as usize);
        // 满容量：capacity - 帧头(20)，下限 64
        capacity.saturating_sub(20).max(64)
    });

    // 6. 元信息 QR：自动选合适版本（内容小就用小码，不跟随 -v）
    let manifest = build_manifest_bytes(
        name_bytes,
        &container,
        session_id,
        fps,
        block_len,
        frame_version,
        container_gzip,
        data.len() as u32,
    );
    let (manifest_ansi, _manifest_version) = qr::render_ansi(&manifest, 2, None);

    // 主循环：显示 manifest → 按空格开始帧流 → 按 q 停止回到 manifest
    let enc = LTEncoder::new(&container, block_len, session_id);
    let k = enc.k;
    let total_est = (k as u64 * 115 / 100) as u32;
    let payload_fnv = fnv1a(&container);
    let total_len = container.len() as u32;
    let mut total_sent: u64 = 0;
    let start_all = std::time::Instant::now();

    loop {
        // 显示元信息 QR（在主屏幕，不用备用屏）
        eprintln!("📡 元信息 QR —— 接收端扫码预览，按空格开始（q 退出）");
        print!("{manifest_ansi}");
        // 配置面板：帧率 / 块长 / QR 版本（帧流用）/ 块数 / 总帧数（期望）
        eprintln!("──────────────────────────────");
        eprintln!("  帧率      {fps} fps");
        eprintln!("  块长      {block_len} B");
        eprintln!("  QR 版本   v{frame_version}（帧流）");
        eprintln!("  块数      {k} 块");
        eprintln!(
            "  总帧数    约 {total_est} 帧（期望） · 文件 {} B{}",
            data.len(),
            if container_gzip {
                format!("（gzip {} → {}）", data.len(), container.len())
            } else {
                String::new()
            }
        );
        eprintln!("  文件名    {name}");
        eprintln!("──────────────────────────────");
        std::io::stdout().flush().ok();

        // 等待空格开始（q 直接退出）
        if !wait_space_or_q() {
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
        eprintln!("\n🚀 开始传输 @ {fps}fps —— 底部输入命令");
        eprintln!("  空格=暂停/继续 · b<块号>=跳块并暂停 · f<帧号>=跳帧并暂停 · N%=跳百分比并暂停 · q=退出");
        let start = std::time::Instant::now();
        let mut seq: u32 = 0;
        // 命令上下文（供 process_cmd / pause_loop 复用）
        let ctx = CmdCtx {
            enc: &enc,
            session_id,
            block_len,
            total_len,
            payload_fnv,
            fps,
            qr_version,
            start,
        };

        loop {
            render_frame(&ctx, seq);

            // 读命令行（有输入才处理，无输入立即返回）
            if let Some(raw_cmd) = read_command_line() {
                let cmd = raw_cmd.trim();
                // 独立空格（未 trim 前 == " "）→ 暂停
                if raw_cmd == " " && cmd.is_empty() {
                    if pause_loop(&ctx, &mut seq) {
                        break;
                    }
                } else if process_cmd(&raw_cmd, &ctx, &mut seq) {
                    break;
                }
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
         \x20 wink <file> [--fps 30] [--block N] [-v<N>]\n\
         \n\
         选项:\n\
         \x20 --fps 1-60   帧率（默认 30）\n\
         \x20 --block N    块长字节（默认按二维码容量自动优化）\n\
         \x20 -v<N>        二维码版本 1-40（如 -v15 / -v20 / -v40，默认自动选最大可容纳）\n\
         \x20 --version    显示版本号\n\
         \n\
         播放中:\n\
         \x20 空格      暂停/继续\n\
         \x20 b<块号>    跳到含该块的帧并暂停（如 b3）\n\
         \x20 f<帧号>    跳到指定帧并暂停（如 f42）\n\
         \x20 <百分比>%  从该百分比位置开始并暂停\n\
         \x20 q          退出\n\
         \n\
         仓库: https://github.com/tsaitang404/wink"
    );
}

fn parse_arg(args: &[String], key: &str, default: u32) -> u32 {
    args.iter()
        .position(|a| a == key)
        .and_then(|i| args.get(i + 1))
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

/// 文件容器：magic WNK1 + compression + nameLen + dataLen + sha256 + data
/// 与 TS packFile 布局兼容（typeLen=0）
/// 压缩判断与 TS 一致：≥768 字节且 gzip 后省 ≥64 字节才启用 compression=1
fn pack_container(data: &[u8], name: &[u8]) -> (Vec<u8>, bool) {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(data);
    let sha = hasher.finalize();

    // 尝试 gzip：≥768 字节且压缩后省 ≥64 字节才用（与 TS packFile 对齐）
    let compressed = if data.len() >= 768 {
        use std::io::Write;
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(data).and_then(|()| enc.finish()).ok()
    } else {
        None
    };
    let use_gzip = compressed
        .as_ref()
        .is_some_and(|c| c.len() + 64 < data.len());
    let transmitted: &[u8] = match (&compressed, use_gzip) {
        (Some(c), true) => c,
        _ => data,
    };

    let mut out = Vec::with_capacity(49 + name.len() + transmitted.len());
    out.extend_from_slice(&[0x57, 0x4e, 0x4b, 0x31]); // WNK1
    out.push(u8::from(use_gzip)); // compression 0=none 1=gzip
    out.extend_from_slice(&(name.len() as u16).to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // typeLen = 0
    out.extend_from_slice(&(data.len() as u32).to_le_bytes()); // originalSize
    out.extend_from_slice(&(transmitted.len() as u32).to_le_bytes()); // transmittedSize
    out.extend_from_slice(sha.as_slice()); // SHA-256（对原始 data 计算）
    out.extend_from_slice(name);
    out.extend_from_slice(transmitted);
    (out, use_gzip)
}

/// 元信息帧（manifest）：与 TS packManifest 布局一致
#[allow(clippy::too_many_arguments)]
fn build_manifest_bytes(
    name: &[u8],
    container: &[u8],
    session_id: u16,
    fps: u32,
    block_len: usize,
    qr_version: u32,
    compression: bool,
    original_size: u32,
) -> Vec<u8> {
    let k = container.len().div_ceil(block_len).max(1);
    let est = (k as u64 * 115 / 100).div_ceil(u64::from(fps)) as u32;
    let mut out = Vec::with_capacity(36 + name.len());
    out.extend_from_slice(&[0x57, 0x4e, 0x4b, 0x4d]); // WNKM
    out.push(1); // version
    out.push(0); // payloadType file
    out.push(u8::from(compression)); // compression（与容器一致，0=none 1=gzip）
    out.push(0); // codec 黑白
    out.extend_from_slice(&(name.len() as u16).to_le_bytes());
    out.extend_from_slice(&original_size.to_le_bytes()); // originalSize（原始文件大小）
    out.extend_from_slice(&(container.len() as u32).to_le_bytes()); // transmittedSize（传输大小）
    out.extend_from_slice(&(k as u16).to_le_bytes());
    out.extend_from_slice(&(block_len as u16).to_le_bytes());
    out.extend_from_slice(&session_id.to_le_bytes());
    // qrVersion：帧流实际使用的 QR 版本（-v 指定或终端自适应）
    out.extend_from_slice(&(qr_version as u16).to_le_bytes());
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
    // 进度条（与 web 一致）：seq 到总帧数后循环，进度按当前周期
    let cycle = seq % need.max(1);
    let pct = (f64::from(cycle) / f64::from(need.max(1))) * 100.0;
    const W: usize = 20;
    let filled = ((pct / 100.0) * W as f64).round() as usize;
    let bar: String = (0..W).map(|i| if i < filled { '█' } else { '░' }).collect();
    eprintln!(
        "\x1b[Kwink · 帧 {cycle}/{need} · {bar} {pct:3.0}% · K={k} · 需求≈{need} · {fps}fps · {secs}s · 按 q 停止"
    );
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

thread_local! {
    /// 跨调用累积的输入缓冲（慢速输入拼接）
    static INPUT_BUF: std::cell::RefCell<String> = const { std::cell::RefCell::new(String::new()) };
}

/// 当前输入缓冲内容（回显用：渲染状态行时显示 `wink> <缓冲>`）
fn input_preview() -> String {
    INPUT_BUF.with(|cell| cell.borrow().clone())
}

/// 非阻塞读整行命令（raw mode 下逐字符读入，Enter 提交）
/// 返回 None = 无完整行；Some(line) = 收到完整命令行
/// 底部固定一行输入行：`wink> `
/// 跨调用累积缓冲：慢速输入（字符间停顿）不会被拆碎消费
#[allow(unsafe_code)]
fn read_command_line() -> Option<String> {
    use std::os::fd::AsRawFd;
    let fd = std::io::stdin().as_raw_fd();
    let mut fds = [libc::pollfd {
        fd,
        events: libc::POLLIN,
        revents: 0,
    }];
    let r = unsafe { libc::poll(fds.as_mut_ptr(), 1, 0) };
    if r <= 0 {
        return None;
    }
    // 读入可用数据，追加到跨调用累积缓冲（慢速输入不被拆碎）
    let mut buf = [0u8; 64];
    let n = unsafe { libc::read(fd, buf.as_mut_ptr() as *mut libc::c_void, buf.len()) };
    if n <= 0 {
        return None;
    }
    INPUT_BUF.with(|cell| {
        let mut line = cell.borrow_mut();
        for &b in &buf[..n as usize] {
            // 独立空格（累积缓冲为空时按下）→ 立即返回暂停命令
            if b == b' ' && line.is_empty() {
                return Some(" ".to_string());
            }
            if b == b'\n' || b == b'\r' {
                // 完整行：取出并清空缓冲
                let out = std::mem::take(&mut *line);
                return Some(out);
            }
            if b == 0x7f || b == 8 {
                // 退格
                line.pop();
            } else {
                line.push(b as char);
            }
        }
        None // 未凑成完整行：留在缓冲，下次继续累积
    })
}

/// 命令上下文：帧渲染所需参数集合
struct CmdCtx<'a> {
    enc: &'a LTEncoder,
    session_id: u16,
    block_len: usize,
    total_len: u32,
    payload_fnv: u32,
    fps: u32,
    qr_version: Option<u32>,
    start: std::time::Instant,
}

/// 渲染指定帧到备用屏（光标归位覆盖，不滚动）+ 底部输入回显行
fn render_frame(ctx: &CmdCtx, seq: u32) {
    let block = ctx.enc.encode(seq);
    let header = FrameHeader {
        session_id: ctx.session_id,
        seq,
        k: ctx.enc.k as u16,
        block_len: ctx.block_len as u16,
        total_len: ctx.total_len,
        payload_fnv: ctx.payload_fnv,
    };
    let frame = pack_frame(&header, &block);
    let (ansi, _v) = qr::render_ansi(&frame, 2, ctx.qr_version);
    print!("\x1b[H{ansi}");
    print_status(seq, ctx.enc.k, ctx.fps, ctx.start.elapsed());
    // 输入回显：状态行下一行显示 `wink> <当前输入>`（打字可见）
    print!("\x1b[K  wink> {}\r", input_preview());
    std::io::stdout().flush().ok();
}

/// 跳转命令（b/f/%）：设 seq、渲染目标帧、进入暂停
/// 返回 true = 应退出
fn jump_and_pause(ctx: &CmdCtx, seq: &mut u32, target: u32, msg: &str) -> bool {
    *seq = target;
    render_frame(ctx, target);
    eprintln!("\x1b[K⏭ {msg} —— 空格继续或输入命令");
    pause_loop(ctx, seq)
}

/// 暂停循环：保持当前帧。空格/回车继续；q 退出；其他命令照常执行（跳转后保持暂停）
/// 返回 true = 应退出
#[allow(unsafe_code)]
fn pause_loop(ctx: &CmdCtx, seq: &mut u32) -> bool {
    eprintln!("\x1b[K⏸ 已暂停 —— 空格继续 · 命令照常可用（b/f/%/q）");
    loop {
        // 暂停中也刷新输入回显
        render_frame(ctx, *seq);
        match read_command_line() {
            Some(c) if c.trim() == " " || c.trim() == "p" || c.trim().is_empty() => {
                eprintln!("\x1b[K🚀 继续传输");
                return false;
            }
            Some(c) if c.trim() == "q" => return true,
            Some(raw) => {
                if process_cmd(&raw, ctx, seq) {
                    return true;
                }
            }
            None => std::thread::sleep(std::time::Duration::from_millis(50)),
        }
    }
}

/// 处理一行命令。返回 true = 应退出
/// 支持：b<块号> / f<帧号> / N% / q / 未知命令提示
fn process_cmd(raw_cmd: &str, ctx: &CmdCtx, seq: &mut u32) -> bool {
    let cmd = raw_cmd.trim();
    if cmd == "q" {
        return true;
    }
    if let Some(bs) = cmd.strip_prefix('b') {
        // 块跳转：b<块号>
        if let Ok(b) = bs.trim().parse::<usize>() {
            let s = ctx
                .enc
                .find_deg1_seq(b, *seq, 8192)
                .or_else(|| ctx.enc.find_any_seq(b, *seq, 65536));
            if let Some(s) = s {
                return jump_and_pause(ctx, seq, s, &format!("已显示块 #{b} 的帧 {s}"));
            }
            eprintln!("\x1b[K⚠️ 块 #{b} 在 65536 帧内找不到任何包含它的帧");
        }
        return false;
    }
    if let Some(p) = cmd.strip_suffix('%') {
        // 百分比跳转
        if let Ok(pct) = p.trim().parse::<u32>() {
            let total_est = (ctx.enc.k as u64 * 115 / 100) as u32;
            let target = (total_est.saturating_mul(pct) / 100).max(1);
            return jump_and_pause(ctx, seq, target, &format!("已显示 {pct}%（帧 {target}）"));
        }
        return false;
    }
    if let Some(fs) = cmd.strip_prefix('f') {
        // 帧跳转：f<帧号>
        if let Ok(n) = fs.trim().parse::<u32>() {
            return jump_and_pause(ctx, seq, n, &format!("已显示帧 {n}"));
        }
        return false;
    }
    // 未知命令提示
    eprintln!("\x1b[K⚠️ 未知命令: {cmd} —— 空格暂停 · b<块号> · f<帧号> · N% · q 退出");
    false
}

/// 等待空格（返回 true）或 q（返回 false）。raw mode 单键。
#[allow(unsafe_code)]
fn wait_space_or_q() -> bool {
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

/// 终端列数（TIOCGWINSZ），失败返回 None
#[allow(unsafe_code)]
fn terminal_cols() -> Option<u16> {
    use std::os::fd::AsRawFd;
    let fd = std::io::stdout().as_raw_fd();
    let mut ws = libc::winsize {
        ws_row: 0,
        ws_col: 0,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    let r = unsafe { libc::ioctl(fd, libc::TIOCGWINSZ, &raw mut ws) };
    if r == 0 && ws.ws_col > 0 {
        Some(ws.ws_col)
    } else {
        None
    }
}

/// QR 版本 → byte mode ECC L 容量（标准表 v1-v40，与 TS `QR_CAPACITY` 一致）
fn qr_capacity_l(version: usize) -> usize {
    const CAP: [usize; 40] = [
        17, 32, 53, 78, 106, 134, 154, 192, 230, 271, 321, 367, 425, 458, 520, 586, 644, 718, 792,
        858, 929, 1003, 1091, 1171, 1273, 1367, 1465, 1528, 1628, 1732, 1840, 1952, 2068, 2188,
        2303, 2431, 2563, 2699, 2809, 2953,
    ];
    CAP.get(version.saturating_sub(1).min(39))
        .copied()
        .unwrap_or(2953)
}
