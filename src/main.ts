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
const MAX_SIDE = 2048;
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
  regions: Regions; // 線で囲まれた領域の番号
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

/** 読み込んだ画像（作業用の大きさに縮小したもの）。抽出の設定を変えたときに作り直すために持っておく */
let source: { data: Uint8ClampedArray; width: number; height: number; name: string } | null = null;
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
  // 透明な部分は白として扱うので、白地に描いて読み取る
  canvas.width = width;
  canvas.height = height;
  ctx.imageSmoothingQuality = "high";
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  source = { data: ctx.getImageData(0, 0, width, height).data, width, height, name };
  appliedLineWidth = defaultMaxLineWidth(width, height);
  syncExtractUi();
  processSource();
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
  const paper =
    extractMode !== "auto" || !appliedCrop
      ? ""
      : extracted.paperFound
        ? "紙の部分を切り出しました。"
        : "紙の範囲は見つからなかったので、全体から線を抽出しました。";
  setStatus(`${paper}${doc.regions.count} 個の領域に番号をつけました。`);
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
  lastX: number;
  lastY: number;
}
let stroke: Stroke | null = null;

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
  };
  extendStroke(x, y);
}

/**
 * 前の点から (x, y) までなぞった範囲を塗る。線の外にもはみ出して塗れる。
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

function endStroke(): void {
  if (!stroke) return;
  const s = stroke;
  stroke = null;
  if (s.indices.length === 0) return;
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
  record(edit);
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

canvas.addEventListener("pointerdown", (ev) => {
  const p = pixelAt(ev);
  if (!doc || !p) return;
  const x = Math.floor(p.x);
  const y = Math.floor(p.y);
  if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return;
  if (tool === "brush") {
    canvas.setPointerCapture(ev.pointerId);
    startStroke(p.x, p.y);
    return;
  }
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
});

canvas.addEventListener("pointermove", (ev) => {
  const p = pixelAt(ev);
  if (!doc || !p) return;
  if (tool === "brush") {
    // ブラシの大きさの円をカーソルにする
    const rect = canvas.getBoundingClientRect();
    const d = (brushSize * rect.width) / doc.width;
    brushCursor.hidden = false;
    brushCursor.style.width = brushCursor.style.height = `${d}px`;
    brushCursor.style.left = `${ev.clientX - rect.left}px`;
    brushCursor.style.top = `${ev.clientY - rect.top}px`;
    if (stroke) extendStroke(p.x, p.y);
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
canvas.addEventListener("pointerup", endStroke);
canvas.addEventListener("pointercancel", endStroke);
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
$("show-numbers").addEventListener("click", () => {
  showNumbers = !showNumbers;
  $("show-numbers").classList.toggle("on", showNumbers);
  $("show-numbers").setAttribute("aria-pressed", String(showNumbers));
  drawOverlay();
});

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

const brushRange = $<HTMLInputElement>("brush");
const brushNumber = $<HTMLInputElement>("brush-n");
function setBrush(v: number, from: HTMLInputElement): void {
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
const extractButtons = document.querySelectorAll<HTMLElement>("[data-extract]");
let appliedLineWidth = Number(lineWidthRange.value);
let appliedCrop = cropPaper.checked;

/** 設定の部品を、いまの状態（モード・適用済みの値）に合わせる */
function syncExtractUi(): void {
  chooseButton(extractButtons, "extract", extractMode);
  lineWidthRange.value = lineWidthNumber.value = String(appliedLineWidth);
  cropPaper.checked = appliedCrop;
  const auto = extractMode === "auto";
  lineWidthRange.disabled = lineWidthNumber.disabled = cropPaper.disabled = !auto;
}

extractButtons.forEach((b) =>
  b.addEventListener("click", () => {
    const next = b.dataset.extract as "auto" | "simple";
    if (next === extractMode) return;
    if (!confirmDiscard()) return;
    extractMode = next;
    syncExtractUi();
    processSource();
  }),
);

function onLineWidth(from: HTMLInputElement): void {
  const v = Math.min(60, Math.max(3, Math.round(Number(from.value) || 3)));
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
  setStatus(`${doc.regions.count} 個の領域に番号をつけました。`);
});

// ---------- 色（パレット・スペクトル・RGB + 透明度）。RGB の値を出すのはここだけ ----------

const picker = $<HTMLInputElement>("picker");
const channels = (["r", "g", "b", "a"] as const).map((id) => ({
  number: $<HTMLInputElement>(id),
  range: $<HTMLInputElement>(`${id}-range`),
  pct: $(`${id}-pct`),
}));

function setColor(next: Rgba, from?: HTMLElement): void {
  color = [clampChannel(next[0]), clampChannel(next[1]), clampChannel(next[2]), clampChannel(next[3])];
  const [r, g, b] = color;
  $("swatch").style.background = toCss(color);
  if (from !== picker) picker.value = toHex6(color);
  const bal = channelBalance(color);
  const pcts = [bal.r, bal.g, bal.b, bal.a];
  channels.forEach((c, i) => {
    if (from !== c.number) c.number.value = String(color[i]);
    if (from !== c.range) c.range.value = String(color[i]);
    c.pct.textContent = `${pcts[i]!.toFixed(1)}%`;
  });
  // つまみの下地を、その成分を動かしたときの色の変化にする
  const track = (a: string, z: string): string => `linear-gradient(to right, ${a}, ${z})`;
  channels[0]!.range.style.setProperty("--track", track(`rgb(0, ${g}, ${b})`, `rgb(255, ${g}, ${b})`));
  channels[1]!.range.style.setProperty("--track", track(`rgb(${r}, 0, ${b})`, `rgb(${r}, 255, ${b})`));
  channels[2]!.range.style.setProperty("--track", track(`rgb(${r}, ${g}, 0)`, `rgb(${r}, ${g}, 255)`));
  channels[3]!.range.style.setProperty(
    "--track",
    `${track(`rgba(${r}, ${g}, ${b}, 0)`, `rgb(${r}, ${g}, ${b})`)}, var(--checker)`,
  );
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
setTool("fill");
syncExtractUi();
refreshSelectionUi();
updateButtons();
