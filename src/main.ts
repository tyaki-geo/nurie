import { IDENTITY, panBy, zoomAt, type View } from "./lib/view";
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
  toHex6,
  type Rgba,
} from "./lib/lineart";
import { defaultMaxLineWidth, extractFromPhoto, extractSimple } from "./lib/photo";
import {
  formatRegionList,
  labelRegions,
  parseRegionList,
  pixelsOf,
  type Regions,
} from "./lib/regions";

/** 作業用の画像の長辺の上限（大きすぎるとメモリと処理が重くなる） */
const MAX_SIDE = 2048;
const MAX_HISTORY = 50;
const MAX_RECENT = 12;
const WHITE: Rgba = [255, 255, 255, 255];
const BLACK: Rgba = [0, 0, 0, 255];

type Tool = "fill" | "multi" | "brush";
type Layer = "colors" | "lines";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const canvas = $<HTMLCanvasElement>("canvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
const overlay = $<HTMLCanvasElement>("overlay");
const octx = overlay.getContext("2d")!;
const stage = $("stage");
const empty = $("empty");
const status = $("status");

interface Doc {
  width: number;
  height: number;
  dark: Uint8Array; // 画素ごとの黒さ
  alpha: Uint8Array; // 現在のしきい値での線の濃さ
  regions: Regions; // 線で囲まれた領域の番号
  colors: Uint8ClampedArray; // 領域の色（RGBA、初期は不透明な白）
  lines: Uint8ClampedArray; // 線の色（RGBA、初期は不透明な黒）
  out: ImageData; // 画面に出す最終画像（透明度つき）
  name: string;
}

/** 1回の操作の記録。元に戻す・やり直しに使う */
interface Edit {
  layer: Layer;
  indices: Int32Array;
  before: Uint8ClampedArray; // 操作前の色（indices と同じ順で RGBA）
  after: Rgba;
}

let doc: Doc | null = null;
let tool: Tool = "fill";
let threshold = 128;
let color: Rgba = [255, 0, 0, 255];
let brushSize = 8; // 直径（画像の画素）
let selection = new Set<number>();
let undoStack: Edit[] = [];
let redoStack: Edit[] = [];
let recent: Rgba[] = [];

// ---------- 画像の読み込み ----------

/** 読み込んだ画像（作業用の大きさに縮小したもの）。抽出の設定を変えたときに作り直すために持っておく */
let source: { data: Uint8ClampedArray; width: number; height: number; name: string } | null = null;
let mode: "auto" | "simple" = "auto";

async function loadBlob(blob: Blob, name: string): Promise<void> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    alert("画像を読み込めませんでした。");
    return;
  }
  const { width, height } = fitSize(bitmap.width, bitmap.height, MAX_SIDE);
  // 透明な部分は白として扱うので、白地に描いて読み取る
  canvas.width = width;
  canvas.height = height;
  ctx.imageSmoothingQuality = "high";
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  source = { data: ctx.getImageData(0, 0, width, height).data, width, height, name };
  const w = defaultMaxLineWidth(width, height);
  appliedLineWidth = w;
  syncExtractUi();
  processSource();
}

/** 読み込んだ画像から、いまの設定で線を抽出して作業用のデータを作る（塗った色・選択・履歴は作り直しになる） */
function processSource(): void {
  if (!source) return;
  const maxLineWidth = Number($<HTMLInputElement>("line-width").value);
  const extracted =
    mode === "auto"
      ? extractFromPhoto(source.data, source.width, source.height, {
          maxLineWidth,
          cropPaper: $<HTMLInputElement>("crop-paper").checked,
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
    regions: labelRegions(dark, width, height, threshold),
    colors,
    lines,
    out: ctx.createImageData(width, height),
    name: source.name.replace(/\.[^.]+$/, "") || "nurie",
  };
  undoStack = [];
  redoStack = [];
  selection = new Set();
  render();
  refreshSelectionUi();
  empty.hidden = true;
  stage.hidden = false;
  setView(IDENTITY);
  const paper =
    mode !== "auto" || !$<HTMLInputElement>("crop-paper").checked
      ? ""
      : extracted.paperFound
        ? "紙の部分を切り出しました。"
        : "紙の範囲は見つからなかったので、全体から線を抽出しました。";
  status.textContent = `${paper}${doc.regions.count} 個の領域に番号をつけました。`;
  updateButtons();
}

/** 抽出の設定を変えると塗った色が消える。消えてよいか確認する（塗った内容がなければ確認しない） */
function confirmDiscard(): boolean {
  return undoStack.length === 0 || confirm("設定を変えると、塗った色は消えます。続けますか？");
}

async function loadFile(file: File): Promise<void> {
  if (!file.type.startsWith("image/")) {
    alert("画像ファイルを選んでください。");
    return;
  }
  await loadBlob(file, file.name);
}

async function loadSample(name: string): Promise<void> {
  const res = await fetch(`${import.meta.env.BASE_URL}samples/${name}.png`);
  if (!res.ok) {
    alert("サンプルを読み込めませんでした。");
    return;
  }
  await loadBlob(await res.blob(), name);
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

/** 選択中の領域の色づけと、領域の番号を重ねて描く */
function drawOverlay(): void {
  octx.clearRect(0, 0, overlay.width, overlay.height);
  if (!doc) return;
  const { labels, count, sizes, anchors } = doc.regions;

  if (selection.size > 0) {
    const flags = new Uint8Array(count + 1);
    for (const id of selection) flags[id] = 1;
    const img = octx.createImageData(doc.width, doc.height);
    for (let i = 0; i < labels.length; i++) {
      if (flags[labels[i]!]) img.data.set([37, 99, 235, 110], i * 4);
    }
    octx.putImageData(img, 0, 0);
  }

  if ($<HTMLInputElement>("show-numbers").checked) {
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

function target(layer: Layer): Uint8ClampedArray {
  return layer === "colors" ? doc!.colors : doc!.lines;
}

function apply(edit: Edit): void {
  if (!doc) return;
  const buf = target(edit.layer);
  for (const px of edit.indices) buf.set(edit.after, px * 4);
  refresh(edit.indices);
}

function revert(edit: Edit): void {
  if (!doc) return;
  const buf = target(edit.layer);
  edit.indices.forEach((px, k) => {
    buf.set(edit.before.subarray(k * 4, k * 4 + 4), px * 4);
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

function snapshot(layer: Layer, indices: Int32Array): Uint8ClampedArray {
  const buf = target(layer);
  const before = new Uint8ClampedArray(indices.length * 4);
  indices.forEach((px, k) => before.set(buf.subarray(px * 4, px * 4 + 4), k * 4));
  return before;
}

/** 領域（番号の集合）を、いまの色で塗る。1回の操作として記録する */
function paintRegions(ids: ReadonlySet<number>): void {
  if (!doc || ids.size === 0) return;
  const indices = pixelsOf(doc.regions.labels, ids);
  if (indices.length === 0) return;
  const edit: Edit = { layer: "colors", indices, before: snapshot("colors", indices), after: color };
  apply(edit);
  record(edit);
}

// ---------- ブラシ（線に沿って塗る） ----------

interface Stroke {
  touched: Uint8Array;
  indices: number[];
  before: number[];
  lastX: number;
  lastY: number;
}
let stroke: Stroke | null = null;

function startStroke(x: number, y: number): void {
  if (!doc) return;
  stroke = {
    touched: new Uint8Array(doc.width * doc.height),
    indices: [],
    before: [],
    lastX: x,
    lastY: y,
  };
  extendStroke(x, y);
}

/** 前の点から (x, y) までなぞった範囲のうち、黒い線の上の画素だけを線の色として塗る */
function extendStroke(x: number, y: number): void {
  if (!doc || !stroke) return;
  const covered = capsulePixels(stroke.lastX, stroke.lastY, x, y, brushSize / 2, doc.width, doc.height);
  stroke.lastX = x;
  stroke.lastY = y;
  const fresh: number[] = [];
  for (const i of covered) {
    if (stroke.touched[i] || doc.alpha[i] === 0) continue; // 線でない画素は塗らない
    stroke.touched[i] = 1;
    stroke.indices.push(i);
    stroke.before.push(...doc.lines.subarray(i * 4, i * 4 + 4));
    doc.lines.set(color, i * 4);
    fresh.push(i);
  }
  refresh(Int32Array.from(fresh));
}

function endStroke(): void {
  if (!stroke) return;
  const s = stroke;
  stroke = null;
  if (s.indices.length === 0) return;
  record({
    layer: "lines",
    indices: Int32Array.from(s.indices),
    before: Uint8ClampedArray.from(s.before),
    after: color,
  });
}

// ---------- キャンバスの操作 ----------

function pixelAt(ev: PointerEvent): { x: number; y: number } | null {
  if (!doc) return null;
  const rect = canvas.getBoundingClientRect();
  const fx = ((ev.clientX - rect.left) / rect.width) * doc.width;
  const fy = ((ev.clientY - rect.top) / rect.height) * doc.height;
  return { x: fx, y: fy };
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
let view: View = IDENTITY;

function setView(next: View): void {
  view = next;
  stage.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`;
}
const viewSize = (): [number, number] => [viewport.clientWidth, viewport.clientHeight];

// ホイールの縦回転は拡大・縮小、横回転は横移動（ピンチ操作は ctrl 付きのホイールとして届き、拡大・縮小になる）
viewport.addEventListener(
  "wheel",
  (ev) => {
    if (!doc) return;
    ev.preventDefault();
    const unit = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? viewport.clientHeight : 1;
    const [w, h] = viewSize();
    if (!ev.ctrlKey && Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) {
      setView(panBy(view, -ev.deltaX * unit, 0, w, h));
    } else {
      const rect = viewport.getBoundingClientRect();
      const factor = Math.exp(-ev.deltaY * unit * (ev.ctrlKey ? 0.01 : 0.0015));
      setView(zoomAt(view, factor, ev.clientX - rect.left, ev.clientY - rect.top, w, h));
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

window.addEventListener("keydown", (ev) => {
  const t = ev.target;
  const typing = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
  if (typing || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  if (ev.code === "Space") {
    spaceDown = true;
    ev.preventDefault();
  } else if (ev.key === "0") {
    setView(IDENTITY);
  }
});
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
      const [w, h] = viewSize();
      setView(panBy(view, ev.clientX - drag.lastX, ev.clientY - drag.lastY, w, h));
    }
    drag.lastX = ev.clientX;
    drag.lastY = ev.clientY;
    return;
  }
  const p = pixelAt(ev);
  if (!doc || !p) return;
  if (stroke) extendStroke(p.x, p.y);
  const x = Math.floor(p.x);
  const y = Math.floor(p.y);
  if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return;
  const i = y * doc.width + x;
  const id = doc.regions.labels[i]!;
  if (id === 0) {
    status.textContent = `線の上  線の色 ${toHex(doc.lines.subarray(i * 4, i * 4 + 4))}`;
  } else {
    const a = doc.regions.anchors[id]!;
    const c = doc.colors.subarray(a * 4, a * 4 + 4);
    status.textContent =
      `領域 #${id}（${doc.regions.sizes[id]} px）  現在の色 ${toHex(c)}` +
      `${selection.has(id) ? "  ［選択中］" : ""}`;
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

// ---------- 選択（複数領域） ----------

function refreshSelectionUi(): void {
  const text = formatRegionList(selection);
  $<HTMLInputElement>("region-text").value = text;
  const total = doc?.regions.count ?? 0;
  $("selection-text").innerHTML = "";
  const small = document.createElement("small");
  small.textContent = doc
    ? `選択中 ${selection.size} / ${total} 領域`
    : "画像を読み込むと領域に番号がつきます";
  $("selection-text").append(small);
  updateButtons();
}

function selectByText(): void {
  if (!doc) return;
  const { ids, ignored } = parseRegionList($<HTMLInputElement>("region-text").value, doc.regions.count);
  selection = new Set(ids);
  refreshSelectionUi();
  drawOverlay();
  if (ignored.length > 0) {
    status.textContent = `無視した指定: ${ignored.join(", ")}（番号は 1〜${doc.regions.count}）`;
  }
}

$("region-select").addEventListener("click", selectByText);
$("region-text").addEventListener("keydown", (ev) => {
  if ((ev as KeyboardEvent).key === "Enter") selectByText();
});
$("select-all").addEventListener("click", () => {
  if (!doc) return;
  selection = new Set(Array.from({ length: doc.regions.count }, (_, k) => k + 1));
  refreshSelectionUi();
  drawOverlay();
});
$("select-none").addEventListener("click", () => {
  selection = new Set();
  refreshSelectionUi();
  drawOverlay();
});
$("paint-selected").addEventListener("click", () => paintRegions(selection));
$("show-numbers").addEventListener("change", drawOverlay);

// ---------- ツール ----------

for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="tool"]')) {
  radio.addEventListener("change", () => {
    if (!radio.checked) return;
    tool = radio.value as Tool;
    stage.dataset.tool = tool;
  });
}
const brushRange = $<HTMLInputElement>("brush");
const brushNumber = $<HTMLInputElement>("brush-n");
function setBrush(v: number, source: HTMLInputElement): void {
  brushSize = Math.min(60, Math.max(1, Math.round(Number.isFinite(v) ? v : 1)));
  if (source !== brushRange) brushRange.value = String(brushSize);
  if (source !== brushNumber) brushNumber.value = String(brushSize);
}
brushRange.addEventListener("input", () => setBrush(Number(brushRange.value), brushRange));
brushNumber.addEventListener("input", () => setBrush(Number(brushNumber.value), brushNumber));

// ---------- 操作ボタン ----------

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
  $<HTMLButtonElement>("save").disabled = !has;
  $<HTMLButtonElement>("select-all").disabled = !has;
  $<HTMLButtonElement>("select-none").disabled = selection.size === 0;
  $<HTMLButtonElement>("paint-selected").disabled = selection.size === 0;
}

$("undo").addEventListener("click", undo);
$("redo").addEventListener("click", redo);
$("clear").addEventListener("click", clearColors);
$("reset-lines").addEventListener("click", resetLines);
$("save").addEventListener("click", save);
window.addEventListener("keydown", (ev) => {
  if (!(ev.ctrlKey || ev.metaKey)) return;
  const t = ev.target;
  if (t instanceof HTMLInputElement && (t.type === "text" || t.type === "number")) return;
  if (ev.key === "z") {
    ev.preventDefault();
    if (ev.shiftKey) redo();
    else undo();
  } else if (ev.key === "y") {
    ev.preventDefault();
    redo();
  }
});

// ---------- 線の抽出の設定 ----------

const lineWidthRange = $<HTMLInputElement>("line-width");
const lineWidthNumber = $<HTMLInputElement>("line-width-n");
const cropPaper = $<HTMLInputElement>("crop-paper");
let appliedLineWidth = Number(lineWidthRange.value);
let appliedCrop = cropPaper.checked;

/** 設定の部品を、いまの状態（モード）に合わせる */
function syncExtractUi(): void {
  document.querySelectorAll<HTMLInputElement>('input[name="extract"]').forEach((r) => {
    r.checked = r.value === mode;
  });
  lineWidthRange.value = lineWidthNumber.value = String(appliedLineWidth);
  cropPaper.checked = appliedCrop;
  const auto = mode === "auto";
  lineWidthRange.disabled = lineWidthNumber.disabled = cropPaper.disabled = !auto;
}

for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="extract"]')) {
  radio.addEventListener("change", () => {
    if (!radio.checked) return;
    const previous = mode;
    mode = radio.value as "auto" | "simple";
    syncExtractUi();
    if (mode !== previous) {
      if (!confirmDiscard()) {
        mode = previous;
        syncExtractUi();
        return;
      }
      processSource();
    }
  });
}
function onLineWidth(source: HTMLInputElement): void {
  const v = Math.min(60, Math.max(3, Math.round(Number(source.value) || 3)));
  lineWidthRange.value = lineWidthNumber.value = String(v);
}
lineWidthRange.addEventListener("input", () => onLineWidth(lineWidthRange));
lineWidthNumber.addEventListener("input", () => onLineWidth(lineWidthNumber));
// 作り直しは重いので、つまみを離したとき・入力を確定したときだけ
for (const el of [lineWidthRange, lineWidthNumber]) {
  el.addEventListener("change", () => {
    const v = Number(lineWidthRange.value);
    if (v === appliedLineWidth) return;
    if (!confirmDiscard()) {
      syncExtractUi();
      return;
    }
    appliedLineWidth = v;
    processSource();
  });
}
cropPaper.addEventListener("change", () => {
  if (!confirmDiscard()) {
    cropPaper.checked = appliedCrop;
    return;
  }
  appliedCrop = cropPaper.checked;
  processSource();
});

// ---------- 線のしきい値 ----------

const thresholdInput = $<HTMLInputElement>("threshold");
thresholdInput.addEventListener("input", () => {
  threshold = Number(thresholdInput.value);
  $("threshold-value").textContent = String(threshold);
  if (!doc) return;
  doc.alpha = lineAlpha(doc.dark, threshold);
  // 領域の切れ目が変わるので、番号と選択は作り直す（塗った色は画素ごとに残る）
  doc.regions = labelRegions(doc.dark, doc.width, doc.height, threshold);
  selection = new Set();
  refreshSelectionUi();
  render();
  status.textContent = `${doc.regions.count} 個の領域に番号をつけました。`;
});

// ---------- 色の選択（RGB + 透明度） ----------

const picker = $<HTMLInputElement>("picker");
const hexInput = $<HTMLInputElement>("hex");
const channels = (["r", "g", "b", "a"] as const).map((id) => ({
  number: $<HTMLInputElement>(id),
  range: $<HTMLInputElement>(`${id}-range`),
}));

function setColor(next: Rgba, source?: HTMLElement): void {
  color = [clampChannel(next[0]), clampChannel(next[1]), clampChannel(next[2]), clampChannel(next[3])];
  $("swatch").style.background = toCss(color);
  if (source !== picker) picker.value = toHex6(color);
  if (source !== hexInput) hexInput.value = toHex(color);
  channels.forEach((c, i) => {
    if (source !== c.number) c.number.value = String(color[i]);
    if (source !== c.range) c.range.value = String(color[i]);
  });
  showBalance();
}

function showBalance(): void {
  const b = channelBalance(color);
  const sum = color[0] + color[1] + color[2];
  const bar = $("balance-bar").children;
  [color[0], color[1], color[2]].forEach((v, i) => {
    (bar[i] as HTMLElement).style.width = sum === 0 ? "0%" : `${(v / sum) * 100}%`;
  });
  $("balance-text").innerHTML =
    `R ${color[0]}（${b.r.toFixed(1)}%）　G ${color[1]}（${b.g.toFixed(1)}%）　B ${color[2]}（${b.b.toFixed(1)}%）<br />` +
    `A ${color[3]}（${b.a.toFixed(1)}%）　${toHex(color)}`;
}

channels.forEach((c, i) => {
  const onInput = (el: HTMLInputElement) => () => {
    const next: [number, number, number, number] = [...color];
    next[i] = Number(el.value);
    setColor(next, el);
  };
  c.number.addEventListener("input", onInput(c.number));
  c.range.addEventListener("input", onInput(c.range));
});
picker.addEventListener("input", () => {
  const rgb = parseHex(picker.value);
  if (rgb) setColor([rgb[0], rgb[1], rgb[2], color[3]], picker); // 透明度は変えない
});
hexInput.addEventListener("input", () => {
  const rgba = parseHex(hexInput.value);
  if (rgba) setColor(rgba, hexInput); // 入力の途中（不正な間）は何もしない
});

function rememberColor(c: Rgba): void {
  const hex = toHex(c);
  recent = [c, ...recent.filter((r) => toHex(r) !== hex)].slice(0, MAX_RECENT);
  $("recent").replaceChildren(
    ...recent.map((r) => {
      const b = document.createElement("button");
      b.className = "swatch";
      const fill = document.createElement("i");
      fill.style.background = toCss(r);
      b.append(fill);
      b.title = toHex(r);
      b.setAttribute("aria-label", toHex(r));
      b.addEventListener("click", () => setColor(r));
      return b;
    }),
  );
}

// ---------- 画像の入力（選択・サンプル・ドラッグ＆ドロップ・貼り付け） ----------

$<HTMLInputElement>("file").addEventListener("change", (ev) => {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (file) void loadFile(file);
});
$("sample-house").addEventListener("click", () => void loadSample("house"));
$("sample-rings").addEventListener("click", () => void loadSample("rings"));

for (const el of [empty, stage]) {
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
refreshSelectionUi();
updateButtons();
