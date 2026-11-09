// 黒い線で囲まれた領域の番号づけ。DOM に依存しない。

export interface Regions {
  /** 画素ごとの領域番号。線の上は 0、領域は 1 から */
  labels: Int32Array;
  /** 領域の数（番号は 1〜count） */
  count: number;
  /** 領域ごとの画素数（添字は番号。[0] は使わない） */
  sizes: Int32Array;
  /** 番号を表示する位置（画素の番号。領域の中にあることが保証される。添字は番号） */
  anchors: Int32Array;
}

/**
 * 線でない画素（黒さがしきい値未満）の4近傍の連結領域に、画面の左上から順に 1, 2, 3… と番号をつける。
 * 番号は同じ画像・同じしきい値なら必ず同じになる。
 */
export function labelRegions(
  dark: Uint8Array,
  width: number,
  height: number,
  threshold: number,
): Regions {
  const t = Math.max(2, threshold);
  const n = width * height;
  const labels = new Int32Array(n);
  const stack = new Int32Array(n);
  let count = 0;

  for (let start = 0; start < n; start++) {
    if (labels[start] !== 0 || dark[start]! >= t) continue;
    count++;
    let sp = 0;
    stack[sp++] = start;
    labels[start] = count;
    while (sp > 0) {
      const i = stack[--sp]!;
      const x = i % width;
      const y = (i - x) / width;
      if (x > 0 && labels[i - 1] === 0 && dark[i - 1]! < t) {
        labels[i - 1] = count;
        stack[sp++] = i - 1;
      }
      if (x < width - 1 && labels[i + 1] === 0 && dark[i + 1]! < t) {
        labels[i + 1] = count;
        stack[sp++] = i + 1;
      }
      if (y > 0 && labels[i - width] === 0 && dark[i - width]! < t) {
        labels[i - width] = count;
        stack[sp++] = i - width;
      }
      if (y < height - 1 && labels[i + width] === 0 && dark[i + width]! < t) {
        labels[i + width] = count;
        stack[sp++] = i + width;
      }
    }
  }
  return buildRegions(labels, count, width, height);
}

/**
 * 画素ごとの番号（線の上は 0、領域は 1〜count）から、大きさと番号の位置を求める。
 * 番号は画面の左上から順（最初に現れる順）に振り直す必要があるなら、先に renumber を通す。
 */
export function buildRegions(labels: Int32Array, count: number, width: number, height: number): Regions {
  const n = width * height;
  const sizes = new Float64Array(count + 1);
  const sumX = new Float64Array(count + 1);
  const sumY = new Float64Array(count + 1);
  for (let i = 0; i < n; i++) {
    const id = labels[i]!;
    if (id === 0) continue;
    const x = i % width;
    sizes[id]!++;
    sumX[id]! += x;
    sumY[id]! += (i - x) / width;
  }

  // 番号の位置は重心。重心が領域の外（輪の外側や C 字型など）なら、重心にいちばん近い領域内の画素にする
  const anchors = new Int32Array(count + 1);
  const cxs = new Float64Array(count + 1);
  const cys = new Float64Array(count + 1);
  const bestDist = new Float64Array(count + 1).fill(Infinity);
  let needSearch = false;
  for (let id = 1; id <= count; id++) {
    if (sizes[id] === 0) continue;
    cxs[id] = sumX[id]! / sizes[id]!;
    cys[id] = sumY[id]! / sizes[id]!;
    const c = Math.round(cys[id]!) * width + Math.round(cxs[id]!);
    if (labels[c] === id) {
      anchors[id] = c;
      bestDist[id] = -1; // 決まり
    } else {
      needSearch = true;
    }
  }
  if (needSearch) {
    for (let i = 0; i < n; i++) {
      const id = labels[i]!;
      if (id === 0 || bestDist[id]! < 0) continue;
      const x = i % width;
      const y = (i - x) / width;
      const d = (x - cxs[id]!) ** 2 + (y - cys[id]!) ** 2;
      if (d < bestDist[id]!) {
        bestDist[id] = d;
        anchors[id] = i;
      }
    }
  }
  return { labels, count, sizes: Int32Array.from(sizes), anchors };
}

/** 番号を、画面の左上から見て最初に現れる順の 1, 2, 3… に振り直す（元の番号は 0 = 線、1〜max）。新しい番号の数を返す */
export function renumber(labels: Int32Array, max: number): number {
  const map = new Int32Array(max + 1);
  let count = 0;
  for (let i = 0; i < labels.length; i++) {
    const id = labels[i]!;
    if (id === 0) continue;
    if (map[id] === 0) map[id] = ++count;
    labels[i] = map[id]!;
  }
  return count;
}

/** 領域 id に属する画素の番号を集める */
export function pixelsOf(labels: Int32Array, ids: ReadonlySet<number>): Int32Array {
  const out: number[] = [];
  for (let i = 0; i < labels.length; i++) {
    if (ids.has(labels[i]!)) out.push(i);
  }
  return Int32Array.from(out);
}

/**
 * "1, 3, 5-8" のような指定を領域の番号の集合にする。範囲外の番号と読めない部分は無視し、
 * 無視したものを ignored に返す。区切りは , 、 空白。範囲は 5-8 / 5〜8 / 5~8。
 */
export function parseRegionList(
  text: string,
  max: number,
): { ids: number[]; ignored: string[] } {
  const ids = new Set<number>();
  const ignored: string[] = [];
  for (const raw of text.split(/[,、\s]+/)) {
    const part = raw.trim();
    if (part === "") continue;
    const m = /^(\d+)(?:[-〜~](\d+))?$/.exec(part);
    if (!m) {
      ignored.push(part);
      continue;
    }
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    if (lo < 1 || hi > max) {
      // 範囲が一部だけ収まるときは、収まる部分を使う
      if (lo > max || hi < 1) {
        ignored.push(part);
        continue;
      }
    }
    for (let id = Math.max(1, lo); id <= Math.min(max, hi); id++) ids.add(id);
  }
  return { ids: [...ids].sort((x, y) => x - y), ignored };
}

/** 番号の集合を "1, 3, 5-8" のような短い表記にする */
export function formatRegionList(ids: Iterable<number>): string {
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    parts.push(j - i >= 2 ? `${sorted[i]}-${sorted[j]}` : sorted.slice(i, j + 1).join(", "));
    i = j + 1;
  }
  return parts.join(", ");
}
