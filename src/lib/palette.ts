// 色パネルの見本の色（パネルから選ぶための既定の色）。DOM に依存しない。

export interface PaletteColor {
  name: string;
  hex: string;
}

/** 上の段 = はっきりした色、下の段 = うすい色と無彩色（12色ずつ） */
export const PALETTE: readonly PaletteColor[] = [
  { name: "あか", hex: "#e53935" },
  { name: "だいだい", hex: "#fb8c00" },
  { name: "きいろ", hex: "#fdd835" },
  { name: "きみどり", hex: "#7cb342" },
  { name: "みどり", hex: "#43a047" },
  { name: "ふかみどり", hex: "#00695c" },
  { name: "みずいろ", hex: "#29b6f6" },
  { name: "あお", hex: "#1e88e5" },
  { name: "こん", hex: "#1a237e" },
  { name: "むらさき", hex: "#8e24aa" },
  { name: "もも", hex: "#f48fb1" },
  { name: "あかむらさき", hex: "#d81b60" },
  { name: "うすあか", hex: "#ef9a9a" },
  { name: "うすだいだい", hex: "#ffcc80" },
  { name: "うすきいろ", hex: "#fff59d" },
  { name: "うすみどり", hex: "#c5e1a5" },
  { name: "ミント", hex: "#80cbc4" },
  { name: "うすみずいろ", hex: "#81d4fa" },
  { name: "うすむらさき", hex: "#ce93d8" },
  { name: "はだいろ", hex: "#ffcc99" },
  { name: "ちゃいろ", hex: "#6d4c41" },
  { name: "はいいろ", hex: "#9e9e9e" },
  { name: "くろ", hex: "#212121" },
  { name: "しろ", hex: "#ffffff" },
];
