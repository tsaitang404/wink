import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dlog, solitonCdf, frameIndices, LTEncoder, LTDecoder } from '../shared/fountain.ts';
import { splitmix32, fnv1a } from '../shared/protocol.ts';

// T1: dlog 固定值（确定性 ln，防 libm 偏差）
test('dlog matches known values', () => {
  const cases: [number, number][] = [
    [1, 0],
    [2, 0.6931471805599453],
    [Math.E, 1], // dlog 精度到位：ln(e) = 1.0000000000000002 → 1
  ];
  for (const [x, expected] of cases) {
    assert.equal(dlog(x), expected);
  }
  // 与 Math.log 在几位内一致（但不用它实现）
  for (const x of [0.5, 1.5, 10, 100, 0.25]) {
    assert.ok(Math.abs(dlog(x) - Math.log(x)) < 1e-12, `dlog(${x})`);
  }
});

// T2: solitonCdf k=1
test('solitonCdf k=1 returns [1]', () => {
  const cdf = solitonCdf(1);
  assert.equal(cdf.length, 1);
  assert.equal(cdf[0], 1);
});

// T3: solitonCdf k=100 基本性质（单调、末尾 1、和为 1）
test('solitonCdf k=100 is monotone and normalized', () => {
  const cdf = solitonCdf(100);
  assert.equal(cdf.length, 100);
  assert.equal(cdf[99], 1);
  for (let i = 1; i < 100; i++) {
    assert.ok(cdf[i]! >= cdf[i - 1]!, `cdf[${i}] >= cdf[${i - 1}]`);
  }
  // 概率质量（差分）之和 ≈ 1
  let mass = 0;
  let prev = 0;
  for (let i = 0; i < 100; i++) {
    mass += cdf[i]! - prev;
    prev = cdf[i]!;
  }
  assert.ok(Math.abs(mass - 1) < 1e-9);
});

// T4: splitmix32 确定性序列
test('splitmix32 produces fixed sequence', () => {
  const rnd = splitmix32(1234);
  const first10 = Array.from({ length: 10 }, () => rnd());
  // 值必须跨引擎稳定（整数运算，无浮点）
  assert.equal(first10.length, 10);
  // 两次调用同一 seed 产生相同序列
  const rnd2 = splitmix32(1234);
  for (let i = 0; i < 10; i++) {
    assert.equal(rnd2(), first10[i]!);
  }
});

// T5: frameIndices 确定性 + 范围
test('frameIndices is deterministic and in-range', () => {
  const k = 8;
  const cdf = solitonCdf(k);
  const a = frameIndices(k, cdf, 1, 0);
  const b = frameIndices(k, cdf, 1, 0);
  assert.deepEqual(a, b);
  for (const idx of a) {
    assert.ok(idx >= 0 && idx < k, `idx ${idx} in range`);
  }
});

// T6: LT 编码→解码往返（无丢帧）
test('LT encode/decode roundtrip', () => {
  const payload = new Uint8Array(1024);
  for (let i = 0; i < payload.length; i++) payload[i] = i % 256;
  const blockLen = 128;
  const enc = new LTEncoder(payload, blockLen, 42);
  const dec = new LTDecoder(enc.k, blockLen, 42, payload.length);
  // 冗余 1.15× 是平均需求，soliton 尾部可能多帧；循环直到解出，上限 3K
  let sent = 0;
  while (!dec.isComplete && sent < enc.k * 3) {
    dec.addFrame(sent, enc.encode(sent));
    sent++;
  }
  assert.equal(dec.isComplete, true, `completed after ${sent}/${enc.k} frames`);
  assert.ok(sent <= enc.k * 2, `redundancy sane: ${sent}/${enc.k}`);
  const out = dec.assemble()!;
  assert.deepEqual(out, payload);
});

// T7: LT 往返丢帧 20%
test('LT roundtrip with 20% frame loss', () => {
  const payload = new Uint8Array(2048);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 7) % 256;
  const blockLen = 64;
  const enc = new LTEncoder(payload, blockLen, 7);
  const dec = new LTDecoder(enc.k, blockLen, 7, payload.length);
  const need = Math.ceil(enc.k * 1.15);
  let sent = 0;
  while (!dec.isComplete && sent < need * 2) {
    if (sent % 5 !== 0) dec.addFrame(sent, enc.encode(sent)); // 丢 20%
    sent++;
  }
  assert.equal(dec.isComplete, true, `completed after ${sent} frames`);
  assert.deepEqual(dec.assemble(), payload);
});

// T8: fnv1a 固定值
test('fnv1a matches known vector', () => {
  const empty = fnv1a(new Uint8Array(0));
  assert.equal(empty, 0x811c9dc5);
  const abc = fnv1a(new Uint8Array([0x61, 0x62, 0x63])); // "abc"
  assert.equal(abc, 0x1a47e90b);
});
