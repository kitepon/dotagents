---
description: GitHub OSS の見栄え（メタデータ / README / Release / 画像 / 図 / CI バッジ）を整える。最初に監査だけして選択肢を提示し、ユーザーの GO 後に着手。
---

<!-- 前提: 2026-07 検証、2026-08-29 改訂（主言語判断点・topics基準・仕上げ確認・AI読者入口・Cursor Origin）。依存は gh CLI・GitHub 仕様が主。画像生成は実行時の MCP/Skill 検出ベース（固定名依存なし）。Codex 版 codex/skills/polish-github は本ファイル（正本）を読む薄いポインタ＝一本化済み（2026-07-04） -->

このリポジトリの GitHub 上の見栄えを整え、最初の訪問者が「何で何が嬉しいか」を 5 秒で掴めるようにする。

## 進め方

**最初に主言語を決める**: README・説明文の主言語（英語か日本語か）はスキルが決め打ちしない。ユーザー指定があればそれに従い、無ければ対象読者から推定して監査提示時に確認を取る（世界向けなら英語主、日本語話者向けの製品なら日本語主）。主言語で本 README を書き、他言語版は `README.<lang>.md` をサブとして相互リンクする。以降の「多言語版」は決めた主言語を前提に読み替える。

次に **現状監査** だけ実行し、結果と「何を直すか」の選択肢を効果 / コスト表でユーザーに提示する。
ユーザーが GO サインを出してから着手する。「全部やれ」と来たらまとめて進めて良い。
不可逆操作（push / Release 作成 / repo 設定変更 / tag push / Settings 書き換え）は事前に一言告知してから実行。

## 監査でチェックすること

### 1. GitHub 側のメタデータ

```sh
gh repo view --json nameWithOwner,defaultBranchRef,description,homepageUrl,repositoryTopics,latestRelease,hasDiscussionsEnabled,openGraphImageUrl,usesCustomOpenGraphImage,licenseInfo
```

- `description` が古いバージョンの説明で止まっていないか
- `topics` が付いているか（検索キーワードとして機能する語で、ドメイン・言語・カテゴリ・関連エコシステムを覆えているかで判断する。数の下限基準は置かない。上限 20）
- `homepageUrl` が空欄でないか（npm / docs サイト / デモ等）
- `latestRelease` の tag が実装の最新と乖離していないか
- Custom OG image があるか（無ければ作成提案）
- Discussions が有効か
- 公開repoなのにlicenseが未検出でないか
- default branch名がREADME、docs URL、badge、workflow、配布metadataと一致するか

### 1.5. 公開OSSの健全性

```sh
gh api repos/{owner}/{repo}/community/profile
gh api repos/{owner}/{repo} --jq '{visibility,has_issues,has_projects,has_wiki,has_discussions,security_and_analysis}'
```

- Community ProfileのLICENSE / CONTRIBUTING / SECURITY / CODE_OF_CONDUCT / Issue template / PR templateを確認する
- repoの成熟度と想定contributorに必要なものだけを提案し、100%表示を目的化しない
- secret scanning、push protection、Dependabot security updatesの状態を確認する
- Projects / Wiki / Discussionsは空の入口を惰性で有効化せず、READMEから案内できる運用先だけを残す
- 公開repoでlicenseが無い状態は「利用条件未提示」として見栄えより先に明示する。license種類は推測せずユーザー裁定を得る

### 1.7. AI 読者の入口

README は人間だけでなく AI（要約・評価・導入判断を行うアシスタント）が読む対象になっている（2026 現在の公式・業界共通認識）。

- AI エージェント向けの機械可読な入口（`AGENTS.md` / `CLAUDE.md` / `.github/copilot-instructions.md` 等）が、そのプロジェクトの利用形態に照らして必要かを判断する。agent skill・MCP サーバー・開発ツールは効果が大きく、純粋なライブラリは README が正確なら不要なことも多い
- 冒頭の 1 行 pitch が「AI が要約しても誤らない」記述か（比喩だけの pitch は AI 経由の紹介で歪む）

### 2. README の構造

- 冒頭が長文ステータス段落で始まっていないか（5 秒で掴める 1 行 pitch があるか）
- 「30 秒で何ができるか」の使用例があるか
- 競合との比較表（似たツール / 既存手段との差分）があるか
- 主言語（冒頭で決めたもの）以外の読者向けサブ版（例: `README.ja.md` / `README.en.md`）があるか、相互リンクされているか
- 過去のバージョン履歴やレガシーな長文が hero を圧迫していないか（折りたたむべきか）

### 3. README 内の図

- アーキテクチャ図 / フロー図 / 概念図があるか
- 構造を文章だけで長く説明している箇所が冒頭にあれば、図化候補

### 4. プロジェクトの性格（画像戦略の前提）

監査時にユーザーに 1 問確認するか、README とコードベースから推定する:

| 区分 | 例（一般的に該当しがちな領域） | 画像戦略の方向性 |
|---|---|---|
| A. 硬派 / 開発者向け CLI / 実用ツール | grep 系、ファイル操作、ビルドツール、git ヘルパ | hero 1 枚 + アーキ図、装飾は控えめ。情報優先 |
| B. プロダクト / アプリ系 | dashboard, web app, SaaS OSS, デスクトップアプリ | hero 凝る + スクショ多め、機能アイコン可 |
| C. ライブラリ / フレームワーク | UI ライブラリ、ORM、Web フレームワーク | ロゴ + ベンチマーク図、ブランディング強め |
| D. 創造系 / アート / クリエイティブツール | generative art、デザインツール、ゲーム系 | 派手 OK、ビジュアル主導 |

性格に対して画像が過剰だと「中身より見せ方」と読まれて逆効果、控えめ過ぎると「メンテされてない」と読まれる。**マッチさせる**。これは押し付けではなく判断材料として提示する。

### 5. CI バッジ / 実行状態

README に CI バッジがあって status が failing なら監査対象に含める。
`gh run list --limit 5` で直近の状態を確認。

### 6. CHANGELOG / git tag / GitHub Release の整合性

```sh
git tag --sort=-v:refname
gh release list --limit 20
git log --oneline -30
```

これらを突き合わせ、tag があるのに Release が無いバージョン、CHANGELOG にあるのに tag が無いバージョンを洗い出す。さらに次を確認する。

- package manifest（`package.json`、language固有manifest等）の配布version、release notes、最新tag、latest Releaseが一致するか
- 各release tagがdefault branchの祖先か。`git merge-base --is-ancestor <tag> <default-branch>`が非0なら、Release不足ではなく履歴整合問題として分離する
- annotated / lightweight tag、tagが指すcommit、default branchとの差分を実物で確認する
- tagのforce更新や付け替えは履歴改変として扱い、通常のRelease作成に混ぜず、影響とrollbackを説明して明示承認を得る

### 7. Cursor Origin との併用（該当 repo のみ）

repo が Cursor Origin（origin.cursor.com）と同期・併用されている場合:

- 公開の顔（README 描画・topics・Social preview・検索流入・star）は当面 GitHub 側にしか無い（Origin は初期β・チーム向け作業面。2026-08 実測）。見栄え整備の対象は GitHub のままでよい
- 同期モード（Sync from GitHub）の repo は Origin への push が GitHub へ素通しされるため、見栄え整備の commit をどちらの remote から送っても公開面に届く
- Origin は初期βで機能が動くため、公開面・topics 相当・共有画像相当が Origin に生えていないかを**使う時点で再確認**し、生えていたら本節を実測で更新する

## 監査後にユーザーに出す提示形式

軸ごとに表で出し、推奨順をつける。例:

| 軸 | 効果 | コスト | 内容 |
|---|---|---|---|
| A. メタデータ修正 | 中 | 小 | description / topics / homepage / Discussions |
| B. Release 追いつき | 中 | 小 | 未 release の tag に GitHub Release を作成、CHANGELOG から notes 流用 |
| C. README hero 刷新 | 大 | 中 | 1 行 pitch + 30 秒使用例 + 比較表、長文は `<details>` で折りたたみ |
| D. 多言語 README | 中 | 中 | 主作者の言語版 README、相互リンク |
| E. OG バナー（共有時の絵） | 大 | 小〜中 | 1280x640 PNG、性格に合わせた密度 |
| F. README hero 画像 | 中 | 小〜中 | OG とトーンを揃えた縦横自由のビジュアル |
| G. アーキ図 / フロー図 | 中 | 小 | 構造を 1 枚で伝える |
| H. CI 緑化 | 小〜中 | 案件次第 | 失敗 job を root cause 特定して直す。元から壊れてた既存問題は別タスク扱い |
| I. OSS健全性 | 大 | 小〜中 | LICENSE / SECURITY / CONTRIBUTING / Issue・PR導線、security設定 |
| J. 履歴・配布整合 | 大 | 案件次第 | package / tag / default branch / Release / notesの対応を修復 |

ユーザーに「どこから着手するか」を聞く。「全部やれ」「A+B だけ」等の指示を待つ。

## 画像生成ツールの役割分担（汎用ガイド）

環境に応じて利用可能なツールが違う前提で、**第一選択 / 補助 / fallback** を併記する。AI 画像生成 MCP（OpenAI gpt-image, Google Imagen, etc.）が使えるなら **OG / README hero は AI 生成を第一選択**。日本語などのテキストを画像内に焼き込む案件で特に効く。

| 用途 | 第一選択 | 補助 / 代替 | fallback（ツール無し） |
|---|---|---|---|
| OG バナー（テキスト主体、1280x640 PNG） | AI 画像生成 MCP（gpt-image 系はタイポ強い） | ポスター系 Skill（レイアウト品質）、画像編集ツール | SVG を `.github/og.svg` に手書き |
| README hero 画像 | AI 画像生成 MCP | ポスター系 Skill | SVG / PNG 既存素材 |
| 抽象背景パターン | 生成アート Skill (p5.js 等) | AI 画像生成 MCP | 単色 / グラデーション SVG |
| アーキテクチャ図 / フロー図 | mermaid（GitHub native レンダ + git diff 可能） | mermaid プレビュー MCP（claude-mermaid 等） | テキスト箇条書きで構造説明 |
| 概念図 / 手書き感の図 | excalidraw MCP（PNG export） | mermaid | 静的 PNG |
| リリース告知 GIF（Slack 等） | GIF 作成 Skill | — | 静止画告知 |
| バージョン違いの量産（ベース固定 + 文字差し替え） | AI 画像生成 MCP の edit 系 | テンプレ画像 + 画像編集 | 手作業 |

**ツール検出の流れ**: 監査時に利用可能 MCP / Skill を確認し、**この repo の作業で使えるツール一覧**をユーザーに提示してから戦略を選ぶ。

## 実行のルール

### 既存資産の扱い
- **既存の長文を消さず折りたたむ**: 過去のステータス / バージョン履歴は `<details><summary>...</summary>...</details>` で残す。情報量を削るのではなく見せ方を変える
- **既存画像があれば上書き前に確認**: 同名ファイルを生成する前に diff を提示

### CI 修正
- **責任範囲を明確化**: 「自分の変更で壊れたもの」と「元から壊れてた既存問題」を区別し、後者は独立タスクとしてユーザーの判断を仰ぐ

### Release
- **Release notes は CHANGELOG から流用**: あれば該当バージョンセクションをコピー。無ければ `gh release create --generate-notes`（GitHub 自動生成）か `git log <prev>..<this>` からの生成提案を使う
- **`--latest` フラグ**: 最新の安定版にだけ付ける。古いバージョンを後追いで作る時は付けない

### OG バナー / Social preview
- **1280x640 PNG が GitHub Social preview の推奨サイズ**
- ファイル配置: `.github/og.png`（PNG 優先）または `.github/og.svg`（fallback / 編集可能ソース）
- README embed: `<p align="center"><img src=".github/og.png" alt="..." width="100%"></p>`
- **GitHub の Social preview（URL シェア時のカード）は Settings UI からの手動アップロード必須** — API 経由設定不可。生成までは自動化、アップロードはユーザーに依頼

### README hero 画像
- ファイル配置: `.github/hero.png`（または `.github/hero.svg`）
- README 冒頭、H1 の前後に embed
- OG バナーとトーン（色 / フォント / 雰囲気）を揃える。レイアウトは別で良い

### README 内の図
- **構造図 / フロー図 → mermaid**（コードブロックで GitHub がレンダ、git diff も読める、長期メンテに耐える）
- **概念図 / 手書き感 → excalidraw**（PNG export して `.github/diagrams/` に配置）
- **画像ファイル化する場合のディレクトリ**: `.github/diagrams/`

### topics
- **検索キーワードとして機能する語**を選ぶ（プロジェクトのドメイン / 言語 / フレームワーク / カテゴリ / 関連エコシステム）

### README の冒頭順序の推奨
1. OG バナー or hero 画像（任意、性格に応じて）
2. プロジェクト名 H1
3. バッジ群
4. 1 行 pitch（blockquote `>` で目立たせる）
5. 多言語版へのリンク（あれば）
6. 「30 秒で何ができるか」セクション
7. 比較表
8. 折りたたみで詳細・履歴
9. インストール / Quick start / 詳細仕様

### 画像戦略のガード（判断材料として提示、押し付けない）

- **プロジェクトの性格と画像派手さをマッチさせる**: 監査 §4 の区分に対して、画像が過剰だと逆ブランディング、控えめ過ぎると放置感。区分 A（硬派系）で派手 hero + 装飾アイコン + アニメ GIF はノイズになりやすい。区分 D（創造系）で素っ気ない README は機会損失
- **メンテ負債を避ける**: 風化する画像（UI スクショ / バージョン番号入り / コード連動の図）は意識的に選ぶ。**変わりにくい所**から作る。リリース告知 GIF を毎回作るコストを取れるかは別途判断
- **ベース画像 + 文字差し替えの再利用**: バージョンごとの告知画像は AI 画像生成 MCP の edit 系でテンプレ化、毎回新規生成しない

### 仕上げの確認（書いて終わりにしない）

変更を push した後、GitHub 上の実際の見え方を確認してから完了とする:

- README の描画（WebFetch か browser で repo ページを開く）: 画像が表示されるか、mermaid がレンダされるか、リンク切れが無いか、バッジが生きているか
- 変更した description / topics が repo ページに反映されているか
- Release を作った場合は Release ページの notes 描画
- 崩れていたら直してから完了報告する。「push したので多分表示されている」で閉じない

## 完了報告に含めるもの

- 何をやったか（軸ごと、簡潔に）
- 残作業（Settings UI でしか触れない項目、ユーザー判断が要るもの）
- tagがdefault branch外にある、license未裁定など、見栄えだけでは閉じない公開上のblocker
- 告知物の選択肢を 1 度だけ提示:
  - 告知文の下書き（Show HN / X / Reddit / dev.to / Hacker News 等）
  - リリース告知 GIF（Slack 向け、GIF 作成 Skill）
  - X 投稿用 OGP 画像（AI 画像生成 MCP の edit 系でベース流用）
  - スクショ（UI 系プロジェクトなら）

$ARGUMENTS
