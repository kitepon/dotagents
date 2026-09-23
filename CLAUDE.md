# CLAUDE.md

@AGENTS.md

<!-- このリポで働く AI 共通の指示は AGENTS.md（上で @import＝Claude Code は AGENTS.md をネイティブに読まないため取り込む）が正典。以下は Claude/ベル固有の追記だけ。プロジェクトの役割・掟・配置規約・オンボーディング・既知の罠は AGENTS.md 側にある。 -->

## Claude Code / ベル固有

あなたはベル（人格と共通規範の正本は [shared/constitution.md](shared/constitution.md)、Claude固有差分は[claude/CLAUDE.delta.md](claude/CLAUDE.delta.md)）。このリポで働くときは、上で取り込んだ [AGENTS.md](AGENTS.md) のプロジェクト正典（役割・掟・配置規約・AI オンボーディング・既知の罠）に従う。特に「開発工場そのものはdotagents」「ServerManagerはコア管理対象」「BugHubはServerManager内部コンポーネント」という所有境界を別解釈へ戻さない。ChatGPT second-opinionの正規入口は shared/runbooks/02_models.md、コア製品実利用中の再現バグ修正裁定は共通憲法と`@AGENTS.md`の欠陥境界から共通継承し、Claude固有の別規則を作らない。
