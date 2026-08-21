
import { LTEncoder, LTDecoder } from '../shared/fountain.ts';
import { packFrame, fnv1a, HEADER_LEN } from '../shared/protocol.ts';

const QR_CAPACITY: Record<number, number> = {
  15: 520, 20: 858, 27: 1465, 40: 2953,
};

function bench(label: string, data: Uint8Array, qrVersion: number) {
  const payloadCap = QR_CAPACITY[qrVersion]! - HEADER_LEN;
  const blockLen = Math.max(64, payloadCap);
  const sessionId = 1;
  
  // 编码
  const t0 = performance.now();
  const encoder = new LTEncoder(data, blockLen, sessionId);
  const tEncode = performance.now() - t0;
  
  // 模拟帧编码（sender 每帧做的事）
  const framesNeeded = Math.ceil(encoder.k * 1.15);
  const t1 = performance.now();
  for (let seq = 0; seq < framesNeeded; seq++) {
    const block = encoder.encode(seq);
    packFrame({ sessionId, seq, k: encoder.k, blockLen, totalLen: data.length, payloadFnv: fnv1a(data) }, block);
  }
  const tFrameEncode = performance.now() - t1;
  
  // 解码（receiver 每帧做的事）
  const decoder = new LTDecoder(encoder.k, blockLen, sessionId, data.length);
  const t2 = performance.now();
  let fed = 0;
  for (let seq = 0; seq < framesNeeded; seq++) {
    const block = encoder.encode(seq);
    decoder.addFrame(seq, block);
    fed++;
    if (decoder.isComplete) break;
  }
  const tDecode = performance.now() - t2;
  
  const totalBytes = data.length;
  const senderBps = totalBytes / (tFrameEncode / 1000);
  const receiverBps = totalBytes / (tDecode / 1000);
  const overhead = ((fed / encoder.k - 1) * 100).toFixed(1);
  
  console.log(`${label} | v${qrVersion} | ${totalBytes}B | k=${encoder.k} blockLen=${blockLen}`);
  console.log(`  帧编码: ${tFrameEncode.toFixed(0)}ms (${framesNeeded} 帧) → 发送端 ${senderBps.toFixed(0)} B/s`);
  console.log(`  解码: ${tDecode.toFixed(0)}ms (${fed} 帧) → 接收端 ${receiverBps.toFixed(0)} B/s`);
  console.log(`  冗余: ${overhead}% | 解码完成: ${decoder.isComplete}`);
  console.log();
}

// 测试不同文件大小
const sizes = [1024, 10*1024, 100*1024, 1024*1024];
for (const size of sizes) {
  const data = new Uint8Array(size).map((_, i) => (i * 13 + 7) & 0xff);
  bench(`${size >= 1024*1024 ? '1MB' : size >= 1024 ? (size/1024)+'KB' : size+'B'}`, data, 20);
}
// 不同 QR 版本
const data10k = new Uint8Array(10*1024).map((_, i) => (i * 13 + 7) & 0xff);
for (const v of [15, 20, 27, 40]) {
  bench('10KB@', data10k, v);
}
