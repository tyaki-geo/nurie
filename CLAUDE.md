# CLAUDE.md

> **テンプレート由来の注意**: このファイルと `docs/template-setup.md`、`.github/` の設定は tyaki-geo/webapp-template から持ち込んだもの。下の記述は「そうなっているはずの運用」であって、このリポジトリで実際に設定済みとは限らない。ルールセットや Pages が有効かは GitHub 上で確かめ、確認できるまで前提にしない。設定を終えたらこの注意と `docs/template-setup.md` を、実態に合わせて直すか削除する。

線画に色を載せる塗り絵用の Web アプリ。読み込んだ画像から黒い線だけを抽出し、線で囲まれた領域を RGB で指定した色で塗る。画像はブラウザ内だけで処理する。
公開先: なし（このリポジトリは非公開で、GitHub Pages は使えない）

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

- `src/main.ts` 画面（読み込み・クリックで塗る・色の選択・元に戻す/やり直し・保存）。`index.html` に画面の骨組みと CSS
- `src/lib/lineart.ts` 画像処理（黒さの計算、線の抽出、領域の塗りつぶし範囲、色の変換）。DOM に依存しない
- `tests/` Vitest（`lineart.test.ts`）
- `docs/template-setup.md` テンプレートの反映手順（テンプレートの産物。設定後は削除か書き直し）

## 画像処理の方針

- 「黒」は画素の最も明るいチャンネルで測る（赤 (255,0,0) は黒ではない）。透明は白として扱う
- 黒さ（0〜255）は読み込み時に一度だけ計算し、しきい値を動かしたときは線の濃さだけ作り直す。塗った色は別のバッファに持つので、しきい値を変えても塗りは残る
- 塗れる画素 = 黒さがしきい値未満。塗る範囲は4近傍の連結領域。線の濃さは、しきい値以上で完全な黒、しきい値の半分以下で0、間はなめらか（縁のなめらかさを残すため）。最終画像 = 塗った色 × (1 − 線の濃さ)
- 元に戻す/やり直しは塗りごとの差分（画素の番号と元の色）を持つ。最大50回、画像は長辺2048pxまで

## このリポジトリの現状（テンプレート適用時点）

- リポジトリは非公開（無料プラン）で、ルールセットと GitHub Pages は使えない。`.github/protect-main.json` は置いてあるが未適用。`deploy.yml` は手動実行のみにしてある。公開にするか Pro にしたら `docs/template-setup.md` のとおり有効にする
