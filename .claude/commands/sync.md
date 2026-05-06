---
description: Подтянуть свежий upstream nexu-io/open-design и обновить local-main
allowed-tools: Bash(git:*), Bash(pnpm:*)
---

# /sync — синхронизация с upstream

Цель: обновить локальный `main` и `local-main` относительно `upstream/main` (nexu-io/open-design) безопасно, без потери работы.

## Алгоритм

1. **Проверить чистоту рабочей копии.** Если есть незакоммиченные правки — остановиться, спросить пользователя что с ними сделать (commit / stash / abort).

2. **Fetch upstream.**
   ```bash
   git fetch upstream
   ```

3. **Показать что нового в upstream** относительно текущего main:
   ```bash
   git log --oneline main..upstream/main | head -20
   git diff --stat main..upstream/main | tail -5
   ```
   Если ничего нового — сказать «вы уже на свежем upstream» и выйти.

4. **Обновить `main`** (fast-forward only):
   ```bash
   git checkout main
   git merge --ff-only upstream/main
   git push origin main
   ```

5. **Решить судьбу `local-main`:**
   - Если `local-main` существует и отстаёт от `main` — предложить rebase:
     ```bash
     git checkout local-main
     git rebase main
     ```
   - Если будут конфликты — НЕ давить через `--force`, а остановиться, показать конфликты и помочь разрешить.
   - После успешного rebase: `git push origin local-main --force-with-lease`

6. **Перепроверить:** запустить `pnpm install` (если изменились зависимости) и `pnpm typecheck`. Если падает — откатиться, доложить пользователю.

7. **Финальный отчёт:**
   - Сколько коммитов подтянули из upstream.
   - Был ли rebase `local-main`.
   - Прошёл ли typecheck.
   - На какой ветке сейчас находимся.

## Важно

- **Никогда не делать `git push --force`** без `--with-lease`.
- **Никогда не работать на `main`** — это зеркало upstream.
- Если у пользователя на `local-main` много коммитов — лучше squash перед rebase для чистой истории, но только с явного согласия.
- Если конфликты при rebase — разрешать ВРУЧНУЮ, понимая семантику. Не делать blind `git checkout --ours/--theirs`.

## Контекст

Структура форка описана в memory `project_fork_structure.md`:
- `main` = чистое зеркало `upstream/main`
- `local-main` = `main` + кастомные фичи пользователя (taste-memory, folder-import, dev-server, drawing/editing, sketch-editor)
- Бэкапы патчей: `~/Work/open-design-backup-20260506/patches-committed/`
