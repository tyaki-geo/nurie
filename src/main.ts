import {
  clampChannel,
  compose,
  computeDarkness,
  fitSize,
  floodRegion,
  lineAlpha,
  parseHex,
  toHex,
  type Rgb,
} from "./lib/lineart";

/** 作業用の画像の長辺の上限（大きすぎるとメモリと塗りつぶしが重くなる） */
const MAX_SIDE = 2048;
const MAX_HISTORY = 50;
const MAX_RECENT = 12;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const canvas = $<HTMLCanvasElement>("canvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
const stage = $("stage");
const empty = $("empty");

interface Doc {
  width: number;
  height: number;
  dark: Uint8Array; // 画素ごとの黒さ
  alpha: Uint8Array; // 現在のしきい値での線の濃さ
  colors: Uint8ClampedArray; // 塗った色（RGBA、初期は白）
  out: ImageData; // 画面に出す最終画像
  name: string;
}

/** 1回の塗りの記録。元に戻す・やり直しに使う */
interface Edit {
  indices: Int32Array;
  before: Uint8ClampedArray; // 塗る前の色（indices と同じ順で RGBA）
  after: Rgb;
}

let doc: Doc | null = null;
let threshold = 128;
let color: Rgb = [255, 0, 0];
let undoStack: Edit[] = [];
let redoStack: Edit[] = [];
let recent: Rgb[] = [];

// ---------- 画像の読み込み ----------

async function loadFile(file: File): Promise<void> {
  if (!file.type.startsWith("image/")) {
    alert("画像ファイルを選んでください。");
    return;
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    alert("画像を読み込めませんでした。");
    return;
  }
  const { width, height } = fitSize(bitmap.width, bitmap.height, MAX_SIDE);
  canvas.width = width;
  canvas.height = height;
  // 透明な部分は白として扱うので、白地に描く
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const source = ctx.getImageData(0, 0, width, height);
  const dark = computeDarkness(source.data);
  const colors = new Uint8ClampedArray(width * height * 4).fill(255);
  doc = {
    width,
    height,
    dark,
    alpha: lineAlpha(dark, threshold),
    colors,
    out: ctx.createImageData(width, height),
    name: file.name.replace(/\.[^.]+$/, "") || "nurie",
  };
  undoStack = [];
  redoStack = [];
  compose(doc.colors, doc.alpha, doc.out.data);
  ctx.putImageData(doc.out, 0, 0);
  empty.hidden = true;
  stage.hidden = false;
  updateButtons();
}

// ---------- 描画・塗り ----------

function render(from?: number, to?: number): void {
  if (!doc) return;
  compose(doc.colors, doc.alpha, doc.out.data, from, to);
  ctx.putImageData(doc.out, 0, 0);
}

function paint(x: number, y: number): void {
  if (!doc) return;
  const indices = floodRegion(doc.dark, doc.width, doc.height, threshold, x, y);
  if (indices.length === 0) return; // 線の上
  const before = new Uint8ClampedArray(indices.length * 4);
  indices.forEach((px, k) => {
    before.set(doc!.colors.subarray(px * 4, px * 4 + 4), k * 4);
  });
  const edit: Edit = { indices, before, after: color };
  apply(edit);
  undoStack.push(edit);
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack = [];
  rememberColor(color);
  updateButtons();
}

function apply(edit: Edit): void {
  if (!doc) return;
  const [r, g, b] = edit.after;
  for (const px of edit.indices) doc.colors.set([r, g, b, 255], px * 4);
  render();
}

function revert(edit: Edit): void {
  if (!doc) return;
  edit.indices.forEach((px, k) => {
    doc!.colors.set(edit.before.subarray(k * 4, k * 4 + 4), px * 4);
  });
  render();
}

canvas.addEventListener("click", (ev) => {
  if (!doc) return;
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor(((ev.clientX - rect.left) / rect.width) * doc.width);
  const y = Math.floor(((ev.clientY - rect.top) / rect.height) * doc.height);
  paint(x, y);
});

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
  doc.colors.fill(255);
  undoStack = [];
  redoStack = [];
  render();
  updateButtons();
}

function save(): void {
  if (!doc) return;
  canvas.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${doc!.name}-colored.png`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, "image/png");
}

function updateButtons(): void {
  $<HTMLButtonElement>("undo").disabled = undoStack.length === 0;
  $<HTMLButtonElement>("redo").disabled = redoStack.length === 0;
  $<HTMLButtonElement>("clear").disabled = !doc;
  $<HTMLButtonElement>("save").disabled = !doc;
}

$("undo").addEventListener("click", undo);
$("redo").addEventListener("click", redo);
$("clear").addEventListener("click", clearColors);
$("save").addEventListener("click", save);
window.addEventListener("keydown", (ev) => {
  if (!(ev.ctrlKey || ev.metaKey) || ev.target instanceof HTMLInputElement) return;
  if (ev.key === "z") {
    ev.preventDefault();
    if (ev.shiftKey) redo();
    else undo();
  } else if (ev.key === "y") {
    ev.preventDefault();
    redo();
  }
});

// ---------- 線のしきい値 ----------

const thresholdInput = $<HTMLInputElement>("threshold");
thresholdInput.addEventListener("input", () => {
  threshold = Number(thresholdInput.value);
  $("threshold-value").textContent = String(threshold);
  if (!doc) return;
  doc.alpha = lineAlpha(doc.dark, threshold);
  render();
});

// ---------- 色の選択 ----------

const picker = $<HTMLInputElement>("picker");
const hexInput = $<HTMLInputElement>("hex");
const channels = (["r", "g", "b"] as const).map((id) => ({
  number: $<HTMLInputElement>(id),
  range: $<HTMLInputElement>(`${id}-range`),
}));

function setColor(next: Rgb, source?: HTMLElement): void {
  color = [clampChannel(next[0]), clampChannel(next[1]), clampChannel(next[2])];
  $("swatch").style.background = toHex(color);
  if (source !== picker) picker.value = toHex(color);
  if (source !== hexInput) hexInput.value = toHex(color);
  channels.forEach((c, i) => {
    if (source !== c.number) c.number.value = String(color[i]);
    if (source !== c.range) c.range.value = String(color[i]);
  });
}

channels.forEach((c, i) => {
  const onInput = (el: HTMLInputElement) => () => {
    const next: [number, number, number] = [...color];
    next[i] = Number(el.value);
    setColor(next, el);
  };
  c.number.addEventListener("input", onInput(c.number));
  c.range.addEventListener("input", onInput(c.range));
});
picker.addEventListener("input", () => {
  const rgb = parseHex(picker.value);
  if (rgb) setColor(rgb, picker);
});
hexInput.addEventListener("input", () => {
  const rgb = parseHex(hexInput.value);
  if (rgb) setColor(rgb, hexInput); // 入力の途中（不正な間）は何もしない
});

function rememberColor(c: Rgb): void {
  const hex = toHex(c);
  recent = [c, ...recent.filter((r) => toHex(r) !== hex)].slice(0, MAX_RECENT);
  const box = $("recent");
  box.replaceChildren(
    ...recent.map((r) => {
      const b = document.createElement("button");
      b.style.background = toHex(r);
      b.title = toHex(r);
      b.setAttribute("aria-label", toHex(r));
      b.addEventListener("click", () => setColor(r));
      return b;
    }),
  );
}

// ---------- 画像の入力（選択・ドラッグ＆ドロップ・貼り付け） ----------

$<HTMLInputElement>("file").addEventListener("change", (ev) => {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (file) void loadFile(file);
});

for (const el of [empty, stage]) {
  el.addEventListener("dragover", (ev) => {
    ev.preventDefault();
    el.classList.add("dragging");
  });
  el.addEventListener("dragleave", () => el.classList.remove("dragging"));
  el.addEventListener("drop", (ev) => {
    ev.preventDefault();
    el.classList.remove("dragging");
    const file = ev.dataTransfer?.files[0];
    if (file) void loadFile(file);
  });
}
window.addEventListener("paste", (ev) => {
  const file = [...(ev.clipboardData?.files ?? [])].find((f) => f.type.startsWith("image/"));
  if (file) void loadFile(file);
});

setColor(color);
updateButtons();
