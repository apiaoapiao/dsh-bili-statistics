/**
 * 只在新目录不存在且旧目录存在时整份拷贝；旧目录保留，用户可自行删除。
 */
import fs from 'node:fs';
import path from 'node:path';
import { expandHome } from './util.js';

export const LEGACY_STATE_DIR = '~/.dsh/bili-intent-drift';

export function migrateLegacyStateDir(dir) {
  try {
    const target = path.resolve(dir);
    const legacy = path.resolve(expandHome(LEGACY_STATE_DIR));
    if (target === legacy) return null;
    if (fs.existsSync(target) || !fs.existsSync(legacy)) return null;
    fs.cpSync(legacy, target, { recursive: true });
    return target;
  } catch {
    return null;
  }
}
