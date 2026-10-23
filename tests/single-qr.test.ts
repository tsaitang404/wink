// 短文本单码直发：容量判断 + 接收端载荷分类
//
// 回归重点：
// 1. WNK1 / WNKT 与帧头首字节都是 'W'，必须按完整 4 字节魔数分类
// 2. 容量表必须与 qrcode 库的实际 byte mode 边界一致，否则“能装下”会误判

import { test } from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';
import { readBarcodes } from 'zxing-wasm/full';
import { packFile, packSnippet, unpackSnippet } from '../shared/container.ts';
import {
  FILE_MAGIC,
  HEADER_LEN,
  TEXT_MAGIC,
  classifyPayload,
  hasMagic,
  packFrame,
} from '../shared/protocol.ts';
import { buildManifest, packManifest } from '../shared/manifest.ts';
import { qrCapacity, smallestQrVersion } from '../shared/qr-capacity.ts';

function qrAt(bytes: Uint8Array, version: number) {
  return QRCode.create([{ data: bytes, mode: 'byte' }], {
    version,
    errorCorrectionLevel: 'L',
  });
}

test('容量表锚点与 v1-v40 边界一致', () => {
  assert.equal(qrCapacity(1), 17);
  assert.equal(qrCapacity(15), 520);
  assert.equal(qrCapacity(27), 1465);
  assert.equal(qrCapacity(40), 2953);
  assert.equal(qrCapacity(0), 0);
  assert.equal(qrCapacity(41), 0);

  assert.equal(smallestQrVersion(0), 1);
  assert.equal(smallestQrVersion(17), 1);
  assert.equal(smallestQrVersion(18), 2);
  assert.equal(smallestQrVersion(520), 15);
  assert.equal(smallestQrVersion(521), 16);
  assert.equal(smallestQrVersion(2953), 40);
  assert.equal(smallestQrVersion(2954), null);
});

test('选中的版本恰好装得下容量边界，多 1 字节就装不下', () => {
  for (const version of [1, 15, 16, 27, 40]) {
    const cap = qrCapacity(version);
    assert.equal(smallestQrVersion(cap), version, `cap(${version}) 应落在 v${version}`);
    assert.doesNotThrow(() => qrAt(new Uint8Array(cap), version), `v${version} 容量应可编码`);
    assert.throws(() => qrAt(new Uint8Array(cap + 1), version), `v${version} 超 1 字节应拒绝`);
    if (version < 40) {
      assert.equal(smallestQrVersion(cap + 1), version + 1);
    }
  }
});

test('短文本 WNKT 容器可装进单张二维码', () => {
  const snip = packSnippet('你好 wink 🎉');
  assert.equal(classifyPayload(snip), 'text');
  const version = smallestQrVersion(snip.length);
  assert.ok(version !== null, `容器 ${snip.length}B 应装得下`);
  assert.doesNotThrow(() => qrAt(snip, version));
});

async function roundtripSingleQr(text: string) {
  const snip = packSnippet(text);
  const version = smallestQrVersion(snip.length);
  assert.ok(version !== null, `容器 ${snip.length}B 应装得下`);
  const png = await QRCode.toBuffer([{ data: snip, mode: 'byte' }], {
    version,
    errorCorrectionLevel: 'L',
    width: 640,
    margin: 4,
    type: 'png',
  });
  const results = await readBarcodes(new Uint8Array(png), {
    formats: ['QRCode'],
    tryHarder: true,
  });
  assert.equal(results.length, 1, '应解出 1 个二维码');
  const decoded = results[0]!.bytes;
  return { decoded, version, snip };
}

test('短文本单码端到端：编码 → zxing 解码 → 文本还原', async () => {
  const text = '你好 wink 🎉 https://example.com/?q=1';
  const { decoded, version } = await roundtripSingleQr(text);
  assert.equal(classifyPayload(decoded), 'text');
  assert.equal(unpackSnippet(decoded), text);
  assert.ok(version! <= 15, `短文本应使用小码，实际 v${version}`);
});

test('恰好填满 v15 的文本也能单码还原', async () => {
  const text = 'x'.repeat(qrCapacity(15) - 8);
  const { decoded, version, snip } = await roundtripSingleQr(text);
  assert.equal(snip.length, qrCapacity(15));
  assert.equal(version, 15);
  assert.equal(classifyPayload(decoded), 'text');
  assert.equal(unpackSnippet(decoded), text);
});

test('超过单码容量的文本降级到帧流', () => {
  const snip = packSnippet('A'.repeat(3000));
  assert.equal(snip.length, 8 + 3000);
  assert.equal(smallestQrVersion(snip.length), null);
});

test('完整魔数分类：WNK1 / WNKT 不会被误判为 manifest 或 frame', async () => {
  const file = (await packFile('a.bin', 'application/octet-stream', new Uint8Array(64).fill(7)))
    .container;
  const longText = packSnippet('a'.repeat(100));
  const shortText = packSnippet('hi');

  // 两个容器都 > 20 字节，能暴露“只看前 2 字节 / 提前 return”的旧问题
  for (const bytes of [file, longText]) assert.ok(bytes.length > HEADER_LEN);

  assert.equal(classifyPayload(file), 'file');
  assert.equal(classifyPayload(longText), 'text');
  assert.equal(classifyPayload(shortText), 'text');
});

test('manifest 与帧流分类保持不变', () => {
  const manifest = buildManifest({
    payloadType: 0,
    compression: 0,
    codec: 0,
    name: 't.txt',
    originalSize: 100,
    transmittedSize: 100,
    blockLen: 100,
    sessionId: 3,
    qrVersion: 15,
    fps: 30,
  });
  assert.equal(classifyPayload(packManifest(manifest)), 'manifest');

  const frame = packFrame(
    { sessionId: 3, seq: 0, k: 2, blockLen: 16, totalLen: 32, payloadFnv: 9 },
    new Uint8Array(16).fill(1),
  );
  assert.equal(classifyPayload(frame), 'frame');

  assert.equal(classifyPayload(new Uint8Array(0)), 'unknown');
  assert.equal(classifyPayload(new Uint8Array(HEADER_LEN + 16)), 'unknown');
  assert.equal(classifyPayload(new Uint8Array([0x57, 0x4e, 0x4b, 0x00])), 'unknown');
});

test('hasMagic 逐字节比较完整魔数', () => {
  const snip = packSnippet('hi');
  assert.equal(hasMagic(snip, TEXT_MAGIC), true);
  assert.equal(hasMagic(snip, FILE_MAGIC), false);
  assert.equal(hasMagic(snip.subarray(0, 3), TEXT_MAGIC), false);
  assert.equal(hasMagic(new Uint8Array(), TEXT_MAGIC), false);
});
