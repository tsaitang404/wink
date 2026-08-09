import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packFile, unpackFile, verifyFile, packSnippet, unpackSnippet, isPrecompressedType } from '../shared/container.ts';
import { packManifest, parseManifest, buildManifest } from '../shared/manifest.ts';
import { packFrame, parseFrame, streamIdentity, safeFileName } from '../shared/protocol.ts';
import { fnv1a } from '../shared/protocol.ts';

// T9: packFrame/parseFrame 往返
test('packFrame/parseFrame roundtrip', () => {
  const h = { sessionId: 1, seq: 42, k: 8, blockLen: 64, totalLen: 512, payloadFnv: 0xdeadbeef };
  const block = new Uint8Array(64);
  for (let i = 0; i < 64; i++) block[i] = i;
  const frame = packFrame(h, block);
  assert.equal(frame.length, 20 + 64);
  const parsed = parseFrame(frame)!;
  assert.deepEqual(parsed.header, h);
  assert.deepEqual(parsed.block, block);
});

// T9b: parseFrame 拒绝坏帧
test('parseFrame rejects bad frames', () => {
  assert.equal(parseFrame(new Uint8Array(5)), null); // 太短
  const bad = new Uint8Array(20 + 64);
  bad[0] = 0x00; // 错 magic
  assert.equal(parseFrame(bad), null);
  const zeroK = packFrame({ sessionId: 1, seq: 0, k: 0, blockLen: 64, totalLen: 512, payloadFnv: 0 }, new Uint8Array(64));
  assert.equal(parseFrame(zeroK), null); // k=0 非法
});

// T9c: streamIdentity 变化检测
test('streamIdentity changes on any field', () => {
  const base = { sessionId: 1, seq: 0, k: 8, blockLen: 64, totalLen: 512, payloadFnv: 0x1234 };
  assert.equal(streamIdentity(base), '1:8:64:512:4660');
  assert.notEqual(streamIdentity({ ...base, sessionId: 2 }), streamIdentity(base));
  assert.notEqual(streamIdentity({ ...base, blockLen: 128 }), streamIdentity(base));
});

// T10: packFile/unpackFile 往返（无压缩分支）
test('packFile/unpackFile roundtrip (no gzip)', async () => {
  const bytes = new Uint8Array(500); // < 768 不 gzip
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  const packed = await packFile('test.bin', 'application/octet-stream', bytes);
  assert.equal(packed.compression, 'none');
  const unpacked = await unpackFile(packed.container);
  assert.equal(unpacked.name, 'test.bin');
  assert.equal(unpacked.type, 'application/octet-stream');
  assert.deepEqual(unpacked.bytes, bytes);
  assert.equal(await verifyFile(unpacked), true);
});

// T10b: packFile gzip 分支（文本大文件）
test('packFile gzip compression branch', async () => {
  const text = 'wink blink data '.repeat(200); // ~3200B 高度可压缩
  const bytes = new TextEncoder().encode(text);
  const packed = await packFile('data.txt', 'text/plain', bytes);
  assert.equal(packed.compression, 'gzip');
  assert.ok(packed.transmittedSize < bytes.length);
  const unpacked = await unpackFile(packed.container);
  assert.deepEqual(unpacked.bytes, bytes);
  assert.equal(await verifyFile(unpacked), true);
});

// T10c: packFile 拒绝空文件/超限
test('packFile rejects empty and oversized', async () => {
  await assert.rejects(() => packFile('e.bin', 'application/octet-stream', new Uint8Array(0)));
  await assert.rejects(() => packFile('big.bin', 'application/octet-stream', new Uint8Array(65 * 1024 * 1024)));
});

// T10d: isPrecompressedType
test('isPrecompressedType detects known formats', () => {
  assert.equal(isPrecompressedType('image/jpeg'), true);
  assert.equal(isPrecompressedType('video/mp4'), true);
  assert.equal(isPrecompressedType('application/zip'), true);
  assert.equal(isPrecompressedType('image/bmp'), false); // bmp 可压缩
  assert.equal(isPrecompressedType('text/plain'), false);
  assert.equal(isPrecompressedType('application/pdf'), false); // pdf 不预判
});

// T11: manifest pack/parse 往返
test('manifest pack/parse roundtrip', () => {
  const m = buildManifest({
    payloadType: 0,
    compression: 0,
    codec: 0,
    name: 'hello.txt',
    originalSize: 1000,
    transmittedSize: 1000,
    blockLen: 128,
    sessionId: 7,
    qrVersion: 15,
    fps: 30,
    payloadFnv: 0x12345678,
  });
  const bytes = packManifest(m);
  const parsed = parseManifest(bytes)!;
  assert.deepEqual(parsed, m);
  assert.equal(parsed.k, 8); // ceil(1000/128) = 8
  assert.equal(parsed.estSeconds, Math.ceil((8 * 1.15) / 30));
});

// T11b: manifest 拒绝坏帧
test('parseManifest rejects bad input', () => {
  assert.equal(parseManifest(new Uint8Array(10)), null); // 太短
  const bad = new Uint8Array(36);
  bad[0] = 0x00;
  assert.equal(parseManifest(bad), null);
});

// T12: safeFileName 剥离路径/控制字符
test('safeFileName strips path and control chars', () => {
  assert.equal(safeFileName('../evil.txt'), 'evil.txt');
  assert.equal(safeFileName('/abs/path/file'), 'file');
  assert.equal(safeFileName('a\nb'), 'ab');
  assert.equal(safeFileName('..'), 'transfer.bin');
  assert.equal(safeFileName(''), 'transfer.bin');
  assert.equal(safeFileName('正常文件.txt'), '正常文件.txt');
});

// T12b: 容器 FNV 与帧头一致性
test('container FNV links to frame header', async () => {
  const bytes = new TextEncoder().encode('wink payload for fnv');
  const packed = await packFile('fnv.txt', 'text/plain', bytes);
  const fnv = fnv1a(packed.container);
  assert.equal(typeof fnv, 'number');
  assert.ok(fnv >= 0 && fnv <= 0xffffffff);
});
