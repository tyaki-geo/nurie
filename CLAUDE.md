# CLAUDE.md

> **テンプレート由来の注意**: このファイルと `docs/template-setup.md`、`.github/` の設定は tyaki-geo/webapp-template から持ち込んだもの。下の記述は「そうなっているはずの運用」であって、このリポジトリで実際に設定済みとは限らない。ルールセットや Pages が有効かは GitHub 上で確かめ、確認できるまで前提にしない。設定を終えたらこの注意と `docs/template-setup.md` を、実態に合わせて直すか削除する。

（アプリの概要を1〜2行で書く）
公開先: https://<owner>.github.io/<repo>/

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

- `src/main.ts` エントリポイント
- `src/lib/` DOM に依存しないロジック（テストしやすい）
- `tests/` Vitest
- `docs/template-setup.md` テンプレートの反映手順（テンプレートの産物。設定後は削除か書き直し）
