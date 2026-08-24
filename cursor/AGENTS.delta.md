# Cursor固有差分

## shell入口

- **shell操作は、Cursor nativeの単発・背景コマンドを既定にする。** 長時間・対話・cwd保持が要る外部子（Codex/Claude/Grok）だけaiterm永続PTYを使う。Cursor親の日常shellをaitermへ流さない。
- PTY既定はhostの承認・sandboxの迂回ではない＝承認を要する操作の目的・影響・戻し方説明は入口によらず省略しない。
