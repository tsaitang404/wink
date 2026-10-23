// QR 版本 → byte mode / ECC L 容量（标准表 v1-v40）
//
// 两处用途：
// - 帧流发送端按选定版本计算 blockLen（sender-web / sender-cli）
// - 短文本直发：判断一个二维码能否装下 WNKT 容器，能装就直接显示单码
//
// 数值与 qrcode 库的 byte mode 容量逐字节一致（tests/single-qr.test.ts 锁定边界）。

export const QR_CAPACITY_L: readonly number[] = [
  17, 32, 53, 78, 106, 134, 154, 192, 230, 271, 321, 367, 425, 458, 520, 586, 644, 718, 792, 858,
  929, 1003, 1091, 1171, 1273, 1367, 1465, 1528, 1628, 1732, 1840, 1952, 2068, 2188, 2303, 2431,
  2563, 2699, 2809, 2953,
];

/** 指定版本的 byte mode 容量；非法版本返回 0 */
export function qrCapacity(version: number): number {
  if (!Number.isInteger(version) || version < 1 || version > 40) return 0;
  return QR_CAPACITY_L[version - 1]!;
}

/**
 * 能装下 byteLength 字节的最小 QR 版本（1-40）。
 * 超过 v40 容量（2953B）返回 null —— 调用方应降级到喷泉码帧流。
 */
export function smallestQrVersion(byteLength: number): number | null {
  if (byteLength < 0) return null;
  for (let version = 1; version <= 40; version++) {
    if (QR_CAPACITY_L[version - 1]! >= byteLength) return version;
  }
  return null;
}
