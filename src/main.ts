import {
  centerView,
  clampView,
  fitSize as fitToFrame,
  panBy,
  zoomAt,
  type Frame,
  type View,
} from "./lib/view";
import { analyzeGaps, resolveGaps, type GapAnalysis } from "./lib/gaps";
import { hsvToRgb, rgbToHsv, type Hsv } from "./lib/hsv";
import { ridgeOf, snapToRidge, type SnapPoint } from "./lib/skeleton";
import { capsulePixels } from "./lib/brush";
import { FORMATS, exportSize, isAspect, isFormat } from "./lib/export";
import {
  channelBalance,
  clampChannel,
  compose,
  fillColor,
  fitSize,
  lineAlpha,
  parseHex,
  toCss,
  toHex,
    type Rgba,
} from "./lib/lineart";
import { DEFAULT_SPAN, spanScale, zoomSpan } from "./lib/preview";
import { PALETTE } from "./lib/palette";
import { defaultMaxLineWidth, extractFromPhoto, extractSimple } from "./lib/photo";
import {
  formatRegionList,
  labelRegions,
  parseRegionList,
  pixelsOf,
  type Regions,
} from "./lib/regions";

/** 作業用の画像の長辺の上限（大きすぎるとメモリと処理が重くなる） */
const MAX_SIDE = 4096;
const MAX_HISTORY = 50;
const MAX_RECENT = 12;
const WHITE: Rgba = [255, 255, 255, 255];
const BLACK: Rgba = [0, 0, 0, 255];
const NO_LINE: Rgba = [0, 0, 0, 0];

type Tool = "fill" | "multi" | "brush";
/** ブラシが下の線をどうするか: 残す（線の下に色を敷く）/ 消す（線を消して色で塗る）/ 線の色を変える（線の上だけ） */
type LineMode = "keep" | "erase" | "recolor";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const canvas = $<HTMLCanvasElement>("canvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
const overlay = $<HTMLCanvasElement>("overlay");
const octx = overlay.getContext("2d")!;
const stage = $("stage");
const empty = $("empty");
const status = $("status");
const brushCursor = $("brush-cursor");

interface Doc {
  width: number;
  height: number;
  dark: Uint8Array; // 画素ごとの黒さ
  alpha: Uint8Array; // 現在のしきい値での線の濃さ
  base: Regions; // 線だけで囲まれた領域（隙間は考えない）
  regions: Regions; // 線で囲まれた領域の番号（隙間の扱いを反映したもの。塗る・選ぶ・番号の表示はこちら）
  gaps: GapAnalysis | null; // 線の隙間の検出結果（検出しないときは null）
  ridge: Uint8Array | null; // 線の中心（芯）。ブラシが吸着する先。最初に使うときに作る
  colors: Uint8ClampedArray; // 領域の色（RGBA、初期は不透明な白）
  lines: Uint8ClampedArray; // 線の色（RGBA、初期は不透明な黒。透明にすると線が消える）
  out: ImageData; // 画面に出す最終画像（透明度つき）
  name: string;
}

/** 1つの層への変更。before は indices と同じ順の RGBA */
interface LayerChange {
  before: Uint8ClampedArray;
  after: Rgba;
}

/** 1回の操作の記録。元に戻す・やり直しに使う。色の層・線の層のどちらか、または両方を変える */
interface Edit {
  indices: Int32Array;
  colors?: LayerChange;
  lines?: LayerChange;
}

let doc: Doc | null = null;
let tool: Tool = "fill";
let lineMode: LineMode = "keep";
let threshold = 128;
let color: Rgba = [229, 57, 53, 255];
let brushSize = 12; // 直径（画像の画素）
let showNumbers = false;
let selection = new Set<number>();
let undoStack: Edit[] = [];
let redoStack: Edit[] = [];
let recent: Rgba[] = [];
let snapOn = true; // ブラシを線の中心に吸着させる
const gapOn = true;
/** ふさぐ隙間の最大幅（px）。長辺 2048px のとき 6px で、画像が大きいほど比例して広げる */
const gapWidthFor = (width: number, height: number): number =>
  Math.max(6, Math.round((6 * Math.max(width, height)) / 2048));
const gapEnclosure = 0.85; // 囲まれ具合の下限
let gapMerged = new Set<number>(); // 「同じ領域」にした隙間の候補番号（それ以外は別々）

/** 読み込んだ画像（作業用の大きさに縮小したもの）。抽出の設定を変えたときに作り直すために持っておく */
interface SourceImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  name: string;
}
let source: SourceImage | null = null;
let extractMode: "auto" | "simple" = "auto";

// ---------- 画像の読み込みと線の抽出 ----------

async function loadBlob(blob: Blob, name: string): Promise<void> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    alert("画像を読み込めませんでした。");
    return;
  }
  const { width, height } = fitSize(bitmap.width, bitmap.height, MAX_SIDE);
  // 透明な部分は白として扱うので、白地に描いて読み取る。設定を決めるまで画面のキャンバスには触れない
  const tmp = document.createElement("canvas");
  tmp.width = width;
  tmp.height = height;
  const tctx = tmp.getContext("2d", { willReadFrequently: true })!;
  tctx.imageSmoothingQuality = "high";
  tctx.fillStyle = "#fff";
  tctx.fillRect(0, 0, width, height);
  tctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  appliedLineWidth = defaultMaxLineWidth(width, height);
  openExtractDialog({ data: tctx.getImageData(0, 0, width, height).data, width, height, name });
}

/** 読み込んだ画像から、いまの設定で線を抽出して作業用のデータを作る（塗った色・選択・履歴は作り直しになる） */
function processSource(): void {
  if (!source) return;
  const extracted =
    extractMode === "auto"
      ? extractFromPhoto(source.data, source.width, source.height, {
          maxLineWidth: appliedLineWidth,
          cropPaper: appliedCrop,
        })
      : extractSimple(source.data, source.width, source.height);
  const { width, height, dark } = extracted;

  canvas.width = overlay.width = width;
  canvas.height = overlay.height = height;
  const colors = new Uint8ClampedArray(width * height * 4);
  const lines = new Uint8ClampedArray(width * height * 4);
  fillColor(colors, WHITE);
  fillColor(lines, BLACK);
  doc = {
    width,
    height,
    dark,
    alpha: lineAlpha(dark, threshold),
    base: EMPTY_REGIONS,
    regions: EMPTY_REGIONS,
    gaps: null,
    ridge: null,
    colors,
    lines,
    out: ctx.createImageData(width, height),
    name: source.name.replace(/\.[^.]+$/, "") || "nurie",
  };
  undoStack = [];
  redoStack = [];
  empty.hidden = true;
  stage.hidden = false;
  layout(true);
  rebuildRegions();
  const paper =
    extractMode !== "auto" || !appliedCrop
      ? ""
      : extracted.paperFound
        ? "紙の部分を切り出しました。"
        : "紙の範囲は見つからなかったので、全体から線を抽出しました。";
  setStatus(`${paper}${regionSummary()}`);
  updateButtons();
  askGaps();
}

const EMPTY_REGIONS: Regions = {
  labels: new Int32Array(0),
  count: 0,
  sizes: new Int32Array(1),
  anchors: new Int32Array(1),
};

// ---------- 領域の番号づけと線の隙間 ----------

function regionSummary(): string {
  if (!doc) return "";
  const n = doc.gaps?.candidates.length ?? 0;
  return `${doc.regions.count} 個の領域に番号をつけました。${n > 0 ? `線の隙間の候補が ${n} 件あります。` : ""}`;
}

/** しきい値が変わったとき・画像を作り直したとき: 領域を線から作り直し、隙間も探し直す（選択と隙間の選択は解除） */
function rebuildRegions(): void {
  if (!doc) return;
  doc.base = labelRegions(doc.dark, doc.width, doc.height, threshold);
  doc.ridge = null;
  analyzeNow();
}

/** 隙間の設定が変わったとき: 隙間を探し直す。選びは既定（すべて別々）に戻る */
function analyzeNow(): void {
  if (!doc) return;
  doc.gaps = gapOn
    ? analyzeGaps(doc.base, doc.width, doc.height, { maxWidth: gapWidthFor(doc.width, doc.height), minEnclosure: gapEnclosure })
    : null;
  gapMerged = new Set();
  resolveNow();
}

/** 隙間ごとの「別々 / 同じ」の選びを反映して、領域の番号を作る。塗った色は画素ごとに残る */
function resolveNow(): void {
  if (!doc) return;
  doc.regions = doc.gaps ? resolveGaps(doc.gaps, gapMerged, doc.width, doc.height) : doc.base;
  selection = new Set();
  refreshSelectionUi();
  render();
}

/** 線の中心。最初に使うときに作る */
function getRidge(): Uint8Array {
  const d = doc!;
  if (!d.ridge) {
    const line = new Uint8Array(d.width * d.height);
    for (let i = 0; i < line.length; i++) line[i] = d.base.labels[i] === 0 ? 1 : 0;
    d.ridge = ridgeOf(line, d.width, d.height);
  }
  return d.ridge;
}

/** 抽出の設定を変えると塗った色が消える。消えてよいか確認する（塗った内容がなければ確認しない） */
function confirmDiscard(): boolean {
  return undoStack.length === 0 || confirm("設定を変えると、塗った色は消えます。続けますか？");
}

async function loadFile(file: File): Promise<void> {
  if (document.querySelector("dialog[open]")) return; // ポップアップの操作中は読み込まない
  if (!file.type.startsWith("image/")) {
    alert("画像ファイルを選んでください。");
    return;
  }
  await loadBlob(file, file.name);
}

/** ステータス行に文字を出す。色の見本（chip）をつけられる（値は出さない） */
function setStatus(text: string, chip?: Rgba): void {
  status.replaceChildren();
  if (chip) {
    const c = document.createElement("span");
    c.className = "chip";
    const i = document.createElement("i");
    i.style.background = toCss(chip);
    c.append(i);
    status.append(c);
  }
  status.append(text);
}

// ---------- 描画 ----------

/** 全画素を合成して描く */
function render(): void {
  if (!doc) return;
  compose(doc.colors, doc.lines, doc.alpha, doc.out.data);
  ctx.putImageData(doc.out, 0, 0);
  drawOverlay();
}

/** 指定した画素だけ合成し直して、その外接矩形だけ描く */
function refresh(indices: Int32Array): void {
  if (!doc || indices.length === 0) return;
  const { width } = doc;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  for (const i of indices) {
    compose(doc.colors, doc.lines, doc.alpha, doc.out.data, i, i + 1);
    const x = i % width;
    const y = (i - x) / width;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  ctx.putImageData(doc.out, 0, 0, minX, minY, maxX - minX + 1, maxY - minY + 1);
}

/** 選択中の領域（斜線）と、領域の番号を重ねて描く */
function drawOverlay(): void {
  octx.clearRect(0, 0, overlay.width, overlay.height);
  if (!doc) return;
  const { labels, count, sizes, anchors } = doc.regions;

  if (selection.size > 0) {
    const flags = new Uint8Array(count + 1);
    for (const id of selection) flags[id] = 1;
    const img = octx.createImageData(doc.width, doc.height);
    // 塗った色が見えるように、べた塗りではなく斜線（幅 3px、間隔 9px）で示す
    for (let i = 0; i < labels.length; i++) {
      if (!flags[labels[i]!]) continue;
      const x = i % doc.width;
      const y = (i - x) / doc.width;
      if ((x + y) % 9 < 3) img.data.set([37, 99, 235, 200], i * 4);
    }
    octx.putImageData(img, 0, 0);
  }

  if (showNumbers) {
    const fs = Math.min(28, Math.max(10, Math.round(Math.min(doc.width, doc.height) / 40)));
    octx.font = `bold ${fs}px system-ui, sans-serif`;
    octx.textAlign = "center";
    octx.textBaseline = "middle";
    octx.lineJoin = "round";
    octx.lineWidth = fs / 3;
    for (let id = 1; id <= count; id++) {
      if (sizes[id]! < fs * fs * 2) continue; // 小さすぎる領域には文字が入らない
      const a = anchors[id]!;
      const x = (a % doc.width) + 0.5;
      const y = Math.floor(a / doc.width) + 0.5;
      octx.strokeStyle = "#fff";
      octx.strokeText(String(id), x, y);
      octx.fillStyle = "#111";
      octx.fillText(String(id), x, y);
    }
  }
}

// ---------- 操作の記録・適用 ----------

function apply(edit: Edit): void {
  if (!doc) return;
  for (const px of edit.indices) {
    if (edit.colors) doc.colors.set(edit.colors.after, px * 4);
    if (edit.lines) doc.lines.set(edit.lines.after, px * 4);
  }
  refresh(edit.indices);
}

function revert(edit: Edit): void {
  if (!doc) return;
  edit.indices.forEach((px, k) => {
    if (edit.colors) doc!.colors.set(edit.colors.before.subarray(k * 4, k * 4 + 4), px * 4);
    if (edit.lines) doc!.lines.set(edit.lines.before.subarray(k * 4, k * 4 + 4), px * 4);
  });
  refresh(edit.indices);
}

function record(edit: Edit): void {
  undoStack.push(edit);
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack = [];
  rememberColor(color);
  updateButtons();
}

function snapshot(buf: Uint8ClampedArray, indices: Int32Array): Uint8ClampedArray {
  const before = new Uint8ClampedArray(indices.length * 4);
  indices.forEach((px, k) => before.set(buf.subarray(px * 4, px * 4 + 4), k * 4));
  return before;
}

/** 領域（番号の集合）を、いまの色で塗る。1回の操作として記録する */
function paintRegions(ids: ReadonlySet<number>): void {
  if (!doc || ids.size === 0) return;
  const indices = pixelsOf(doc.regions.labels, ids);
  if (indices.length === 0) return;
  const edit: Edit = {
    indices,
    colors: { before: snapshot(doc.colors, indices), after: color },
  };
  apply(edit);
  record(edit);
}

// ---------- ブラシ（線に沿って塗る） ----------

interface Stroke {
  mode: LineMode;
  paint: Rgba;
  touched: Uint8Array;
  indices: number[];
  colorsBefore: number[];
  linesBefore: number[];
  lastX: number; // 直前に塗った位置（ここから次の位置までをなぞる）
  lastY: number;
  snap: SnapPoint | null; // 直前の線の中心への吸着先。線から離れているときは null
  px: number; // 直前のペンの位置
  py: number;
}
let stroke: Stroke | null = null;

/**
 * ペンの位置に対する、塗る位置。吸着オンなら、近くの線の中心（芯）。線から遠ければ null（塗らない）。
 * 吸着オフならペンの位置そのまま。
 */
function snapPoint(x: number, y: number): SnapPoint | null {
  if (!doc) return null;
  if (!snapOn) return { x, y };
  // 吸着できる距離（画像の画素）。ブラシが太いほど遠くまで
  const radius = Math.max(24, brushSize * 1.5);
  return snapToRidge(getRidge(), doc.width, doc.height, x, y, radius, stroke?.snap ?? null);
}

function startStroke(x: number, y: number): void {
  if (!doc) return;
  stroke = {
    mode: lineMode,
    paint: color,
    touched: new Uint8Array(doc.width * doc.height),
    indices: [],
    colorsBefore: [],
    linesBefore: [],
    lastX: x,
    lastY: y,
    snap: null,
    px: x,
    py: y,
  };
  advanceStroke(x, y, snapPoint(x, y));
}

/**
 * ペンが (x, y) に来たとき、塗る位置 sp まで塗り進める。
 * ペンを線からはずすと、その間は塗らない。吸着先が別の線へ大きく飛んだときは、線でつながないで、その点だけ塗る。
 */
function advanceStroke(x: number, y: number, sp: SnapPoint | null): void {
  const s = stroke;
  if (!s) return;
  const step = Math.hypot(x - s.px, y - s.py);
  s.px = x;
  s.py = y;
  if (!sp) {
    s.snap = null;
    return;
  }
  if (!s.snap || Math.hypot(sp.x - s.snap.x, sp.y - s.snap.y) > 2 * step + 4) {
    s.lastX = sp.x;
    s.lastY = sp.y;
  }
  s.snap = sp;
  extendStroke(sp.x, sp.y);
}

/**
 * 前の点から (x, y) までなぞった範囲を塗る。ブラシの半径の分、線の左右にはみ出して塗れる。
 * - 残す: 色の層に塗る（線は上に重なって残る）
 * - 消す: 色の層に塗り、線の層を透明にする（線が消える）
 * - 線の色を変える: 線の上の画素の、線の色だけを変える
 */
function extendStroke(x: number, y: number): void {
  if (!doc || !stroke) return;
  const s = stroke;
  const covered = capsulePixels(s.lastX, s.lastY, x, y, brushSize / 2, doc.width, doc.height);
  s.lastX = x;
  s.lastY = y;
  const fresh: number[] = [];
  for (const i of covered) {
    if (s.touched[i]) continue;
    if (s.mode === "recolor" && doc.alpha[i] === 0) continue; // 線でない画素は塗らない
    s.touched[i] = 1;
    s.indices.push(i);
    if (s.mode !== "recolor") {
      s.colorsBefore.push(...doc.colors.subarray(i * 4, i * 4 + 4));
      doc.colors.set(s.paint, i * 4);
    }
    if (s.mode !== "keep") {
      s.linesBefore.push(...doc.lines.subarray(i * 4, i * 4 + 4));
      doc.lines.set(s.mode === "erase" ? NO_LINE : s.paint, i * 4);
    }
    fresh.push(i);
  }
  refresh(Int32Array.from(fresh));
}

/** ストロークを終えて、1つの操作にまとめる。何も塗らなかったときは null */
function finishStroke(): Edit | null {
  if (!stroke) return null;
  const s = stroke;
  stroke = null;
  if (s.indices.length === 0) return null;
  const edit: Edit = { indices: Int32Array.from(s.indices) };
  if (s.mode !== "recolor") {
    edit.colors = { before: Uint8ClampedArray.from(s.colorsBefore), after: s.paint };
  }
  if (s.mode !== "keep") {
    edit.lines = {
      before: Uint8ClampedArray.from(s.linesBefore),
      after: s.mode === "erase" ? NO_LINE : s.paint,
    };
  }
  return edit;
}

function endStroke(): void {
  const edit = finishStroke();
  if (edit) record(edit);
}

/** ストロークを取り消す（Esc）。塗りかけた分は元に戻す */
function cancelStroke(): void {
  const edit = finishStroke();
  if (edit) revert(edit);
}

// ---------- キャンバスの操作 ----------

function pixelAt(ev: PointerEvent): { x: number; y: number } | null {
  if (!doc) return null;
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((ev.clientX - rect.left) / rect.width) * doc.width,
    y: ((ev.clientY - rect.top) / rect.height) * doc.height,
  };
}

/** 塗る・選ぶ操作（フィル・複数選択ツールのクリック） */
function clickAt(p: { x: number; y: number }): void {
  if (!doc) return;
  const x = Math.floor(p.x);
  const y = Math.floor(p.y);
  if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return;
  const id = doc.regions.labels[y * doc.width + x]!;
  if (id === 0) return; // 線の上
  if (tool === "fill") {
    paintRegions(new Set([id]));
  } else {
    if (selection.has(id)) selection.delete(id);
    else selection.add(id);
    refreshSelectionUi();
    drawOverlay();
  }
}

// ---------- 拡大・縮小と平行移動 ----------

const viewport = $("viewport");
let view: View = { scale: 1, tx: 0, ty: 0 };
let content = { cw: 1, ch: 1 }; // 等倍のときの紙面の表示サイズ（px）

const frame = (): Frame => ({ ...content, w: viewport.clientWidth, h: viewport.clientHeight });

function setView(next: View): void {
  view = next;
  stage.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`;
}

/** 紙面の等倍の大きさを、いまの表示枠に合わせ直す。reset なら中央に置いた等倍に戻す */
function layout(reset: boolean): void {
  if (!doc) return;
  const size = fitToFrame(doc.width, doc.height, viewport.clientWidth, viewport.clientHeight);
  content = { cw: size.width, ch: size.height };
  stage.style.width = `${size.width}px`;
  stage.style.height = `${size.height}px`;
  setView(reset ? centerView(frame()) : clampView(view, frame()));
}
new ResizeObserver(() => layout(false)).observe(viewport);

/** 画像の点 (x, y)（画素）が表示枠の中央に来るように、scale 倍で表示する */
function focusOn(x: number, y: number, scale: number): void {
  if (!doc) return;
  const f = frame();
  const s = Math.min(40, Math.max(1, scale));
  const px = (x / doc.width) * f.cw;
  const py = (y / doc.height) * f.ch;
  setView(clampView({ scale: s, tx: f.w / 2 - px * s, ty: f.h / 2 - py * s }, f));
}

/** 表示枠の中央を動かさずに拡大・縮小する（キー操作用） */
function zoomCenter(factor: number): void {
  if (!doc) return;
  setView(zoomAt(view, factor, viewport.clientWidth / 2, viewport.clientHeight / 2, frame()));
}

// ホイールの縦回転は拡大・縮小、横回転は横移動（ピンチ操作は ctrl 付きのホイールとして届き、拡大・縮小になる）
viewport.addEventListener(
  "wheel",
  (ev) => {
    if (!doc) return;
    ev.preventDefault();
    const unit = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? viewport.clientHeight : 1;
    if (!ev.ctrlKey && Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) {
      setView(panBy(view, -ev.deltaX * unit, 0, frame()));
    } else {
      const rect = viewport.getBoundingClientRect();
      const factor = Math.exp(-ev.deltaY * unit * (ev.ctrlKey ? 0.01 : 0.0015));
      setView(zoomAt(view, factor, ev.clientX - rect.left, ev.clientY - rect.top, frame()));
    }
  },
  { passive: false },
);

// 平行移動: フィル・複数選択ツールでは左ボタンのドラッグ（動かさずに離せばクリック）。
// ブラシは左ドラッグが描画なので、スペースキーを押しながら、または中ボタンのドラッグで移動する
const DRAG_THRESHOLD = 4;
let spaceDown = false;
let drag: {
  id: number;
  lastX: number;
  lastY: number;
  startX: number;
  startY: number;
  moved: boolean;
  click: { x: number; y: number } | null;
} | null = null;

window.addEventListener("keyup", (ev) => {
  if (ev.code === "Space") spaceDown = false;
});
window.addEventListener("blur", () => {
  spaceDown = false;
});

canvas.addEventListener("pointerdown", (ev) => {
  const p = pixelAt(ev);
  if (!doc || !p) return;
  if (ev.button !== 0 && ev.button !== 1) return;
  const panOnly = ev.button === 1 || spaceDown;
  if (panOnly || tool !== "brush") {
    ev.preventDefault();
    canvas.setPointerCapture(ev.pointerId);
    drag = {
      id: ev.pointerId,
      lastX: ev.clientX,
      lastY: ev.clientY,
      startX: ev.clientX,
      startY: ev.clientY,
      moved: panOnly,
      click: panOnly ? null : p,
    };
    if (panOnly) stage.classList.add("panning");
    return;
  }
  const x = Math.floor(p.x);
  const y = Math.floor(p.y);
  if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return;
  canvas.setPointerCapture(ev.pointerId);
  startStroke(p.x, p.y);
});

function endDrag(ev: PointerEvent, cancelled: boolean): void {
  if (!drag || drag.id !== ev.pointerId) return;
  const d = drag;
  drag = null;
  stage.classList.remove("panning");
  if (!d.moved && d.click && !cancelled) clickAt(d.click);
}

canvas.addEventListener("pointermove", (ev) => {
  if (drag && drag.id === ev.pointerId) {
    if (!drag.moved && Math.hypot(ev.clientX - drag.startX, ev.clientY - drag.startY) > DRAG_THRESHOLD) {
      drag.moved = true;
      stage.classList.add("panning");
    }
    if (drag.moved) {
      setView(panBy(view, ev.clientX - drag.lastX, ev.clientY - drag.lastY, frame()));
    }
    drag.lastX = ev.clientX;
    drag.lastY = ev.clientY;
    brushCursor.hidden = true;
    return;
  }
  const p = pixelAt(ev);
  if (!doc || !p) return;
  if (tool === "brush") {
    // ブラシの大きさの円をカーソルにする。吸着オンのときは、塗られる位置（線の中心）に出す。線から遠いときは点線で、ペンの位置に
    const sp = snapPoint(p.x, p.y);
    // ステージ内の座標（ステージ自体が拡大されているので、等倍の表示サイズを基準にする）
    const d = (brushSize * content.cw) / doc.width;
    const at = sp ?? p;
    brushCursor.hidden = spaceDown;
    brushCursor.classList.toggle("off", sp === null);
    brushCursor.style.width = brushCursor.style.height = `${d}px`;
    brushCursor.style.left = `${(at.x / doc.width) * content.cw}px`;
    brushCursor.style.top = `${(at.y / doc.height) * content.ch}px`;
    if (stroke) advanceStroke(p.x, p.y, sp);
    return;
  }
  const x = Math.floor(p.x);
  const y = Math.floor(p.y);
  if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return;
  const id = doc.regions.labels[y * doc.width + x]!;
  if (id === 0) {
    setStatus("線の上");
  } else {
    const a = doc.regions.anchors[id]!;
    const c = doc.colors.subarray(a * 4, a * 4 + 4);
    setStatus(
      `領域 #${id}（${doc.regions.sizes[id]} px）${selection.has(id) ? " ［選択中］" : ""}`,
      [c[0]!, c[1]!, c[2]!, c[3]!],
    );
  }
});
canvas.addEventListener("pointerup", (ev) => {
  endDrag(ev, false);
  endStroke();
});
canvas.addEventListener("pointercancel", (ev) => {
  endDrag(ev, true);
  endStroke();
});

// マウスの戻る（ボタン4）・進む（ボタン5）は、ブラウザの履歴ではなく元に戻す・やり直しにする。
// キーボードや画面のボタンからの操作とはイベントの種類が違うので、混ざらない
for (const type of ["mousedown", "mouseup", "auxclick"] as const) {
  window.addEventListener(type, (ev) => {
    if (ev.button !== 3 && ev.button !== 4) return;
    ev.preventDefault();
    if (type !== "mouseup") return;
    if (ev.button === 3) undo();
    else redo();
  });
}

canvas.addEventListener("pointerleave", () => {
  brushCursor.hidden = true;
});

// ---------- 選択（複数領域） ----------

function refreshSelectionUi(): void {
  $<HTMLInputElement>("region-text").value = formatRegionList(selection);
  $("selection-text").textContent = doc
    ? `選択中 ${selection.size} / ${doc.regions.count} 領域`
    : "画像を開くと領域に番号がつきます";
  updateButtons();
}

function selectByText(): void {
  if (!doc) return;
  const { ids, ignored } = parseRegionList($<HTMLInputElement>("region-text").value, doc.regions.count);
  selection = new Set(ids);
  refreshSelectionUi();
  drawOverlay();
  if (ignored.length > 0) {
    setStatus(`無視した指定: ${ignored.join(", ")}（番号は 1〜${doc.regions.count}）`);
  }
}

$("region-select").addEventListener("click", selectByText);
$("region-text").addEventListener("keydown", (ev) => {
  if ((ev as KeyboardEvent).key === "Enter") selectByText();
});
$("select-all").addEventListener("click", selectAll);
$("select-none").addEventListener("click", () => {
  selection = new Set();
  refreshSelectionUi();
  drawOverlay();
});
$("paint-selected").addEventListener("click", () => paintRegions(selection));
$("show-numbers").addEventListener("click", toggleNumbers);

// ---------- ツール・線の扱い ----------

/** ボタンの並び（data-xxx 属性つき）から1つを選んだ状態にする */
function chooseButton(buttons: NodeListOf<HTMLElement>, attr: string, value: string): void {
  buttons.forEach((b) => b.classList.toggle("on", b.dataset[attr] === value));
}

const toolButtons = document.querySelectorAll<HTMLElement>("[data-tool]:not(#stage)");
function setTool(next: Tool): void {
  tool = next;
  stage.dataset.tool = next;
  chooseButton(toolButtons, "tool", next);
  document.querySelectorAll<HTMLElement>("[data-for]").forEach((g) => {
    g.hidden = g.dataset.for !== next;
  });
  if (next !== "brush") brushCursor.hidden = true;
}
toolButtons.forEach((b) => b.addEventListener("click", () => setTool(b.dataset.tool as Tool)));

const lineModeButtons = document.querySelectorAll<HTMLElement>("[data-linemode]");
lineModeButtons.forEach((b) =>
  b.addEventListener("click", () => {
    lineMode = b.dataset.linemode as LineMode;
    chooseButton(lineModeButtons, "linemode", lineMode);
  }),
);

$<HTMLInputElement>("snap").addEventListener("change", (ev) => {
  snapOn = (ev.target as HTMLInputElement).checked;
});

const brushRange = $<HTMLInputElement>("brush");
const brushNumber = $<HTMLInputElement>("brush-n");
function setBrush(v: number, from: HTMLInputElement | null): void {
  brushSize = Math.min(60, Math.max(1, Math.round(Number.isFinite(v) ? v : 1)));
  if (from !== brushRange) brushRange.value = String(brushSize);
  if (from !== brushNumber) brushNumber.value = String(brushSize);
}
brushRange.addEventListener("input", () => setBrush(Number(brushRange.value), brushRange));
brushNumber.addEventListener("input", () => setBrush(Number(brushNumber.value), brushNumber));

// ---------- 元に戻す・消去・保存 ----------

function undo(): void {
  const edit = undoStack.pop();
  if (!edit) return;
  revert(edit);
  redoStack.push(edit);
  updateButtons();
}

function redo(): void {
  const edit = redoStack.pop();
  if (!edit) return;
  apply(edit);
  undoStack.push(edit);
  updateButtons();
}

function clearColors(): void {
  if (!doc) return;
  fillColor(doc.colors, WHITE);
  undoStack = [];
  redoStack = [];
  render();
  updateButtons();
}

function resetLines(): void {
  if (!doc) return;
  fillColor(doc.lines, BLACK);
  undoStack = [];
  redoStack = [];
  render();
  updateButtons();
}

function save(): void {
  if (!doc) return;
  const fmtValue = $<HTMLSelectElement>("export-format").value;
  const aspectValue = $<HTMLSelectElement>("export-aspect").value;
  const fmt = FORMATS[isFormat(fmtValue) ? fmtValue : "png"];
  const aspect = isAspect(aspectValue) ? aspectValue : "original";
  const size = exportSize(doc.width, doc.height, aspect);
  const out = document.createElement("canvas");
  out.width = size.width;
  out.height = size.height;
  const octx = out.getContext("2d")!;
  // 透明度のない形式（JPEG）は、余白も透けている部分も白で埋める
  if (!fmt.alpha) {
    octx.fillStyle = "#fff";
    octx.fillRect(0, 0, out.width, out.height);
  }
  octx.drawImage(canvas, Math.floor((size.width - doc.width) / 2), Math.floor((size.height - doc.height) / 2));
  const name = doc.name;
  out.toBlob(
    (blob) => {
      if (!blob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${name}-colored.${fmt.ext}`;
      a.click();
      URL.revokeObjectURL(a.href);
    },
    fmt.mime,
    0.95,
  );
}

function updateButtons(): void {
  const has = doc !== null;
  $<HTMLButtonElement>("undo").disabled = undoStack.length === 0;
  $<HTMLButtonElement>("redo").disabled = redoStack.length === 0;
  $<HTMLButtonElement>("clear").disabled = !has;
  $<HTMLButtonElement>("reset-lines").disabled = !has;
  $<HTMLButtonElement>("open-extract").disabled = !has;
  $<HTMLButtonElement>("save").disabled = !has;
  $<HTMLButtonElement>("select-all").disabled = !has;
  $<HTMLButtonElement>("select-none").disabled = selection.size === 0;
  $<HTMLButtonElement>("paint-selected").disabled = selection.size === 0;
}

$("undo").addEventListener("click", undo);
$("redo").addEventListener("click", redo);
$("clear").addEventListener("click", clearColors);
$("reset-lines").addEventListener("click", resetLines);

// 保存: ボタンを押すと、ポップアップで形式・縦横比を選ぶ
const exportDialog = $<HTMLDialogElement>("export-dialog");
function updateExportSize(): void {
  if (!doc) return;
  const aspectValue = $<HTMLSelectElement>("export-aspect").value;
  const size = exportSize(doc.width, doc.height, isAspect(aspectValue) ? aspectValue : "original");
  $("export-size").textContent = `${size.width} × ${size.height} px`;
}
function openExport(): void {
  if (!doc || exportDialog.open) return;
  updateExportSize();
  exportDialog.showModal();
}
$("export-aspect").addEventListener("change", updateExportSize);
$("export-cancel").addEventListener("click", () => exportDialog.close());
$("export-ok").addEventListener("click", () => {
  exportDialog.close();
  save();
});
$("save").addEventListener("click", openExport);

// ショートカット一覧は、ボタンで開閉する
$("keys-toggle").addEventListener("click", () => {
  const keys = $("keys");
  keys.hidden = !keys.hidden;
  $("keys-toggle").setAttribute("aria-expanded", String(!keys.hidden));
  $("keys-toggle").textContent = keys.hidden ? "⌨ ショートカット一覧を表示" : "⌨ ショートカット一覧を隠す";
});

// ---------- キーボードショートカット（CAD や画像編集ソフトで一般的なもの） ----------
// Z 元に戻す / Y やり直し（Ctrl 付きも可）、F 塗りつぶし / V 複数選択 / B ブラシ、[ ] ブラシの太さ、
// Enter 選択を塗る、Esc 選択解除、Ctrl+A すべて選択、N 番号の表示、+ - 0 表示の拡大・縮小・全体、Ctrl+S 保存。
// 文字・数値の入力欄やリストの操作中は、入力を優先して何もしない

function isTyping(t: EventTarget | null): boolean {
  return (
    t instanceof HTMLTextAreaElement ||
    t instanceof HTMLSelectElement ||
    (t instanceof HTMLInputElement && (t.type === "text" || t.type === "number"))
  );
}

function selectAll(): void {
  if (!doc) return;
  selection = new Set(Array.from({ length: doc.regions.count }, (_, k) => k + 1));
  refreshSelectionUi();
  drawOverlay();
}

function toggleNumbers(): void {
  showNumbers = !showNumbers;
  $("show-numbers").classList.toggle("on", showNumbers);
  $("show-numbers").setAttribute("aria-pressed", String(showNumbers));
  drawOverlay();
}

function nudgeBrush(delta: number): void {
  setBrush(brushSize + delta, null);
}

window.addEventListener("keydown", (ev) => {
  if (isTyping(ev.target) || ev.altKey || ev.isComposing || document.querySelector("dialog[open]")) return;
  const mod = ev.ctrlKey || ev.metaKey;
  const control = ev.target instanceof HTMLButtonElement || ev.target instanceof HTMLInputElement;

  if (mod) {
    switch (ev.code) {
      case "KeyZ":
        if (ev.shiftKey) redo();
        else undo();
        break;
      case "KeyY":
        redo();
        break;
      case "KeyA":
        selectAll();
        break;
      case "KeyS":
        openExport();
        break;
      default:
        return; // コピー・貼り付けなどはブラウザに任せる
    }
    ev.preventDefault();
    return;
  }

  switch (ev.code) {
    case "KeyZ":
      undo();
      break;
    case "KeyY":
      redo();
      break;
    case "KeyF":
      setTool("fill");
      break;
    case "KeyV":
      setTool("multi");
      break;
    case "KeyB":
      setTool("brush");
      break;
    case "KeyN":
      toggleNumbers();
      break;
    case "Escape":
      if (stroke) cancelStroke();
      else if (selection.size > 0) {
        selection = new Set();
        refreshSelectionUi();
        drawOverlay();
      }
      break;
    case "Enter":
      if (control) return; // ボタンの操作（Enter で押す）を邪魔しない
      paintRegions(selection);
      break;
    case "Space":
      if (control) return;
      spaceDown = true;
      break;
    default:
      switch (ev.key) {
        case "[":
          nudgeBrush(-2);
          break;
        case "]":
          nudgeBrush(2);
          break;
        case "+":
        case "=":
          zoomCenter(1.25);
          break;
        case "-":
          zoomCenter(0.8);
          break;
        case "0":
          layout(true);
          break;
        default:
          return;
      }
  }
  ev.preventDefault();
});

// ---------- 線描化の設定（画像を読み込んだ直後に、ポップアップで決める） ----------

const extractDialog = $<HTMLDialogElement>("extract-dialog");
const lineWidthRange = $<HTMLInputElement>("line-width");
const lineWidthNumber = $<HTMLInputElement>("line-width-n");
const cropPaper = $<HTMLInputElement>("crop-paper");
const thresholdInput = $<HTMLInputElement>("threshold");
const extractButtons = document.querySelectorAll<HTMLElement>("[data-extract]");
const previewCanvas = $<HTMLCanvasElement>("extract-preview");
const pctx = previewCanvas.getContext("2d")!;
/** 決定した設定（ポップアップの部品は、決定するまでの下書き） */
let appliedLineWidth = Number(lineWidthRange.value);
let appliedCrop = cropPaper.checked;

const PREVIEW_SIDE = 640;
/** ポップアップで設定中の画像と、そのプレビュー用の縮小版・抽出結果 */
let dialogSource: SourceImage | null = null;
let previewSource: { data: Uint8ClampedArray; width: number; height: number; k: number } | null = null;
let previewDark: { dark: Uint8Array; width: number; height: number } | null = null;
let draftMode: "auto" | "simple" = "auto";
let previewTimer = 0;

/** 下書きの部品の状態（自動のときだけ使える項目の有効・無効） */
function syncExtractUi(): void {
  chooseButton(extractButtons, "extract", draftMode);
  const auto = draftMode === "auto";
  lineWidthRange.disabled = lineWidthNumber.disabled = cropPaper.disabled = !auto;
}

function openExtractDialog(src: SourceImage): void {
  dialogSource = src;
  // プレビューは縮小した画像で作る（線の太さも同じ比率で縮める）
  const k = Math.min(1, PREVIEW_SIDE / Math.max(src.width, src.height));
  const pw = Math.max(1, Math.round(src.width * k));
  const ph = Math.max(1, Math.round(src.height * k));
  const full = document.createElement("canvas");
  full.width = src.width;
  full.height = src.height;
  full.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(src.data), src.width, src.height), 0, 0);
  const small = document.createElement("canvas");
  small.width = pw;
  small.height = ph;
  const sctx = small.getContext("2d", { willReadFrequently: true })!;
  sctx.imageSmoothingQuality = "high";
  sctx.drawImage(full, 0, 0, pw, ph);
  previewSource = { data: sctx.getImageData(0, 0, pw, ph).data, width: pw, height: ph, k };
  previewDark = null;

  draftMode = extractMode;
  lineWidthRange.value = lineWidthNumber.value = String(appliedLineWidth);
  cropPaper.checked = appliedCrop;
  thresholdInput.value = String(threshold);
  $("threshold-value").textContent = String(threshold);
  syncExtractUi();
  extractDialog.showModal();
  updatePreview(true);
}

/** プレビューを描く。再抽出が要るとき（方法・切り出し・線の太さ）は extract = true。しきい値だけなら抽出済みの黒さから作り直す */
function updatePreview(extract: boolean): void {
  const p = previewSource;
  if (!p) return;
  if (extract || !previewDark) {
    const lw = Math.max(3, Math.round(Number(lineWidthRange.value) * p.k));
    const e =
      draftMode === "auto"
        ? extractFromPhoto(p.data, p.width, p.height, { maxLineWidth: lw, cropPaper: cropPaper.checked })
        : extractSimple(p.data, p.width, p.height);
    previewDark = { dark: e.dark, width: e.width, height: e.height };
  }
  const { dark, width, height } = previewDark;
  const alpha = lineAlpha(dark, Number(thresholdInput.value));
  previewCanvas.width = width;
  previewCanvas.height = height;
  const img = pctx.createImageData(width, height);
  for (let i = 0; i < alpha.length; i++) {
    const v = 255 - alpha[i]!;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  pctx.putImageData(img, 0, 0);
}

/** 再抽出は重いので、操作が止まってから */
function schedulePreview(): void {
  window.clearTimeout(previewTimer);
  previewTimer = window.setTimeout(() => updatePreview(true), 150);
}

extractButtons.forEach((b) =>
  b.addEventListener("click", () => {
    draftMode = b.dataset.extract as "auto" | "simple";
    syncExtractUi();
    updatePreview(true);
  }),
);
function onLineWidth(from: HTMLInputElement): void {
  const v = Math.min(60, Math.max(3, Math.round(Number(from.value) || 3)));
  lineWidthRange.value = lineWidthNumber.value = String(v);
  schedulePreview();
}
lineWidthRange.addEventListener("input", () => onLineWidth(lineWidthRange));
lineWidthNumber.addEventListener("input", () => onLineWidth(lineWidthNumber));
cropPaper.addEventListener("change", () => updatePreview(true));
thresholdInput.addEventListener("input", () => {
  $("threshold-value").textContent = thresholdInput.value;
  updatePreview(false);
});

function closeExtractDialog(): void {
  window.clearTimeout(previewTimer);
  extractDialog.close();
}

$("extract-cancel").addEventListener("click", closeExtractDialog);
extractDialog.addEventListener("close", () => {
  // Esc で閉じたときも、プレビュー用の画像を手放す
  window.clearTimeout(previewTimer);
  dialogSource = null;
  previewSource = null;
  previewDark = null;
});
$("extract-ok").addEventListener("click", () => {
  const src = dialogSource;
  if (!src) return;
  const reopened = src === source; // 読み込み済みの画像の設定を開き直したときだけ、塗った色が消える
  if (reopened && !confirmDiscard()) return;
  extractMode = draftMode;
  appliedLineWidth = Math.min(60, Math.max(3, Math.round(Number(lineWidthRange.value) || 3)));
  appliedCrop = cropPaper.checked;
  threshold = Number(thresholdInput.value);
  closeExtractDialog();
  source = src;
  processSource();
});
$("open-extract").addEventListener("click", () => {
  if (source) openExtractDialog(source);
});

// ---------- 線の隙間の確認（画像を読み込んだ直後に、ポップアップで必ず選ばせる） ----------

const gapDialog = $<HTMLDialogElement>("gap-dialog");
let gapPending = false; // 選び終えるまで閉じさせない
gapDialog.addEventListener("cancel", (ev) => ev.preventDefault()); // Esc で閉じさせない
gapDialog.addEventListener("close", () => {
  if (gapPending) gapDialog.showModal(); // ブラウザが Esc で閉じてしまったときは開き直す
});

/**
 * 隙間の位置の周りを切り出した小さな絵（中心に印）。
 * 絵の上でホイールを回すと、隙間を中心に拡大縮小する（絵ごとに独立。平行移動はしない）。
 */
function gapPreview(x: number, y: number): HTMLCanvasElement {
  const size = 96;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  c.title = "ホイールで拡大・縮小";
  const g = c.getContext("2d")!;
  g.imageSmoothingEnabled = false;
  let span = DEFAULT_SPAN; // 切り出す範囲（画像の画素）
  const draw = (): void => {
    g.fillStyle = "#fff";
    g.fillRect(0, 0, size, size);
    g.drawImage(canvas, x - span / 2, y - span / 2, span, span, 0, 0, size, size);
    g.beginPath();
    g.arc(size / 2, size / 2, 14, 0, Math.PI * 2);
    g.lineWidth = 2;
    g.strokeStyle = "#f97316";
    g.stroke();
  };
  c.addEventListener(
    "wheel",
    (ev) => {
      ev.preventDefault(); // 一覧のスクロールではなく拡大縮小にする
      span = zoomSpan(span, ev.deltaY);
      c.title = `${spanScale(span).toFixed(1)} 倍（ホイールで拡大・縮小）`;
      draw();
    },
    { passive: false },
  );
  draw();
  return c;
}

/** 隙間の候補があれば、別々 / 同じ を選ぶポップアップを出す。決定すると領域の番号を作り直す */
function askGaps(): void {
  const cands = doc?.gaps?.candidates ?? [];
  if (!doc || cands.length === 0) return;
  const list = $("gap-dialog-list");
  list.replaceChildren();
  for (const c of cands) {
    const item = document.createElement("div");
    item.className = "gap-item";
    const info = document.createElement("div");
    info.className = "info";
    info.textContent = `#${c.id}　幅 ${c.width}px・囲まれ具合 ${Math.round(c.enclosure * 100)}%`;
    const choices = document.createElement("div");
    choices.className = "choices";
    for (const same of [false, true]) {
      const label = document.createElement("label");
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = `gap-${c.id}`;
      radio.value = same ? "same" : "split";
      radio.checked = !same; // 既定は別々
      label.append(radio, same ? "同じ領域のまま" : "別々の領域にする");
      choices.append(label);
    }
    item.append(gapPreview(c.x, c.y), info, choices);
    list.append(item);
  }
  gapPending = true;
  gapDialog.showModal();
}

function setAllGaps(value: "split" | "same"): void {
  gapDialog.querySelectorAll<HTMLInputElement>(`input[type="radio"][value="${value}"]`).forEach((r) => (r.checked = true));
}
$("gap-all-split").addEventListener("click", () => setAllGaps("split"));
$("gap-all-same").addEventListener("click", () => setAllGaps("same"));
$("gap-ok").addEventListener("click", () => {
  const cands = doc?.gaps?.candidates ?? [];
  gapMerged = new Set(
    cands.filter((c) => gapDialog.querySelector<HTMLInputElement>(`input[name="gap-${c.id}"]:checked`)?.value === "same").map((c) => c.id),
  );
  gapPending = false;
  gapDialog.close();
  resolveNow();
  setStatus(regionSummary());
});

// ---------- 色（パレット・スペクトル・RGB + 透明度）。RGB の値を出すのはここだけ ----------

const svPanel = $("sv");
const svKnob = $("sv-knob");
const hueRange = $<HTMLInputElement>("hue");
const rgbInputs = (["r", "g", "b"] as const).map((id) => $<HTMLInputElement>(id));
const alphaNumber = $<HTMLInputElement>("a");
const alphaRange = $<HTMLInputElement>("a-range");
/** 色相・彩度・明度。黒や灰色（彩度 0）にしても色相を忘れないよう、RGB とは別に持つ */
let hsv: Hsv = rgbToHsv(color[0], color[1], color[2]);

/**
 * いまの色を決めて、パネルの各部分に反映する。from は操作中の部品（その部品の値は書き換えない）。
 * パネル（四角・色相）から決めたときは hsv も渡して、色相が丸め誤差でずれないようにする。
 */
function setColor(next: Rgba, from?: HTMLElement, fromHsv?: Hsv): void {
  color = [clampChannel(next[0]), clampChannel(next[1]), clampChannel(next[2]), clampChannel(next[3])];
  const [r, g, b, a] = color;
  if (fromHsv) {
    hsv = fromHsv;
  } else {
    const t = rgbToHsv(r, g, b);
    hsv = { h: t.s === 0 || t.v === 0 ? hsv.h : t.h, s: t.s, v: t.v };
  }
  $("swatch").style.background = toCss(color);
  const [hr, hg, hb] = hsvToRgb(hsv.h, 1, 1);
  svPanel.style.backgroundColor = `rgb(${hr}, ${hg}, ${hb})`;
  svKnob.style.left = `${hsv.s * 100}%`;
  svKnob.style.top = `${(1 - hsv.v) * 100}%`;
  hueRange.value = String(Math.round(hsv.h));
  hueRange.style.setProperty("--hue-thumb", `rgb(${hr}, ${hg}, ${hb})`);
  rgbInputs.forEach((el, i) => {
    if (from !== el) el.value = String(color[i]);
  });
  if (from !== alphaNumber) alphaNumber.value = String(a);
  if (from !== alphaRange) alphaRange.value = String(a);
  $("a-pct").textContent = `${channelBalance(color).a.toFixed(1)}%`;
  // 透明度のつまみの下地: 透明 → いまの色
  alphaRange.style.setProperty(
    "--track",
    `linear-gradient(to right, rgba(${r}, ${g}, ${b}, 0), rgb(${r}, ${g}, ${b})), var(--checker)`,
  );
}

rgbInputs.forEach((el, i) => {
  el.addEventListener("input", () => {
    const next: [number, number, number, number] = [...color];
    next[i] = Number(el.value);
    setColor(next, el);
  });
});
for (const el of [alphaNumber, alphaRange]) {
  el.addEventListener("input", () => setColor([color[0], color[1], color[2], Number(el.value)], el));
}

// 色の四角（横 = 彩度、縦 = 明度）と色相のスライダー。色の四角はドラッグで位置を選ぶ
function pickFromSquare(ev: PointerEvent): void {
  const rect = svPanel.getBoundingClientRect();
  const s = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
  const v = 1 - Math.min(1, Math.max(0, (ev.clientY - rect.top) / rect.height));
  const [r, g, b] = hsvToRgb(hsv.h, s, v);
  setColor([r, g, b, color[3]], svPanel, { h: hsv.h, s, v });
}
let squareDrag = false;
svPanel.addEventListener("pointerdown", (ev) => {
  squareDrag = true;
  svPanel.setPointerCapture(ev.pointerId);
  pickFromSquare(ev);
});
svPanel.addEventListener("pointermove", (ev) => {
  if (squareDrag) pickFromSquare(ev);
});
for (const type of ["pointerup", "pointercancel"] as const) {
  svPanel.addEventListener(type, () => {
    squareDrag = false;
  });
}
hueRange.addEventListener("input", () => {
  const h = Number(hueRange.value);
  const [r, g, b] = hsvToRgb(h, hsv.s, hsv.v);
  setColor([r, g, b, color[3]], hueRange, { h, s: hsv.s, v: hsv.v });
});

// スポイト（画面から色を拾う）。ブラウザが対応していなければ隠す
type EyeDropperCtor = new () => { open(): Promise<{ sRGBHex: string }> };
const EyeDropperApi = (window as unknown as { EyeDropper?: EyeDropperCtor }).EyeDropper;
const eyedropper = $<HTMLButtonElement>("eyedropper");
if (EyeDropperApi) {
  eyedropper.addEventListener("click", () => {
    new EyeDropperApi()
      .open()
      .then((res) => {
        const rgb = parseHex(res.sRGBHex);
        if (rgb) setColor([rgb[0], rgb[1], rgb[2], color[3]]);
      })
      .catch(() => {
        /* キャンセル */
      });
  });
} else {
  eyedropper.hidden = true;
}

// パレット: 押すとその色（透明度はそのまま）
$("palette").replaceChildren(
  ...PALETTE.map((p) => {
    const b = document.createElement("button");
    b.className = "sw";
    b.style.background = p.hex;
    b.title = p.name;
    b.setAttribute("aria-label", p.name);
    b.addEventListener("click", () => {
      const rgb = parseHex(p.hex)!;
      setColor([rgb[0], rgb[1], rgb[2], color[3]]);
    });
    return b;
  }),
);

function rememberColor(c: Rgba): void {
  const hex = toHex(c);
  recent = [c, ...recent.filter((r) => toHex(r) !== hex)].slice(0, MAX_RECENT);
  $("recent").replaceChildren(
    ...recent.map((r) => {
      const b = document.createElement("button");
      b.className = "sw recent";
      const fill = document.createElement("i");
      fill.style.background = toCss(r);
      b.append(fill);
      b.title = "最近使った色";
      b.setAttribute("aria-label", "最近使った色");
      b.addEventListener("click", () => setColor(r));
      return b;
    }),
  );
}

// ---------- 画像の入力（選択・サンプル・ドラッグ＆ドロップ・貼り付け） ----------

$<HTMLInputElement>("file").addEventListener("change", (ev) => {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) void loadFile(file);
  input.value = ""; // 同じファイルをもう一度選べるように
});

for (const el of [empty, viewport]) {
  el.addEventListener("dragover", (ev) => {
    ev.preventDefault();
    el.classList.add("dragging");
  });
  el.addEventListener("dragleave", () => el.classList.remove("dragging"));
  el.addEventListener("drop", (ev) => {
    ev.preventDefault();
    el.classList.remove("dragging");
    const file = (ev as DragEvent).dataTransfer?.files[0];
    if (file) void loadFile(file);
  });
}
window.addEventListener("paste", (ev) => {
  const file = [...(ev.clipboardData?.files ?? [])].find((f) => f.type.startsWith("image/"));
  if (file) void loadFile(file);
});

setColor(color);
setTool("fill");
refreshSelectionUi();
updateButtons();
