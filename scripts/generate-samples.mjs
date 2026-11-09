// サンプルの線画（白地に黒い線）を public/samples/ に書き出す。依存パッケージなし。
//   node scripts/generate-samples.mjs
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

// ---- 図形（線の中心線）。距離で縁をなめらかにする ----
const seg = (x0, y0, x1, y1) => (x, y) => {
  const dx = x1 - x0, dy = y1 - y0;
  const t = Math.min(1, Math.max(0, ((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(x - (x0 + t * dx), y - (y0 + t * dy));
};
const circle = (cx, cy, r) => (x, y) => Math.abs(Math.hypot(x - cx, y - cy) - r);
const polygon = (pts) => {
  const segs = pts.map((p, i) => seg(...p, ...pts[(i + 1) % pts.length]));
  return (x, y) => Math.min(...segs.map((f) => f(x, y)));
};
const rect = (x0, y0, x1, y1) => polygon([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);

function render(width, height, lineWidth, shapes) {
  const gray = Buffer.alloc(width * height, 255);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let d = Infinity;
      for (const f of shapes) d = Math.min(d, f(x + 0.5, y + 0.5));
      const cover = Math.min(1, Math.max(0, lineWidth / 2 + 0.5 - d));
      gray[y * width + x] = Math.round(255 * (1 - cover));
    }
  }
  return gray;
}

// ---- PNG（8bit グレースケール）を書く ----
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
function png(width, height, gray) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 0; // 8bit、グレースケール
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) gray.copy(raw, y * (width + 1) + 1, y * width, (y + 1) * width);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- サンプル1: 家のある風景（空・地面・壁・屋根・ドア・窓4枚・幹・木の葉・太陽）----
const house = [
  seg(0, 330, 640, 330), // 地面と空の境
  circle(540, 90, 45), // 太陽
  rect(120, 210, 340, 330), // 壁
  polygon([[100, 210], [230, 120], [360, 210]]), // 屋根（壁の上にのる）
  rect(205, 260, 255, 330), // ドア
  rect(140, 235, 190, 275), seg(165, 235, 165, 275), seg(140, 255, 190, 255), // 窓（4枚）
  rect(425, 280, 455, 330), // 木の幹
  circle(440, 225, 55), // 木の葉
];

// ---- サンプル2: 輪と放射線（同じ色でまとめて塗る練習用。領域が多い）----
const cx = 320, cy = 240;
const rings = [
  circle(cx, cy, 40), circle(cx, cy, 90), circle(cx, cy, 140), circle(cx, cy, 190),
  ...Array.from({ length: 8 }, (_, k) => {
    const a = (k * Math.PI) / 4;
    return seg(cx + 40 * Math.cos(a), cy + 40 * Math.sin(a), cx + 190 * Math.cos(a), cy + 190 * Math.sin(a));
  }),
];

mkdirSync("public/samples", { recursive: true });
writeFileSync("public/samples/house.png", png(640, 440, render(640, 440, 4, house)));
writeFileSync("public/samples/rings.png", png(640, 480, render(640, 480, 4, rings)));
console.log("public/samples/house.png, rings.png を書き出した");
