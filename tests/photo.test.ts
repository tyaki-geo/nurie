import { describe, expect, it } from "vitest";
import { brightness, closing, defaultMaxLineWidth, extractFromPhoto, extractSimple, lineStrength } from "../src/lib/photo";

const W = 240;
const H = 180;

/**
 * 疑似写真: 机（木の色）の上に、横方向に影が濃くなる紙（クリーム色）がある。
 * 紙の中に黒い枠（線の太さ3）と縦線、幅の広い影の帯。机の上にはキーボードの縁のような細い黒線。
 */
function fakePhoto(): Uint8ClampedArray {
  const px = new Uint8ClampedArray(W * H * 4);
  const set = (x: number, y: number, rgb: number[], k = 1): void =>
    px.set([rgb[0]! * k, rgb[1]! * k, rgb[2]! * k, 255], (y * W + x) * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const onPaper = x >= 30 && x < 230 && y >= 20 && y < 170;
      if (!onPaper) {
        set(x, y, [210, 170, 110]); // 机
        if (x >= 9 && x <= 10) set(x, y, [30, 30, 30]); // 机の上の細い黒線
        continue;
      }
      const shadow = 1 - 0.45 * ((x - 30) / 200); // 右へ行くほど暗い（最大 0.55 倍）
      let rgb = [225, 220, 200];
      const inRect = x >= 80 && x <= 180 && y >= 60 && y <= 130;
      const edge = inRect && (x < 83 || x > 177 || y < 63 || y > 127);
      const mid = x >= 129 && x <= 131 && y >= 60 && y <= 130;
      if (edge || mid) rgb = [25, 25, 25];
      const band = x >= 195 && x < 207 ? 0.6 : 1; // 幅12の影の帯（線の上限より広い）
      set(x, y, rgb, shadow * band);
    }
  }
  return px;
}

const at = (dark: Uint8Array, width: number, x: number, y: number): number => dark[y * width + x]!;

describe("closing / lineStrength", () => {
  it("窓より細い暗い線は消え、広い暗い面と段差は残る", () => {
    const w = 40;
    const h = 20;
    const src = new Uint8Array(w * h).fill(200);
    for (let y = 0; y < h; y++) {
      src[y * w + 5] = 20; // 細い線（幅1）
      for (let x = 20; x < 32; x++) src[y * w + x] = 20; // 広い暗い面（幅12）
    }
    const bg = closing(src, w, h, 3);
    expect(bg[10 * w + 5]).toBe(200); // 細い線は背景から消える
    expect(bg[10 * w + 25]).toBe(20); // 広い面は残る
    const s = lineStrength(src, bg);
    expect(s[10 * w + 5]).toBeGreaterThan(200); // 線として強い
    expect(s[10 * w + 25]).toBe(0); // 広い暗い面は線ではない
  });
  it("背景が暗すぎる所は線にしない", () => {
    expect(lineStrength(Uint8Array.from([5]), Uint8Array.from([30]))[0]).toBe(0);
  });
  it("明るさは、白地に重ねたいちばん明るいチャンネル", () => {
    const b = brightness(Uint8ClampedArray.from([255, 0, 0, 255, 0, 0, 0, 0, 10, 20, 30, 255]));
    expect([...b]).toEqual([255, 255, 30]);
  });
});

describe("extractFromPhoto", () => {
  const photo = fakePhoto();
  const r = extractFromPhoto(photo, W, H, { maxLineWidth: 6, cropPaper: true });

  it("紙の部分だけを切り出す（机・キーボード風の線は外れる）", () => {
    expect(r.paperFound).toBe(true);
    expect(r.box.x).toBeGreaterThanOrEqual(30);
    expect(r.box.y).toBeGreaterThanOrEqual(20);
    expect(r.box.x + r.box.width).toBeLessThanOrEqual(230);
    expect(r.box.y + r.box.height).toBeLessThanOrEqual(170);
    expect(r.width).toBe(r.box.width);
    expect(r.dark.length).toBe(r.width * r.height);
  });
  it("影が濃い所でも、明るい所でも、黒い線は強く出る", () => {
    const lx = 80 + 1 - r.box.x; // 左の枠（明るい側）
    const rx = 178 - r.box.x; // 右の枠（影が濃い側）
    const y = 90 - r.box.y;
    expect(at(r.dark, r.width, lx, y)).toBeGreaterThan(190);
    expect(at(r.dark, r.width, rx, y)).toBeGreaterThan(190);
  });
  it("影のなだらかな濃淡と、幅の広い影の帯は線にならない", () => {
    expect(at(r.dark, r.width, 60 - r.box.x, 40 - r.box.y)).toBeLessThan(15);
    expect(at(r.dark, r.width, 150 - r.box.x, 100 - r.box.y)).toBeLessThan(15);
    expect(at(r.dark, r.width, 200 - r.box.x, 40 - r.box.y)).toBeLessThan(15);
  });
  it("紙を切り出さないと、机の上の細い線も拾ってしまう（切り出しが必要な理由）", () => {
    const all = extractFromPhoto(photo, W, H, { maxLineWidth: 6, cropPaper: false });
    expect(all.paperFound).toBe(false);
    expect(all.width).toBe(W);
    expect(at(all.dark, W, 10, 90)).toBeGreaterThan(150);
  });
  it("白い紙全体の画像（スキャン）はそのままの大きさで、線を拾う", () => {
    const scan = new Uint8ClampedArray(60 * 40 * 4).fill(255);
    for (let y = 0; y < 40; y++) scan.set([0, 0, 0, 255], (y * 60 + 30) * 4);
    const s = extractFromPhoto(scan, 60, 40, { maxLineWidth: 6, cropPaper: true });
    expect(s.width).toBe(60);
    expect(s.height).toBe(40);
    expect(at(s.dark, 60, 30, 20)).toBeGreaterThan(240);
    expect(at(s.dark, 60, 10, 20)).toBe(0);
  });
});

describe("extractSimple / defaultMaxLineWidth", () => {
  it("単純な抽出は画素の黒さそのまま（広い黒も黒）", () => {
    const px = new Uint8ClampedArray(8).fill(0);
    px[3] = px[7] = 255;
    const e = extractSimple(px, 2, 1);
    expect([...e.dark]).toEqual([255, 255]);
  });
  it("線の太さの上限の初期値は画像に比例し、6〜60 に収める", () => {
    expect(defaultMaxLineWidth(2048, 1536)).toBe(17);
    expect(defaultMaxLineWidth(100, 100)).toBe(6);
    expect(defaultMaxLineWidth(20000, 100)).toBe(60);
  });
});
