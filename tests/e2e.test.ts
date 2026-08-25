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

describe('容器魔数区分 (WNK1 vs WNKT)', () => {
  it('文件容器 WNK1 不会被误判为文本 WNKT', async () => {
    const data = new Uint8Array(256).map((_, i) => i & 0xff);
    const packed = await packFile('test.bin', 'application/octet-stream', data);
    const container = packed.container;
    assert.equal(container[0], 0x57);
    assert.equal(container[1], 0x4e);
    assert.equal(container[2], 0x4b);
    assert.equal(container[3], 0x31); // 1, not T
    assert.throws(() => unpackSnippet(container), /Not a text container/);
  });

  it('文本容器 WNKT 不能被 unpackFile 解析', async () => {
    const text = 'hello';
    const snip = packSnippet(text);
    assert.equal(snip[0], 0x57);
    assert.equal(snip[1], 0x4e);
    assert.equal(snip[2], 0x4b);
    assert.equal(snip[3], 0x54); // T, not 1
    await assert.rejects(() => unpackFile(snip));
  });

  it('仅前2字节匹配不够——WNK1和WNKT前3字节相同', async () => {
    const fileData = new Uint8Array(64).map((_, i) => i);
    const fileContainer = (await packFile('a.bin', 'application/octet-stream', fileData)).container;
    const textContainer = packSnippet('hi');
    assert.equal(fileContainer[0], textContainer[0]);
    assert.equal(fileContainer[1], textContainer[1]);
    assert.equal(fileContainer[2], textContainer[2]);
    assert.notEqual(fileContainer[3], textContainer[3]); // 1 vs T
  });

  it('文件通过 LT 编解码后正确识别为文件（非文本）', async () => {
    const data = new Uint8Array(512).map((_, i) => (i * 7) & 0xff);
    const packed = await packFile('data.bin', 'application/octet-stream', data);
    const { decoder, assembled } = roundtripLT(packed.container, 256, 88);
    assert.ok(decoder.isComplete);
    assert.equal(assembled[0], 0x57);
    assert.equal(assembled[3], 0x31);
    const unpacked = await unpackFile(assembled);
    assert.ok(await verifyFile(unpacked));
    assert.deepEqual(unpacked.bytes, data);
  });

  it('文本通过 LT 编解码后正确识别为文本（非文件）', () => {
    const text = 'LT roundtrip text';
    const snip = packSnippet(text);
    const { decoder, assembled } = roundtripLT(snip, 128, 99);
    assert.ok(decoder.isComplete);
    assert.equal(assembled[0], 0x57);
    assert.equal(assembled[3], 0x54);
    assert.equal(unpackSnippet(assembled), text);
  });
});

describe('文本容器边界', () => {
  it('空文本 roundtrip', () => {
    const snip = packSnippet('');
    assert.equal(unpackSnippet(snip), '');
  });

  it('长文本 roundtrip (10KB)', () => {
    const text = 'A'.repeat(10000);
    const snip = packSnippet(text);
    assert.equal(unpackSnippet(snip), text);
  });

  it('Unicode 特殊字符', () => {
    const text = '🎉🔥💀';
    const snip = packSnippet(text);
    assert.equal(unpackSnippet(snip), text);
  });

  it('过短数据抛出异常', () => {
    assert.throws(() => unpackSnippet(new Uint8Array([0x57, 0x4e])), /too short/);
  });

  it('魔数不匹配抛出异常', () => {
    const bad = new Uint8Array(16);
    bad[0] = 0x00;
    assert.throws(() => unpackSnippet(bad), /Not a text container/);
  });
});
