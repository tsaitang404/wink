// wink 终端 QR 渲染：qrcode crate → ANSI 半块字符

#![allow(
    clippy::panic,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss
)]

use qrcode::{bits::Bits, types::EcLevel, QrCode, Version};

/// 把 payload 编码为 QR 并渲染成 ANSI 半块字符（黑白）
/// `version_hint`：Some(v) 强制指定版本（1-40），None 自动选最小
/// 强制 byte mode 单段（与 JS 端 qrSegments 一致）——避免 qrcode crate 的
/// `push_optimal_data` 自动分段（随机二进制会被拆成多段，段头 4+16 bits 开销
/// 在容量边界触发 DataTooLong，实测 12/300 帧失败）
/// 返回 (字符串行, 使用的 QR 版本号)
#[must_use]
pub fn render_ansi(payload: &[u8], quiet_zone: usize, version_hint: Option<u32>) -> (String, u32) {
    let code = match version_hint {
        Some(v) if (1..=40).contains(&v) => {
            let mut bits = Bits::new(Version::Normal(v as i16));
            match bits
                .push_byte_data(payload)
                .and_then(|()| bits.push_terminator(EcLevel::L))
                .and_then(|()| QrCode::with_bits(bits, EcLevel::L))
            {
                Ok(c) => c,
                // 指定版本装不下（payload 超容量）→ 回退自动版本，不 panic
                Err(_) => encode_auto(payload),
            }
        }
        _ => encode_auto(payload),
    };
    let version = match code.version() {
        Version::Normal(v) | Version::Micro(v) => v as u32,
    };
    let modules = code.to_colors();
    let size = code.width();
    // 半块字符：每 2 行模块合成 1 行终端输出
    let mut out = String::new();
    let rows = (size + 2 * quiet_zone).div_ceil(2);
    for r in 0..rows {
        for c in 0..(size + 2 * quiet_zone) {
            let top = module_at(&modules, size, c, r * 2, quiet_zone);
            let bottom = module_at(&modules, size, c, r * 2 + 1, quiet_zone);
            let ch = match (top, bottom) {
                (true, true) => '█',   // 上黑下黑
                (true, false) => '▀',  // 上黑下白
                (false, true) => '▄',  // 上白下黑
                (false, false) => ' ', // 上白下白
            };
            out.push(ch);
        }
        out.push('\n');
    }
    (out, version)
}

/// 多码网格渲染：N 个 payload 按 `cols×rows` 网格拼接
/// 每码 `render_ansi` 得到行数组，同行拼接（右补空格对齐），行间留空行（quiet zone）
/// 返回 `(整屏字符串, 使用的版本)`（版本取第一个码的）
pub fn render_grid_ansi(
    payloads: &[&[u8]],
    quiet_zone: usize,
    version_hint: Option<u32>,
    cols: usize,
    rows: usize,
) -> (String, u32) {
    // 每码渲染成行数组
    let mut codes: Vec<(Vec<String>, u32)> = payloads
        .iter()
        .map(|p| {
            let (ansi, v) = render_ansi(p, quiet_zone, version_hint);
            let lines: Vec<String> = ansi
                .trim_end_matches('\n')
                .split('\n')
                .map(String::from)
                .collect();
            (lines, v)
        })
        .collect();
    // 统一行宽（最宽码为准，右补空格）
    let max_w = codes
        .iter()
        .map(|(l, _)| l.iter().map(String::len).max().unwrap_or(0))
        .max()
        .unwrap_or(0);
    for (lines, _) in &mut codes {
        for l in lines {
            if l.len() < max_w {
                l.push_str(&" ".repeat(max_w - l.len()));
            }
        }
    }
    // 网格拼接：每行内横向拼 cols 个码的对应行，行间留 1 空行
    let mut out = String::new();
    let gap_w = quiet_zone; // 码间距（空格列）
    for r in 0..rows {
        let mut row_lines: Vec<Vec<String>> = Vec::new();
        for c in 0..cols {
            let idx = r * cols + c;
            let lines = codes.get(idx).map(|(l, _)| l.clone()).unwrap_or_default();
            row_lines.push(lines);
        }
        let height = row_lines.iter().map(Vec::len).max().unwrap_or(0);
        for i in 0..height {
            let mut line = String::new();
            for (c, l) in row_lines.iter().enumerate() {
                if c > 0 {
                    line.push_str(&" ".repeat(gap_w));
                }
                line.push_str(l.get(i).map_or("", String::as_str));
            }
            out.push_str(&line);
            out.push('\n');
        }
        // 行间空行（码间距，半块字符 2 行 = 4 模块）
        if r + 1 < rows {
            out.push('\n');
        }
    }
    let version = codes.first().map_or(0, |(_, v)| *v);
    (out, version)
}

/// 自动选最小版本 + 强制 byte 单段
fn encode_auto(payload: &[u8]) -> QrCode {
    for v in 1..=40u16 {
        let mut bits = Bits::new(Version::Normal(v.cast_signed()));
        if let Ok(code) = bits
            .push_byte_data(payload)
            .and_then(|()| bits.push_terminator(EcLevel::L))
            .and_then(|()| QrCode::with_bits(bits, EcLevel::L))
        {
            return code;
        }
    }
    panic!("payload too large for any QR version")
}

fn module_at(
    modules: &[qrcode::Color],
    size: usize,
    x: usize,
    y: usize,
    quiet_zone: usize,
) -> bool {
    if x < quiet_zone || y < quiet_zone || x >= size + quiet_zone || y >= size + quiet_zone {
        return false; // 安静区白色
    }
    let mx = x - quiet_zone;
    let my = y - quiet_zone;
    if mx >= size || my >= size {
        return false;
    }
    modules[my * size + mx] == qrcode::Color::Dark
}
