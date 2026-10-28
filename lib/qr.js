/**
 * 精简二维码编码器（仅 byte mode，ECC 可选 L/M/Q/H）。
 *
 * 算法、纠错块参数表与掩码惩罚评分参考 Project Nayuki 的 QR Code generator
 * （https://www.nayuki.io/page/qr-code-generator-library ，MIT License），
 * 按本插件需要重写为无依赖的 ESM 模块：输入文本、输出模块矩阵字符串。
 *
 * 约定：modules 是 size 行字符串数组，每行 size 个字符，'1' 为黑、'0' 为白。
 */

export const ECC = Object.freeze({ LOW: 0, MEDIUM: 1, QUARTILE: 2, HIGH: 3 });

const ECC_CODEWORDS_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];

const NUM_ERROR_CORRECTION_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

const MIN_VERSION = 1;
const MAX_VERSION = 40;

/** 某版本中可用于数据+纠错的模块数（比特），含 remainder bits。 */
export function rawDataModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

/** 某版本 + 纠错级别下的数据码字数。 */
export function dataCodewords(version, ecc) {
  return (
    Math.floor(rawDataModules(version) / 8) -
    ECC_CODEWORDS_PER_BLOCK[ecc][version] * NUM_ERROR_CORRECTION_BLOCKS[ecc][version]
  );
}

function charCountBits(version) {
  return version <= 9 ? 8 : 16;
}

function appendBits(value, length, bits) {
  for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
}

function bitAt(value, index) {
  return ((value >>> index) & 1) !== 0;
}

function rsMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < result.length; j += 1) {
      result[j] = rsMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = rsMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data, divisor) {
  const result = divisor.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ result.shift();
    result.push(0);
    for (let i = 0; i < divisor.length; i += 1) result[i] ^= rsMultiply(divisor[i], factor);
  }
  return result;
}

function alignmentPatternPositions(version, size) {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const step = Math.floor((version * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

/**
 * 编码文本为二维码矩阵。
 * @param {string} text 待编码文本（按 UTF-8 字节编码）
 * @param {{ecc?: number, minVersion?: number, maxVersion?: number, mask?: number, boostEcc?: boolean}} [options]
 * @returns {{version: number, size: number, mask: number, ecc: number, modules: string[]}}
 */
export function encodeQr(text, options = {}) {
  const minVersion = options.minVersion ?? MIN_VERSION;
  const maxVersion = options.maxVersion ?? MAX_VERSION;
  const mask = options.mask ?? -1;
  const boostEcc = options.boostEcc === true;
  const bytes = Array.from(new TextEncoder().encode(String(text)));

  if (!(MIN_VERSION <= minVersion && minVersion <= maxVersion && maxVersion <= MAX_VERSION)) {
    throw new RangeError('二维码版本范围非法');
  }
  if (mask < -1 || mask > 7) throw new RangeError('二维码掩码必须为 -1 到 7');

  // 选最小可用版本
  let version = minVersion;
  let usedBits = 0;
  for (;;) {
    const capacityBits = dataCodewords(version, options.ecc ?? ECC.MEDIUM) * 8;
    usedBits = 4 + charCountBits(version) + bytes.length * 8;
    if (usedBits <= capacityBits) break;
    if (version >= maxVersion) throw new RangeError('内容过长，超出二维码容量');
    version += 1;
  }

  // 可选：在不增大版本的前提下提升纠错级别
  let ecc = options.ecc ?? ECC.MEDIUM;
  if (boostEcc) {
    for (const candidate of [ECC.MEDIUM, ECC.QUARTILE, ECC.HIGH]) {
      if (usedBits <= dataCodewords(version, candidate) * 8) ecc = candidate;
    }
  }

  // 组装数据比特流
  const bits = [];
  appendBits(0x4, 4, bits); // byte mode
  appendBits(bytes.length, charCountBits(version), bits);
  for (const byte of bytes) appendBits(byte, 8, bits);

  const capacityBits = dataCodewords(version, ecc) * 8;
  appendBits(0, Math.min(4, capacityBits - bits.length), bits);
  appendBits(0, (8 - (bits.length % 8)) % 8, bits);
  for (let padByte = 0xec; bits.length < capacityBits; padByte ^= 0xec ^ 0x11) {
    appendBits(padByte, 8, bits);
  }

  const data = new Array(bits.length / 8).fill(0);
  bits.forEach((bit, index) => {
    data[index >>> 3] |= bit << (7 - (index & 7));
  });

  return draw(version, ecc, data, mask);
}

function draw(version, ecc, dataCodewordsIn, requestedMask) {
  const size = version * 4 + 17;
  const modules = [];
  const isFunction = [];
  for (let i = 0; i < size; i += 1) {
    modules.push(new Array(size).fill(false));
    isFunction.push(new Array(size).fill(false));
  }

  const setFunction = (x, y, dark) => {
    modules[y][x] = dark;
    isFunction[y][x] = true;
  };

  const drawFinder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) setFunction(x, y, dist !== 2 && dist !== 4);
      }
    }
  };

  const drawAlignment = (cx, cy) => {
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) {
        setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  };

  const formatBitsFor = (maskValue) => {
    const data = (ecsFormatBits(ecc) << 3) | maskValue;
    let rem = data;
    for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    return ((data << 10) | rem) ^ 0x5412;
  };

  const drawFormatBits = (maskValue) => {
    const bits = formatBitsFor(maskValue);
    for (let i = 0; i <= 5; i += 1) setFunction(8, i, bitAt(bits, i));
    setFunction(8, 7, bitAt(bits, 6));
    setFunction(8, 8, bitAt(bits, 7));
    setFunction(7, 8, bitAt(bits, 8));
    for (let i = 9; i < 15; i += 1) setFunction(14 - i, 8, bitAt(bits, i));
    for (let i = 0; i < 8; i += 1) setFunction(size - 1 - i, 8, bitAt(bits, i));
    for (let i = 8; i < 15; i += 1) setFunction(8, size - 15 + i, bitAt(bits, i));
    setFunction(8, size - 8, true); // 固定的黑模块
  };

  const drawVersionBits = () => {
    if (version < 7) return;
    let rem = version;
    for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i += 1) {
      const dark = bitAt(bits, i);
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunction(a, b, dark);
      setFunction(b, a, dark);
    }
  };

  // 功能图形
  for (let i = 0; i < size; i += 1) {
    setFunction(6, i, i % 2 === 0);
    setFunction(i, 6, i % 2 === 0);
  }
  drawFinder(3, 3);
  drawFinder(size - 4, 3);
  drawFinder(3, size - 4);
  const alignPositions = alignmentPatternPositions(version, size);
  const numAlign = alignPositions.length;
  for (let i = 0; i < numAlign; i += 1) {
    for (let j = 0; j < numAlign; j += 1) {
      const onFinder = (i === 0 && j === 0) || (i === 0 && j === numAlign - 1) || (i === numAlign - 1 && j === 0);
      if (!onFinder) drawAlignment(alignPositions[i], alignPositions[j]);
    }
  }
  drawFormatBits(0);
  drawVersionBits();

  // 纠错 + 交织
  const allCodewords = addEccAndInterleave(version, ecc, dataCodewordsIn);

  // 数据填充（之字形）
  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y][x] && bitIndex < allCodewords.length * 8) {
          modules[y][x] = bitAt(allCodewords[bitIndex >>> 3], 7 - (bitIndex & 7));
          bitIndex += 1;
        }
      }
    }
  }

  const applyMask = (maskValue) => {
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        if (isFunction[y][x]) continue;
        let invert = false;
        switch (maskValue) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          case 7: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: throw new RangeError('二维码掩码非法');
        }
        if (invert) modules[y][x] = !modules[y][x];
      }
    }
  };

  const penalty = () => {
    let result = 0;
    for (let y = 0; y < size; y += 1) {
      let runColor = false;
      let runX = 0;
      const history = [0, 0, 0, 0, 0, 0, 0];
      for (let x = 0; x < size; x += 1) {
        if (modules[y][x] === runColor) {
          runX += 1;
          if (runX === 5) result += PENALTY_N1;
          else if (runX > 5) result += 1;
        } else {
          addHistory(history, runX, size);
          if (!runColor) result += countFinderPatterns(history) * PENALTY_N3;
          runColor = modules[y][x];
          runX = 1;
        }
      }
      result += terminateAndCount(history, runColor, runX, size) * PENALTY_N3;
    }
    for (let x = 0; x < size; x += 1) {
      let runColor = false;
      let runY = 0;
      const history = [0, 0, 0, 0, 0, 0, 0];
      for (let y = 0; y < size; y += 1) {
        if (modules[y][x] === runColor) {
          runY += 1;
          if (runY === 5) result += PENALTY_N1;
          else if (runY > 5) result += 1;
        } else {
          addHistory(history, runY, size);
          if (!runColor) result += countFinderPatterns(history) * PENALTY_N3;
          runColor = modules[y][x];
          runY = 1;
        }
      }
      result += terminateAndCount(history, runColor, runY, size) * PENALTY_N3;
    }
    for (let y = 0; y < size - 1; y += 1) {
      for (let x = 0; x < size - 1; x += 1) {
        const color = modules[y][x];
        if (color === modules[y][x + 1] && color === modules[y + 1][x] && color === modules[y + 1][x + 1]) {
          result += PENALTY_N2;
        }
      }
    }
    let darkCount = 0;
    for (const row of modules) for (const cell of row) if (cell) darkCount += 1;
    const total = size * size;
    const k = Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1;
    result += k * PENALTY_N4;
    return result;
  };

  let chosenMask = requestedMask;
  if (chosenMask === -1) {
    let minPenalty = Infinity;
    for (let i = 0; i < 8; i += 1) {
      applyMask(i);
      drawFormatBits(i);
      const score = penalty();
      if (score < minPenalty) {
        chosenMask = i;
        minPenalty = score;
      }
      applyMask(i);
    }
  }
  applyMask(chosenMask);
  drawFormatBits(chosenMask);

  const rows = modules.map((row) => row.map((dark) => (dark ? '1' : '0')).join(''));
  return { version, size, mask: chosenMask, ecc, modules: rows };
}

function ecsFormatBits(ecc) {
  switch (ecc) {
    case ECC.LOW: return 0b01;
    case ECC.MEDIUM: return 0b00;
    case ECC.QUARTILE: return 0b11;
    case ECC.HIGH: return 0b10;
    default: throw new RangeError('纠错级别非法');
  }
}

function addHistory(history, runLength, size) {
  const value = history[0] === 0 ? runLength + size : runLength;
  history.pop();
  history.unshift(value);
}

function countFinderPatterns(history) {
  const n = history[1];
  const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
  return (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0) +
    (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0);
}

function terminateAndCount(history, currentColor, currentLength, size) {
  let length = currentLength;
  if (currentColor) {
    addHistory(history, length, size);
    length = 0;
  }
  length += size;
  addHistory(history, length, size);
  return countFinderPatterns(history);
}

function addEccAndInterleave(version, ecc, data) {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecc][version];
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecc][version];
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const divisor = rsDivisor(blockEccLen);

  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i += 1) {
    const chunk = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
    k += chunk.length;
    const eccBytes = rsRemainder(chunk, divisor);
    const block = chunk.slice();
    if (i < numShortBlocks) block.push(0);
    blocks.push(block.concat(eccBytes));
  }

  const result = [];
  for (let i = 0; i < blocks[0].length; i += 1) {
    for (let j = 0; j < blocks.length; j += 1) {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(blocks[j][i]);
    }
  }
  return result;
}

/** 把模块矩阵转成卡片可渲染的点阵字符串（行用 \n 分隔）。 */
export function toDots(qr) {
  return qr.modules.join('\n');
}

/** 由模块矩阵生成 SVG path 的 d 属性（每行合并连续黑格），供调试或未来复用。 */
export function toSvgPath(modules) {
  const parts = [];
  modules.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x] === '1') {
        let end = x;
        while (end < row.length && row[end] === '1') end += 1;
        parts.push(`M${x} ${y}h${end - x}v1h-${end - x}z`);
        x = end;
      } else {
        x += 1;
      }
    }
  });
  return parts.join('');
}
