import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadState, saveState, migrateState, stateFile } from '../src/core/state.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bili-state-'));
}

function writeRaw(dir, value) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(stateFile(dir), JSON.stringify(value));
}

test('v1 状态升到 v2：给旧 run 补 generated 与 trigger，已有的不动', () => {
  const dir = tempDir();
  writeRaw(dir, {
    version: 1,
    runs: [
      { id: 'run-1', created_at: '2026-10-01T00:00:00.000Z' },
      { id: 'run-2', created_at: '2026-10-02T00:00:00.000Z', trigger: 'schedule', generated: { overview: '旧' } }
    ]
  });
  const state = loadState(dir);
  assert.equal(state.version, 2);
  assert.equal(state.runs[0].generated, null);
  assert.equal(state.runs[0].trigger, 'manual');
  assert.equal(state.runs[1].trigger, 'schedule');
  assert.deepEqual(state.runs[1].generated, { overview: '旧' });
});

test('迁移幂等：反复读同一份状态结果一致', () => {
  const dir = tempDir();
  writeRaw(dir, { version: 1, runs: [{ id: 'run-1' }] });
  const first = loadState(dir);
  saveState(dir, first);
  const second = loadState(dir);
  assert.deepEqual(second, first);
  assert.equal(second.version, 2);
});

test('比代码新的状态原样返回，不降级改写', () => {
  const dir = tempDir();
  writeRaw(dir, { version: 99, runs: [{ id: 'run-9', future_field: 1 }], future: { keep: true } });
  const state = loadState(dir);
  assert.equal(state.version, 99);
  assert.deepEqual(state.future, { keep: true });
  assert.equal(state.runs[0].future_field, 1);
  assert.equal(state.runs[0].generated, undefined);
});

test('迁移函数自身：缺少 version 视为 1', () => {
  const state = migrateState({ runs: [{ id: 'a' }] });
  assert.equal(state.version, 2);
  assert.equal(state.runs[0].trigger, 'manual');
});

test('状态文件缺失或损坏时给出空骨架，不抛错', () => {
  const empty = loadState(path.join(tempDir(), 'missing'));
  assert.equal(empty.version, 2);
  assert.deepEqual(empty.runs, []);
  assert.deepEqual(empty.schedule_log, []);
  assert.equal(empty.notify.last_sent_at, null);

  const dir = tempDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(stateFile(dir), '{ 半截 json');
  const broken = loadState(dir);
  assert.equal(broken.version, 2);
  assert.deepEqual(broken.runs, []);
});
