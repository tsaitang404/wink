import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { packFile, unpackFile, verifyFile, packSnippet, unpackSnippet } from '../shared/container.ts';
import { LTEncoder, LTDecoder } from '../shared/fountain.ts';
import { packFrame, parseFrame, HEADER_LEN, fnv1a } from '../shared/protocol.ts';
import { packManifest, parseManifest } from '../shared/manifest.ts';

function roundtripLT(data: Uint8Array, blockLen: number, sessionId: number) {
  const encoder = new LTEncoder(data, blockLen, sessionId);
  const decoder = new LTDecoder(encoder.k, blockLen, sessionId, data.length);
  const framesNeeded = Math.ceil(encoder.k * 1.15);
  for (let seq = 0; seq < framesNeeded + 100; seq++) {
    const block = encoder.encode(seq);
    const frame = packFrame({ sessionId, seq, k: encoder.k, blockLen, totalLen: data.length, payloadFnv: fnv1a(data) }, block);
    const parsed = parseFrame(frame);
    if (parsed) decoder.addFrame(parsed.header.seq, parsed.block);
  }
  return { encoder, decoder, assembled: decoder.assemble()! };
}

describe('文件容器', () => {
  it('packFile/unpackFile roundtrip', async () => {
    const data = new Uint8Array(1024).map((_, i) => i & 0xff);
    const packed = await packFile('test.bin', 'application/octet-stream', data);
    const unpacked = await unpackFile(packed.container);
    assert.ok(await verifyFile(unpacked), 'SHA-256 校验通过');
    assert.equal(unpacked.name, 'test.bin');
    assert.equal(unpacked.bytes.length, data.length);
    assert.deepEqual(unpacked.bytes, data);
  });

  it('大文件 roundtrip (100KB)', async () => {
    const data = new Uint8Array(100 * 1024).map((_, i) => (i * 13 + 7) & 0xff);
    const packed = await packFile('big.bin', 'application/octet-stream', data);
    const unpacked = await unpackFile(packed.container);
    assert.ok(await verifyFile(unpacked));
    assert.deepEqual(unpacked.bytes, data);
  });
});

describe('文本容器', () => {
  it('packSnippet/unpackSnippet roundtrip', () => {
    const text = '你好世界 Hello wink 🎉';
    const snip = packSnippet(text);
    assert.equal(snip[0], 0x57); // W
    assert.equal(snip[3], 0x54); // T
    assert.equal(unpackSnippet(snip), text);
  });
});

describe('LT 喷泉码', () => {
  it('小文件 (1KB) 编解码', () => {
    const data = new Uint8Array(1024).map((_, i) => (i * 37) & 0xff);
    const { decoder, assembled } = roundtripLT(data, 256, 42);
    assert.ok(decoder.isComplete);
    assert.equal(assembled.length, data.length);
    assert.deepEqual(assembled, data);
  });

  it('大文件 (100KB) 编解码', () => {
    const data = new Uint8Array(100 * 1024).map((_, i) => (i * 13 + 7) & 0xff);
    const { decoder, assembled } = roundtripLT(data, 512, 123);
    assert.ok(decoder.isComplete);
    assert.equal(assembled.length, data.length);
    assert.deepEqual(assembled, data);
  });

  it('文本通过 LT 编解码', () => {
    const text = '这是一段测试文本，用于验证文本片段通过 LT 喷泉码编解码的正确性。';
    const snip = packSnippet(text);
    const { decoder, assembled } = roundtripLT(snip, 128, 77);
    assert.ok(decoder.isComplete);
    // 解码后是 WNKT 容器
    assert.equal(assembled[0], 0x57);
    assert.equal(assembled[3], 0x54);
    assert.equal(unpackSnippet(assembled), text);
  });

  it('丢帧 20% 仍能解码', () => {
    const data = new Uint8Array(2048).map((_, i) => i & 0xff);
    const encoder = new LTEncoder(data, 256, 55);
    const decoder = new LTDecoder(encoder.k, 256, 55, data.length);
    const framesNeeded = Math.ceil(encoder.k * 1.15);
    let fed = 0;
    for (let seq = 0; seq < framesNeeded + 200; seq++) {
      if (seq % 5 === 0) continue; // 丢 20% 帧
      const block = encoder.encode(seq);
      const frame = packFrame({ sessionId: 55, seq, k: encoder.k, blockLen: 256, totalLen: data.length, payloadFnv: fnv1a(data) }, block);
      const parsed = parseFrame(frame);
      if (parsed) { decoder.addFrame(parsed.header.seq, parsed.block); fed++; }
    }
    assert.ok(decoder.isComplete, `丢帧后仍解码完成 (fed ${fed} frames)`);
    assert.deepEqual(decoder.assemble(), data);
  });
});

describe('Manifest', () => {
  it('pack/parse roundtrip', () => {
    const m = {
      version: 1, payloadType: 0 as 0 | 1, compression: 0 as 0 | 1, codec: 0 as const,
      name: 'test.txt', originalSize: 1024, transmittedSize: 1024,
      k: 10, blockLen: 100, sessionId: 42, qrVersion: 20,
      fps: 30, estSeconds: 4, payloadFnv: 12345,
    };
    const bytes = packManifest(m);
    const parsed = parseManifest(bytes);
    assert.ok(parsed);
    assert.equal(parsed.name, 'test.txt');
    assert.equal(parsed.k, 10);
    assert.equal(parsed.qrVersion, 20);
    assert.equal(parsed.fps, 30);
  });
});

describe('帧协议', () => {
  it('packFrame/parseFrame roundtrip', () => {
    const block = new Uint8Array(100).map((_, i) => i);
    const header = { sessionId: 99, seq: 42, k: 10, blockLen: 100, totalLen: 1000, payloadFnv: 5555 };
    const frame = packFrame(header, block);
    assert.equal(frame[0], 0x57);
    assert.equal(frame.length, HEADER_LEN + 100);
    const parsed = parseFrame(frame);
    assert.ok(parsed);
    assert.equal(parsed.header.sessionId, 99);
    assert.equal(parsed.header.seq, 42);
    assert.deepEqual(parsed.block, block);
  });
});
