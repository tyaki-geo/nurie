# テンプレートの反映手順

> **このファイルはテンプレート（tyaki-geo/webapp-template）の産物です。**
> このテンプレートから作ったリポジトリでは、下の手順を終えたら**このファイルを削除するか、実際の状態に合わせて書き直す**こと。
> 手順どおりに設定済みかどうかは、このファイルからは分からない。設定の実態は GitHub 上（Settings → Rules / Pages）と `.github/` を見て判断する。

## このリポジトリ（nurie）での状態

- 適用日: 2026-11-10
- 非公開リポジトリ（無料プラン）のため、**ルールセットと GitHub Pages は使えない**（API は「Upgrade to GitHub Pro or make this repository public」を返した）。手順 1・2 は、公開にするか有料プランにしてから行う
- そのため `deploy.yml` は `workflow_dispatch`（手動）のみにしてある。Pages が使えるようになったら、ファイル内のコメントにしたがって `push` のトリガを戻す
- 直す箇所のうち、`package.json` の name、`index.html` の title、`CLAUDE.md` の概要、サンプルコードの削除は済み。`CODEOWNERS` は tyaki-geo のまま
- `dependabot.yml` は持ち込んでいない

## テンプレート由来の項目（使うときに直すもの）

| 項目 | 場所 | 直すこと |
| --- | --- | --- |
| パッケージ名 | `package.json` の `name` | プロジェクト名に |
| ページタイトル | `index.html` の `<title>` | アプリ名に |
| レビュー担当 | `.github/CODEOWNERS` | レビューする人の GitHub ユーザー名に |
| 公開先 URL | `CLAUDE.md` の「公開先」 | 実際の URL に |
| サンプルコード | `src/lib/greet.ts`、`tests/greet.test.ts`、`src/main.ts` | 実装を始めたら削除 |
| アプリ概要 | `CLAUDE.md` の冒頭 | プロジェクトの説明に（テンプレートの注記も消す） |

## 1. main の保護（ルールセット）

ルールセットはリポジトリ管理者が GitHub の UI から作る。ファイルを置くだけでは有効にならない。

1. リポジトリの Settings → Rules → Rulesets → New ruleset → **Import a ruleset**
2. `.github/protect-main.json` を選ぶ
3. 取り込まれた内容を確認し、Enforcement status が **Active** であることを見て **Create**

### 内容

| ルール | 意味 |
| --- | --- |
| `deletion` | main の削除を禁止 |
| `non_fast_forward` | main への force push を禁止 |
| `pull_request` | PR 必須。承認1件、Code Owners のレビュー必須、push で古い承認を取り消す、コメントの解決必須 |
| `required_status_checks` | CI のジョブ `check` の成功が必須。ブランチが main の最新であることも要求（`strict`） |

`integration_id: 15368` は GitHub Actions。

### 例外（bypass）

`bypass_actors` は `actor_id: 5`（リポジトリの Admin ロール）、`bypass_mode: pull_request`。

- 管理者は PR のマージ画面で「Merge without waiting for requirements to be met (bypass rules)」にチェックを入れるとルールを飛ばせる
- 例外は PR のマージ時だけ。main への直接 push は管理者でもできない
- 一人開発で自分の PR を承認できないための設定。複数人で開発するときは `bypass_actors` を `[]` にして、`protect-main.json` と UI のルールセットの両方を直す

### ルールセットを変えるとき

UI で直したら、`protect-main.json` も同じ内容に直す（逆も同じ）。JSON は UI の Export で取り出せる。

## 2. GitHub Pages

1. Settings → Pages → Build and deployment の Source を **GitHub Actions** にする
2. main にマージされるたびに `.github/workflows/deploy.yml` が公開する
3. 公開先は `https://<owner>.github.io/<repo>/`。`BASE_PATH` はワークフローがリポジトリ名から渡す
4. 初回は Actions タブでデプロイが成功したことを確認する

## 3. CI

- `.github/workflows/ci.yml` が PR と main への push で `npm ci` → `typecheck` → `test` → `build` を実行する
- **ジョブ名 `check` はルールセットの必須チェック名と一致させる**。変えるなら `protect-main.json` と UI のルールセットも同時に直す。合っていないとチェックが待ち状態のままになり、マージできなくなる
- Actions の権限は既定のままでよい（各ワークフローが `permissions` を明示している）
- 実行環境は `ubuntu-24.04` に固定している

## 4. 作り始めの順序（目安）

1. テンプレートからリポジトリを作る（または中身をコピーして push）
2. 上の「使うときに直すもの」を直して、最初のコミットを main に入れる（ルールセットを入れる前なので直接 push できる）
3. Actions で CI を一度走らせて成功を確認する
4. ルールセットを取り込む（手順 1）
5. Pages を有効にする（手順 2）
6. 以後は、ブランチを切って PR を出す
