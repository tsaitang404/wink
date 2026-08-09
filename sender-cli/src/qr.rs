// wink 终端 QR 渲染：qrcode crate → ANSI 半块字符

#![allow(
    clippy::panic,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss
)]

use qrcode::{EcLevel, QrCode, Version};

/// 把 payload 编码为 QR 并渲染成 ANSI 半块字符（黑白）
/// `version_hint`：Some(v) 强制指定版本（1-40），None 自动选最小
/// 返回 (字符串行, 使用的 QR 版本号)
#[must_use]
pub fn render_ansi(payload: &[u8], quiet_zone: usize, version_hint: Option<u32>) -> (String, u32) {
    let code = match version_hint {
        Some(v) if (1..=40).contains(&v) => {
            QrCode::with_version(payload, Version::Normal(v as i16), EcLevel::L)
                .map_err(|e| format!("payload too large for v{v}: {e}"))
        }
        _ => QrCode::with_error_correction_level(payload, EcLevel::L)
            .map_err(|e| format!("payload too large for any QR version: {e}")),
    }
    .unwrap_or_else(|e| panic!("{e}"));
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
