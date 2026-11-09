// 写真（影・机・他の物が映り込んだもの）から線画だけを取り出す。DOM に依存しない。
//
// 方針
// 1. 線は「まわりより細く暗いもの」。画素の明るさから、細い暗い線を除いた「背景の明るさ」を求め
//    （モルフォロジーのクロージング）、背景に対する比で線の強さを測る。
//    影のなだらかな濃淡や、線より広い暗い面（机など）は背景の側に残るので線にならず、
//    影の濃さ（明るさに掛かる倍率）にも影響されない。
// 2. 紙の部分は色で探す（紙は彩度が低い。机の木目は彩度が高い）。写真の中央付近の色を基準に、
//    つながった領域を紙とし、その外接矩形で切り出し、紙の外は線なしにする。

import { computeDarkness } from "./lineart";

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PhotoOptions {
  /** 線の太さの上限（画素）。これより広い暗い部分は線とは見なさない */
  maxLineWidth: number;
  /** 紙の部分だけを切り出すか */
  cropPaper: boolean;
}

export interface Extracted {
  /** 切り出したあとのサイズ */
  width: number;
  height: number;
  /** 画素ごとの黒さ（0〜255）。紙の外は 0 */
  dark: Uint8Array;
  /** 元の画像のどこを切り出したか（切り出さなければ全体） */
  box: Box;
  /** 紙を見つけられたか（cropPaper のとき） */
  paperFound: boolean;
}

// ---------- 明るさ・背景 ----------

/** 画素の明るさ 0〜255（白地に重ねたときの、いちばん明るいチャンネル。色のついた部分は明るく出る） */
export function brightness(rgba: Uint8ClampedArray | Uint8Array): Uint8Array {
  const n = rgba.length / 4;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const a = rgba[o + 3]! / 255;
    const m = Math.max(rgba[o]!, rgba[o + 1]!, rgba[o + 2]!);
    out[i] = Math.round(m * a + 255 * (1 - a));
  }
  return out;
}

/** 1次元の移動窓（半径 radius）の最大 / 最小。窓は端で切る。deque で O(n) */
function slide(
  src: Uint8Array,
  dst: Uint8Array,
  start: number,
  stride: number,
  n: number,
  radius: number,
  max: boolean,
  deque: Int32Array,
): void {
  let head = 0;
  let tail = 0;
  const v = (i: number): number => src[start + i * stride]!;
  for (let j = 0; j < n + radius; j++) {
    if (j < n) {
      const x = v(j);
      while (tail > head && (max ? v(deque[tail - 1]!) <= x : v(deque[tail - 1]!) >= x)) tail--;
      deque[tail++] = j;
    }
    const i = j - radius;
    if (i >= 0) {
      while (deque[head]! < i - radius) head++;
      dst[start + i * stride] = v(deque[head]!);
    }
  }
}

/** 正方形の窓（辺 2r+1）の最大 (max=true) / 最小 */
function extreme(src: Uint8Array, w: number, h: number, r: number, max: boolean): Uint8Array {
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  const deque = new Int32Array(Math.max(w, h) + 1);
  for (let y = 0; y < h; y++) slide(src, tmp, y * w, 1, w, r, max, deque);
  for (let x = 0; x < w; x++) slide(tmp, out, x, w, h, r, max, deque);
  return out;
}

/**
 * クロージング（最大 → 最小）。窓より細い暗い部分（線）が消え、広い暗い部分や段差は残る。
 * 返すのは「線がなかったとしたときの明るさ」＝背景。
 */
export function closing(src: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  const r = Math.max(1, Math.round(radius));
  return extreme(extreme(src, w, h, r, true), w, h, r, false);
}

/**
 * 背景に対する線の強さ（0〜255）。(背景 − 明るさ) / 背景。
 * 背景が暗すぎる所（影の奥・机の暗部）は雑音が大きいので 0 にする。
 */
export function lineStrength(bright: Uint8Array, bg: Uint8Array): Uint8Array {
  const out = new Uint8Array(bright.length);
  for (let i = 0; i < bright.length; i++) {
    const b = bg[i]!;
    if (b < 40) continue;
    const d = (b - bright[i]!) / b;
    if (d > 0) out[i] = Math.min(255, Math.round(d * 255));
  }
  return out;
}

// ---------- 紙の検出 ----------

/** 紙を探す。見つからなければ null。mask は画素ごと（1 = 紙） */
export function findPaper(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): { mask: Uint8Array; box: Box } | null {
  const b = Math.max(2, Math.round(Math.max(width, height) / 256)); // ブロックの一辺
  const bw = Math.ceil(width / b);
  const bh = Math.ceil(height / b);
  const sat = new Float32Array(bw * bh);
  const val = new Float32Array(bw * bh);

  // ブロックの平均色（細い線は平均すると紙の色に埋もれる）から、彩度と明るさ
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let r = 0;
      let g = 0;
      let bl = 0;
      let n = 0;
      for (let y = by * b; y < Math.min(height, (by + 1) * b); y++) {
        for (let x = bx * b; x < Math.min(width, (bx + 1) * b); x++) {
          const o = (y * width + x) * 4;
          const a = rgba[o + 3]! / 255;
          r += rgba[o]! * a + 255 * (1 - a);
          g += rgba[o + 1]! * a + 255 * (1 - a);
          bl += rgba[o + 2]! * a + 255 * (1 - a);
          n++;
        }
      }
      r /= n;
      g /= n;
      bl /= n;
      const mx = Math.max(r, g, bl);
      const mn = Math.min(r, g, bl);
      const k = by * bw + bx;
      val[k] = mx;
      sat[k] = mx === 0 ? 0 : (mx - mn) / mx;
    }
  }

  // 写真の中央付近（絵がある所）の色を紙の色とする
  const cs: number[] = [];
  const cv: number[] = [];
  for (let by = Math.floor(bh * 0.35); by < Math.ceil(bh * 0.65); by++) {
    for (let bx = Math.floor(bw * 0.35); bx < Math.ceil(bw * 0.65); bx++) {
      cs.push(sat[by * bw + bx]!);
      cv.push(val[by * bw + bx]!);
    }
  }
  const median = (xs: number[]): number => xs.sort((p, q) => p - q)[Math.floor(xs.length / 2)]!;
  const medS = median(cs);
  const medV = median(cv);

  const cand = new Uint8Array(bw * bh);
  for (let k = 0; k < cand.length; k++) {
    // 紙と同じくらい彩度が低く、極端に暗くない
    if (sat[k]! <= medS + 0.1 && val[k]! >= medV * 0.45) cand[k] = 1;
  }

  // つながった領域のうち、いちばん大きいものを紙とする。
  // 絵の線（暗いので候補から外れる）で囲まれた内側は別の領域になるが、下の穴埋めで紙に取り込まれる
  const comp = new Int32Array(bw * bh).fill(-1);
  const sizes: number[] = [];
  const stack = new Int32Array(bw * bh);
  for (let s = 0; s < cand.length; s++) {
    if (!cand[s] || comp[s]! >= 0) continue;
    const id = sizes.length;
    let size = 0;
    let sp = 0;
    stack[sp++] = s;
    comp[s] = id;
    while (sp > 0) {
      const k = stack[--sp]!;
      size++;
      const x = k % bw;
      const y = (k - x) / bw;
      const nb = [x > 0 ? k - 1 : -1, x < bw - 1 ? k + 1 : -1, y > 0 ? k - bw : -1, y < bh - 1 ? k + bw : -1];
      for (const q of nb) {
        if (q >= 0 && cand[q] && comp[q]! < 0) {
          comp[q] = id;
          stack[sp++] = q;
        }
      }
    }
    sizes.push(size);
  }
  if (sizes.length === 0) return null;
  let best = 0;
  for (let id = 1; id < sizes.length; id++) if (sizes[id]! > sizes[best]!) best = id;
  let paper = new Uint8Array(bw * bh);
  for (let k = 0; k < paper.length; k++) if (comp[k] === best) paper[k] = 1;

  // 穴（紙の中の影や濃い部分で外れた所）を埋める: 画像の縁から入れない非紙ブロックは穴
  const outside = new Uint8Array(bw * bh);
  let sp = 0;
  const seed = (k: number): void => {
    if (!paper[k] && !outside[k]) {
      outside[k] = 1;
      stack[sp++] = k;
    }
  };
  for (let x = 0; x < bw; x++) {
    seed(x);
    seed((bh - 1) * bw + x);
  }
  for (let y = 0; y < bh; y++) {
    seed(y * bw);
    seed(y * bw + bw - 1);
  }
  while (sp > 0) {
    const k = stack[--sp]!;
    const x = k % bw;
    const y = (k - x) / bw;
    if (x > 0) seed(k - 1);
    if (x < bw - 1) seed(k + 1);
    if (y > 0) seed(k - bw);
    if (y < bh - 1) seed(k + bw);
  }
  for (let k = 0; k < paper.length; k++) if (!outside[k]) paper[k] = 1;

  // 紙の縁（段差の影・紙の端の線）を避けるため、ブロック1つ分だけ内側に縮める（画像の縁は紙扱い）
  const shrunk = new Uint8Array(bw * bh);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const k = y * bw + x;
      const ok = (q: number, inside: boolean): boolean => !inside || paper[q] === 1;
      if (
        paper[k] &&
        ok(k - 1, x > 0) &&
        ok(k + 1, x < bw - 1) &&
        ok(k - bw, y > 0) &&
        ok(k + bw, y < bh - 1)
      ) {
        shrunk[k] = 1;
      }
    }
  }
  paper = shrunk;

  let count = 0;
  let minX = bw;
  let minY = bh;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      if (!paper[y * bw + x]) continue;
      count++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (count < bw * bh * 0.1) return null; // 紙らしい広がりがない

  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const rowBase = Math.floor(y / b) * bw;
    for (let x = 0; x < width; x++) mask[y * width + x] = paper[rowBase + Math.floor(x / b)]!;
  }
  const box: Box = {
    x: minX * b,
    y: minY * b,
    width: Math.min(width, (maxX + 1) * b) - minX * b,
    height: Math.min(height, (maxY + 1) * b) - minY * b,
  };
  return { mask, box };
}

// ---------- まとめ ----------

/** 写真向けの抽出。影・背景を除き、（紙が見つかれば）紙の部分だけを切り出して返す */
export function extractFromPhoto(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  options: PhotoOptions,
): Extracted {
  const bright = brightness(rgba);
  const bg = closing(bright, width, height, options.maxLineWidth / 2 + 1);
  const strength = lineStrength(bright, bg);

  const paper = options.cropPaper ? findPaper(rgba, width, height) : null;
  if (!paper) {
    return {
      width,
      height,
      dark: strength,
      box: { x: 0, y: 0, width, height },
      paperFound: false,
    };
  }
  const { box, mask } = paper;
  const dark = new Uint8Array(box.width * box.height);
  for (let y = 0; y < box.height; y++) {
    for (let x = 0; x < box.width; x++) {
      const src = (box.y + y) * width + box.x + x;
      if (mask[src]) dark[y * box.width + x] = strength[src]!;
    }
  }
  return { width: box.width, height: box.height, dark, box, paperFound: true };
}

/** 単純な抽出（スキャンやデジタルの線画向け）。画素の黒さそのまま */
export function extractSimple(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): Extracted {
  return {
    width,
    height,
    dark: computeDarkness(rgba),
    box: { x: 0, y: 0, width, height },
    paperFound: false,
  };
}

/** 線の太さの上限の初期値（画像の大きさに比例。細い線を消さず、広い暗い面は背景として残す） */
export function defaultMaxLineWidth(width: number, height: number): number {
  return Math.min(60, Math.max(6, Math.round(Math.max(width, height) / 120)));
}
