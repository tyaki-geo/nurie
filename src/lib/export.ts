/** 画像出力の形式（拡張子）とアスペクト比 */

export type ExportFormat = "png" | "jpeg" | "webp";

export const FORMATS: Record<ExportFormat, { mime: string; ext: string; alpha: boolean }> = {
  png: { mime: "image/png", ext: "png", alpha: true },
  jpeg: { mime: "image/jpeg", ext: "jpg", alpha: false },
  webp: { mime: "image/webp", ext: "webp", alpha: true },
};

/** "original" は元の比のまま。それ以外は "幅:高さ" */
export const ASPECTS = ["original", "1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16"] as const;
export type ExportAspect = (typeof ASPECTS)[number];

export function isFormat(v: string): v is ExportFormat {
  return v in FORMATS;
}

export function isAspect(v: string): v is ExportAspect {
  return (ASPECTS as readonly string[]).includes(v);
}

/** "16:9" → 16/9。"original" や不正な値は null */
export function aspectRatio(aspect: string): number | null {
  const m = /^(\d+):(\d+)$/.exec(aspect);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w > 0 && h > 0 ? w / h : null;
}

/**
 * 画像を縮小せずに収められる、指定した比の最小のキャンバスの大きさ。
 * 余った分は余白になり、画像は中央に置く。
 */
export function exportSize(width: number, height: number, aspect: string): { width: number; height: number } {
  const r = aspectRatio(aspect);
  if (r === null) return { width, height };
  if (width / height < r) return { width: Math.round(height * r), height };
  return { width, height: Math.round(width / r) };
}
