/**
 * 二维码编码器回归：以 Nayuki qrcodegen 生成的矩阵为黄金样本，
 * 逐位比较版本、掩码与模块。运行：node test/qr.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeQr, toDots } from '../src/core/qr.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'qr-golden.json'), 'utf8'));

test('黄金样本逐位一致', () => {
  assert.ok(golden.length >= 4);
  for (const sample of golden) {
    const qr = encodeQr(sample.text, { ecc: 1 });
    assert.equal(qr.version, sample.version, '版本：' + sample.text.length + ' 字符');
    assert.equal(qr.size, sample.size, '尺寸：' + sample.text.length + ' 字符');
    assert.equal(qr.mask, sample.mask, '掩码：' + sample.text.length + ' 字符');
    let diff = 0;
    for (let y = 0; y < sample.size; y += 1) {
      const mine = qr.modules[y] ?? '';
      for (let x = 0; x < sample.size; x += 1) {
        if (mine.charAt(x) !== sample.rows[y].charAt(x)) diff += 1;
      }
    }
    assert.equal(diff, 0, '逐位差异应为 0，实际 ' + diff);
  }
});

test('任意文本都能产出合法矩阵', () => {
  const url =
    'https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&callback=close&qrcode_key=0123456789abcdef0123456789abcdef&from=';
  for (const text of ['a', 'abc', url]) {
    const qr = encodeQr(text, { ecc: 1, minVersion: 1, maxVersion: 10 });
    assert.ok(qr.version >= 1 && qr.version <= 10, '版本在范围内');
    assert.equal(qr.size % 4, 1, '尺寸应为 4v+17');
    assert.equal(qr.modules.length, qr.size);
    for (const row of qr.modules) {
      assert.equal(row.length, qr.size, '每行长度应等于尺寸');
      assert.match(row, /^[01]+$/, '只含 0/1');
    }
    const dots = toDots(qr);
    assert.equal(dots.split('\n').length, qr.size, 'dots 行数等于尺寸');
  }
});

test('容量不足时抛错而不是产出坏矩阵', () => {
  const tooLong = 'x'.repeat(400);
  assert.throws(() => encodeQr(tooLong, { ecc: 3, minVersion: 1, maxVersion: 2 }), /内容过长|容量/);
});
