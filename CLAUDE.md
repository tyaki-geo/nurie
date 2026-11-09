# CLAUDE.md

> **テンプレート由来の注意**: このファイルと `docs/template-setup.md`、`.github/` の設定は tyaki-geo/webapp-template から持ち込んだもの。下の記述は「そうなっているはずの運用」であって、このリポジトリで実際に設定済みとは限らない。ルールセットや Pages が有効かは GitHub 上で確かめ、確認できるまで前提にしない。設定を終えたらこの注意と `docs/template-setup.md` を、実態に合わせて直すか削除する。

線画に色を載せる塗り絵用の Web アプリ。読み込んだ画像から黒い線だけを抽出し、線で囲まれた領域に番号をつけ、RGBA（透明度つき）で指定した色で塗る。複数の領域を同じ色でまとめて塗る・黒い線に沿って（太さを調整して）線の色を塗る機能がある。画像はブラウザ内だけで処理する。
公開先: https://tyaki-geo.github.io/nurie/（GitHub Pages。main に入るたびに `deploy.yml` が公開する）

## コマンド

```
npm run dev
npm run typecheck && npm test && npm run build
```

## リポジトリの運用

- main はルールセット（`.github/protect-main.json`）で保護されている。直接 push せず、ブランチを切って PR を出す。レビューは CODEOWNERS。PR 本文は `.github/pull_request_template.md` に沿って書く
- 自分の PR はレビューのしようがないので、ルールセットの例外（リポジトリ管理者、`bypass_mode: pull_request`）で通す。マージ画面で「Merge without waiting for requirements to be met (bypass rules)」にチェックを入れてマージする。例外は PR のマージ時だけで、main への直接 push はできない
- CI（`.github/workflows/ci.yml`）のジョブ名 `check` はルールセットの必須チェック名。変えるときは両方直す。実行環境は `ubuntu-24.04` に固定している
- 依存パッケージは公開から2週間以上経った版を完全一致で固定する（`npm install --save-exact`）。`package-lock.json` もコミットする

## 構成

- `src/main.ts` 画面（読み込み・ツール・領域の選択と番号表示・色の選択・元に戻す/やり直し・保存）。`index.html` に画面の骨組みと CSS
- `src/lib/lineart.ts` 黒さの計算、線の抽出、合成（領域の色 + 線の色 → 透明度つきの最終画像）、色の変換（`#rrggbbaa`）、RGB のバランス
- `src/lib/regions.ts` 領域の番号づけ（連結成分のラベリング）、番号の位置、`1, 3, 5-8` の読み書き
- `src/lib/brush.ts` 太さのあるブラシが覆う画素
- `scripts/generate-samples.mjs` サンプル画像（`public/samples/`）を作る。依存なし
- `tests/` Vitest。DOM に依存しないロジックはすべてここでテストする
- `docs/template-setup.md` テンプレートの反映手順（テンプレートの産物。設定後は削除か書き直し）

## 画像処理の方針

- 「黒」は画素の最も明るいチャンネルで測る（赤 (255,0,0) は黒ではない）。透明は白として扱う
- 黒さ（0〜255）は読み込み時に一度だけ計算し、しきい値を動かしたときは線の濃さだけ作り直す。塗った色は別のバッファに持つので、しきい値を変えても塗りは残る
- 塗れる画素 = 黒さがしきい値未満。塗る範囲は4近傍の連結領域。線の濃さは、しきい値以上で完全な黒、しきい値の半分以下で0、間はなめらか（縁のなめらかさを残すため）。最終画像 = 塗った色 × (1 − 線の濃さ)
- 元に戻す/やり直しは塗りごとの差分（画素の番号と元の色）を持つ。最大50回、画像は長辺2048pxまで

## 層と状態

- 画素ごとに2つの層を持つ: 領域の色 `colors`（RGBA、初期は不透明な白）と、線の色 `lines`（RGBA、初期は不透明な黒）。最終画像は `compose` で「線を領域の色に重ねた」もの。キャンバスは透明度つきで、半透明の所は市松模様（CSS の背景）が透ける
- 領域の番号 `regions.labels`（線の上は 0）は読み込み時としきい値の変更時に作り直す。選択はこの番号の集合なので、作り直すときに解除する
- 元に戻す/やり直しは操作ごとの差分（層・画素の番号・元の色）。塗りつぶし・まとめ塗り・ブラシの1ストロークがそれぞれ1操作
- ブラシは線の濃さが 0 でない画素（`alpha > 0`）だけを `lines` に書く。領域の色は変えない

## このリポジトリの現状

- 公開リポジトリ。main はルールセット `protect-main`（`.github/protect-main.json`）が有効で、GitHub Pages も有効（2026-11-10 に API で確認）。`docs/template-setup.md` の手順 1・2 は済み
