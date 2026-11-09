// 線のわずかな切れ目（手描きで空いてしまう隙間）の検出。DOM に依存しない。
//
// 方法:
// 1. 線を max_width / 2 だけ太らせて、細い切れ目をふさぐ。ふさいだあとに残る「芯」の連結成分が、切れ目の両側の部屋
// 2. 太らせた分で消えた画素（線の近く）は、いちばん近い芯の部屋に、領域の中をたどって割りふる。
//    部屋どうしの境界は切れ目をまたぐ最短の切り口になる（線の端と端を結ぶ補間に当たる）
// 3. 同じ領域の中で隣りあう部屋のペアを「隙間の候補」とし、囲まれ具合を求める。
//    部屋 A の囲まれ具合 = 1 − (B との境界の長さ) ÷ (A の周の長さ)。ペアの値は小さいほう（口が相対的に広いほう）
// 4. 囲まれ具合が下限以上の候補は、別々の領域にするか同じ領域にするかを選べる。
//    下限に満たないペアは、ただの広い通路とみなして同じ領域のままにする

import { buildRegions, renumber, type Regions } from "./regions";
import { distanceTransform } from "./skeleton";

export interface GapOptions {
  /** ふさぐ隙間の最大の幅（px）。線を半分だけ太らせるので、この幅までの切れ目がふさがる */
  maxWidth: number;
  /** 囲まれ具合の下限（0〜1） */
  minEnclosure: number;
  /** 部屋とみなす芯の最小の画素数 */
  minSeedSize?: number;
}

export interface GapCandidate {
  /** 候補の番号（1 から。左上にある順） */
  id: number;
  /** 隙間の位置（画素） */
  x: number;
  y: number;
  /** 隙間の幅（境界の長さ。px） */
  width: number;
  /** 囲まれ具合 0〜1（1 に近いほど、隙間を除いてしっかり囲まれている） */
  enclosure: number;
  /** 隙間をはさむ 2 つの部屋の画素数 */
  sizeA: number;
  sizeB: number;
  seedA: number;
  seedB: number;
}

export interface GapAnalysis {
  /** 部屋（芯）の番号を、領域の全画素に割りふったもの。線の上は 0 */
  rooms: Int32Array;
  roomCount: number;
  /** 下限以上の囲まれ具合の候補 */
  candidates: GapCandidate[];
  /** 候補にならないペア（広い通路）。いつも同じ領域として扱う */
  forced: [number, number][];
}

const DEFAULT_MIN_SEED = 24;

export function analyzeGaps(base: Regions, width: number, height: number, opts: GapOptions): GapAnalysis {
  const n = width * height;
  const { labels } = base;
  const minSeed = opts.minSeedSize ?? DEFAULT_MIN_SEED;

  // 1. 線を太らせて、残った画素（芯）の連結成分を部屋にする
  const line = new Uint8Array(n);
  for (let i = 0; i < n; i++) line[i] = labels[i] === 0 ? 1 : 0;
  const dLine = distanceTransform(line, width, height);
  const r = Math.max(0, opts.maxWidth) / 2;
  const core = new Uint8Array(n);
  for (let i = 0; i < n; i++) core[i] = labels[i] !== 0 && dLine[i]! > r ? 1 : 0;

  const rooms = new Int32Array(n);
  const stack = new Int32Array(n);
  let roomCount = 0;
  const comp = new Int32Array(n); // 成分の仮の番号
  let comps = 0;
  const compSize: number[] = [0];
  for (let s = 0; s < n; s++) {
    if (!core[s] || comp[s]) continue;
    comps++;
    let size = 0;
    let sp = 0;
    stack[sp++] = s;
    comp[s] = comps;
    while (sp > 0) {
      const i = stack[--sp]!;
      size++;
      const x = i % width;
      if (x > 0 && core[i - 1] && !comp[i - 1]) (comp[i - 1] = comps), (stack[sp++] = i - 1);
      if (x < width - 1 && core[i + 1] && !comp[i + 1]) (comp[i + 1] = comps), (stack[sp++] = i + 1);
      if (i >= width && core[i - width] && !comp[i - width]) (comp[i - width] = comps), (stack[sp++] = i - width);
      if (i < n - width && core[i + width] && !comp[i + width]) (comp[i + width] = comps), (stack[sp++] = i + width);
    }
    compSize.push(size);
  }
  // 小さすぎる成分は部屋にしない（番号は左上から順）
  const roomOf = new Int32Array(comps + 1);
  const roomSize: number[] = [0];
  for (let c = 1; c <= comps; c++) {
    if (compSize[c]! >= minSeed) {
      roomOf[c] = ++roomCount;
      roomSize.push(0);
    }
  }
  for (let i = 0; i < n; i++) {
    if (comp[i]) {
      const id = roomOf[comp[i]!]!;
      if (id) {
        rooms[i] = id;
        roomSize[id]!++;
      }
    }
  }
  // 部屋が1つもできなかった領域（細い領域など）は、領域ぜんたいを1つの部屋にする
  const hasRoom = new Uint8Array(base.count + 1);
  for (let i = 0; i < n; i++) if (rooms[i]) hasRoom[labels[i]!] = 1;
  const wholeRoom = new Int32Array(base.count + 1);
  for (let i = 0; i < n; i++) {
    const b = labels[i]!;
    if (b === 0 || hasRoom[b]) continue;
    if (!wholeRoom[b]) {
      wholeRoom[b] = ++roomCount;
      roomSize.push(0);
    }
    rooms[i] = wholeRoom[b]!;
    roomSize[wholeRoom[b]!]!++;
  }

  // 2. 残りの画素を、領域の中でいちばん近い部屋に割りふる（幅優先）
  let head = 0;
  let tail = 0;
  const queue = stack; // 作業用の配列を使い回す
  for (let i = 0; i < n; i++) if (rooms[i]) queue[tail++] = i;
  while (head < tail) {
    const i = queue[head++]!;
    const id = rooms[i]!;
    const x = i % width;
    if (x > 0 && labels[i - 1] !== 0 && !rooms[i - 1]) (rooms[i - 1] = id), (queue[tail++] = i - 1);
    if (x < width - 1 && labels[i + 1] !== 0 && !rooms[i + 1]) (rooms[i + 1] = id), (queue[tail++] = i + 1);
    if (i >= width && labels[i - width] !== 0 && !rooms[i - width]) (rooms[i - width] = id), (queue[tail++] = i - width);
    if (i < n - width && labels[i + width] !== 0 && !rooms[i + width])
      (rooms[i + width] = id), (queue[tail++] = i + width);
  }

  // 3. 部屋どうしの境界の長さと、部屋の周の長さ
  const perim = new Float64Array(roomCount + 1);
  const contacts = new Map<number, { len: number; sx: number; sy: number }>();
  for (let i = 0; i < n; i++) {
    const a = rooms[i]!;
    if (a === 0) continue;
    const x = i % width;
    const y = (i - x) / width;
    const look = (j: number): void => {
      const b = rooms[j]!;
      if (b === a) return;
      perim[a]!++;
      if (b !== 0 && a < b) {
        const key = a * (roomCount + 1) + b;
        const c = contacts.get(key);
        if (c) {
          c.len++;
          c.sx += x;
          c.sy += y;
        } else {
          contacts.set(key, { len: 1, sx: x, sy: y });
        }
      }
    };
    if (x > 0) look(i - 1);
    if (x < width - 1) look(i + 1);
    if (y > 0) look(i - width);
    if (y < height - 1) look(i + width);
  }

  const candidates: GapCandidate[] = [];
  const forced: [number, number][] = [];
  const keys = [...contacts.keys()].sort((p, q) => p - q);
  for (const key of keys) {
    const c = contacts.get(key)!;
    const a = Math.floor(key / (roomCount + 1));
    const b = key % (roomCount + 1);
    const enclosure = Math.min(1 - c.len / perim[a]!, 1 - c.len / perim[b]!);
    if (enclosure >= opts.minEnclosure) {
      candidates.push({
        id: candidates.length + 1,
        x: c.sx / c.len + 0.5,
        y: c.sy / c.len + 0.5,
        width: c.len,
        enclosure,
        sizeA: roomSize[a]!,
        sizeB: roomSize[b]!,
        seedA: a,
        seedB: b,
      });
    } else {
      forced.push([a, b]);
    }
  }
  return { rooms, roomCount, candidates, forced };
}

/**
 * 候補ごとに「同じ領域にする」(merged に入れた番号) か「別々にする」(入れない) かを決めて、領域の番号を作る。
 * 隙間をはさむ部屋を同じにすると、元の（隙間をふさがない）領域と一致する。
 */
export function resolveGaps(
  analysis: GapAnalysis,
  merged: ReadonlySet<number>,
  width: number,
  height: number,
): Regions {
  const parent = Int32Array.from({ length: analysis.roomCount + 1 }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  for (const [a, b] of analysis.forced) union(a, b);
  for (const c of analysis.candidates) if (merged.has(c.id)) union(c.seedA, c.seedB);

  const labels = new Int32Array(analysis.rooms.length);
  for (let i = 0; i < labels.length; i++) {
    const room = analysis.rooms[i]!;
    labels[i] = room === 0 ? 0 : find(room);
  }
  const count = renumber(labels, analysis.roomCount);
  return buildRegions(labels, count, width, height);
}
