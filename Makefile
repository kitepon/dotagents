# dotagents の静的 lint と完全 CI ゲート（正典: docs/04_ci.md）。
# 依存: shellcheck（`brew install shellcheck` / ubuntu-latest は同梱）・node/npx・Python 3。
# `make ci` の clean HOME test は Codex CLI 0.144.1 を完全 TOML parser として使う。
# markdownlint-cli2 は再現性のためバージョン固定。
SHELL := /bin/bash
# Native Windows GNU Make exports PWD as C:/..., while Git Bash creates
# symlinks using /c/... paths. Let Bash reconstruct PWD so isolated-HOME
# assertions compare one canonical path form on every host.
unexport PWD
MDLINT := npx --yes markdownlint-cli2@0.23.0
ifeq ($(OS),Windows_NT)
PYTHON := python
else
ifeq ($(OS),Windows_NT)
PYTHON := python
else
PYTHON := python3
endif
endif

.PHONY: lint lint-sh lint-py lint-js lint-md lint-constitution lint-current-docs lint-canon-migration canon-migration-gate lint-skills lint-hooks test-constitution test-current-docs test-install test-update test-oracle test-factory-core test-factory-reporter test-factory-scan test-factory-wire test-orchestrate test-lattice-cutover ci help

lint: lint-sh lint-py lint-js lint-md lint-constitution lint-current-docs lint-canon-migration lint-skills lint-hooks ## 静的 lint + skill/hook smoke

lint-sh: ## shellcheck: install.sh + bin/ と tests/ の shell スクリプト（python は lint-py へ）
	shellcheck install.sh $$(grep -lE '^#!.*sh$$' bin/*.sh tests/**/*.sh)

lint-py: ## bin/ と lib/ の Python script を構文チェック（py_compile・依存なし）
	@for f in $$(grep -lE '^#!.*python' bin/*.sh) lib/*.py lib/orchestrate/*.py; do $(PYTHON) -m py_compile "$$f" && echo "py-syntax OK: $$f"; done

lint-js: ## bin/ と lib/orchestrate/ の Node.js script を構文チェック
	@for f in bin/*.mjs lib/orchestrate/*.mjs; do node --check "$$f"; done

lint-md: ## markdownlint（緩い設定・生きた正典のみ / .markdownlint-cli2.jsonc）
	$(MDLINT)

lint-constitution: ## 共通憲法＋host deltaと生成物の完全一致を照合
	./bin/verify-constitution-parity.sh

lint-current-docs: ## 全document分類・現行状態生成物・手書き現行値を検証
	@if [ "$$GITHUB_ACTIONS" = "true" ] && [ -z "$$DOCUMENT_REGISTRY_BASE_REF" ]; then \
		printf '%s\n' 'GitHub ActionsではDOCUMENT_REGISTRY_BASE_REFが必須です' >&2; \
		exit 2; \
	fi
	node bin/render-current-docs.mjs --check --base-ref "$${DOCUMENT_REGISTRY_BASE_REF:-HEAD}"

lint-canon-migration: ## 正典移設manifestの受け皿・L0ポインタ必須句を検証
	node scripts/verify-canon-migration.mjs

canon-migration-gate: ## BASEとの差分にある正典削除行の移設被覆を検証
	@test -n "$(BASE)" || { echo "BASE is required (例: make canon-migration-gate BASE=origin/main)" >&2; exit 2; }
	node scripts/verify-canon-migration.mjs --base "$(BASE)"

lint-skills: ## Codex skill の frontmatter と安全契約を静的検証
	bash tests/skills/smoke.sh

lint-hooks: ## Claude / Codex / Grok / Cursor hook の空打ち smoke
	bash tests/hooks/smoke.sh
	bash tests/hooks/codex-smoke.sh
	bash tests/hooks/grok-smoke.sh
	bash tests/hooks/cursor-smoke.sh

test-constitution: ## 共通憲法generatorの冪等性とdrift拒否
	node --test tests/constitution/generation.test.mjs

test-current-docs: ## document registryの自動分類・生成・drift拒否
	node --test tests/docs/current-docs.test.mjs

test-install: ## 隔離 HOME の install/profile/config apply 検証
	bash tests/install/apply-claude-config.sh
	bash tests/install/quoted-hook-command.sh
	bash tests/install/apply-grok-config.sh
	bash tests/install/apply-cursor-config.sh
	bash tests/install/clean-home.sh
	bash tests/install/setup-linux-factory.sh
	bash tests/install/setup-linux-workstation-factory.sh
	bash tests/install/setup-macos-factory.sh

test-update: ## cron 最小 PATH で NVM 配下の npm を解決できることを検証
	bash tests/update/cron-env.sh

test-oracle: ## Oracle wrapper のOS非依存な入口選択を検証
	bash tests/oracle/wrappers.sh

test-factory-core: ## Caveat / Throughline / Spotter の外部コア受入契約を検証
	bash tests/factory-core/smoke.sh

test-factory-reporter: ## BugHub factory reporter のprivacy/outbox/retry/scheduler契約を検証
	node --test tests/factory-reporter/*.test.mjs

test-factory-scan: ## 工場管理製品scanの公開CLI・privacy・platform契約を検証
	node --test tests/factory-scan/*.test.mjs

test-factory-wire: ## 工場wire major別の固定製品集合・client互換契約を検証
	node --test tests/wire-v*/*.test.mjs

test-orchestrate: ## orchestration control record の契約を検証
	env -u TEMP -u TMP TMPDIR=/tmp node --test tests/orchestrate/*.test.mjs
	env -u TEMP -u TMP TMPDIR=/tmp bash tests/orchestrate/agent-routing-verifier.sh

test-lattice-cutover: ## Lattice wire v4 cutover inventoryの固定blob・GFM抽出契約を検証
	node --test tests/lattice-cutover/*.test.mjs
	node bin/lattice-todo-inventory.mjs --verify-cutover

ci: lint test-constitution test-current-docs test-install test-update test-oracle test-factory-core test-factory-reporter test-factory-scan test-factory-wire test-orchestrate test-lattice-cutover ## ローカル/CI 共通の全ゲート

help: ## タスク一覧
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  %-10s %s\n", $$1, $$2}'
