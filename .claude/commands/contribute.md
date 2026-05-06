---
description: Подготовить чистый PR из коммита в upstream nexu-io/open-design
allowed-tools: Bash(git:*), Bash(gh:*), Bash(pnpm:*)
argument-hint: [commit-sha-or-branch] (опционально — какой коммит/ветку отправить)
---

# /contribute — отправить изменение в upstream

Цель: взять одну фичу/фикс из локальной работы и подготовить чистый PR в `nexu-io/open-design`. Upstream не должен видеть «мусор» (несвязанные кастомизации, WIP-коммиты, переформатирование).

## Алгоритм

1. **Понять что отправляем.** Если пользователь дал аргумент `$ARGUMENTS` — это SHA коммита или имя ветки для отправки. Если нет — спросить:
   - Показать `git log --oneline local-main ^main | head -20` (что есть на local-main, чего нет в main)
   - Спросить: «какой из этих коммитов (или диапазон) отправить в upstream?»

2. **Убедиться что main свежий.** Если `main` отстаёт от `upstream/main` — сначала запустить `/sync` (или вручную сделать ff-merge), чтобы не базироваться на старом коде.

3. **Создать чистую feature-ветку от свежего main.**
   ```bash
   git fetch upstream
   git checkout -b contrib/<short-name> upstream/main
   ```
   Имя ветки — короткое, описательное в kebab-case (e.g. `contrib/folder-import`, `contrib/taste-memory-fix`).

4. **Cherry-pick выбранные коммиты:**
   ```bash
   git cherry-pick <sha1> [<sha2> ...]
   ```
   - Если конфликты — разрешить вручную, понимая что upstream пошёл вперёд.
   - Если коммит содержит ВПЕРЕМЕШКУ нужное и ненужное — лучше остановиться и предложить пользователю сначала разделить коммит локально.

5. **Финальная гигиена коммитов перед PR:**
   - Перечитать `git log -p` свежим взглядом.
   - Убедиться что в коммите НЕТ:
     - случайных правок других файлов (формат, тесты не относящиеся к фиче)
     - закомментированного кода, console.log, TODO
     - конфликт-маркеров `<<<<<<<` (sanity check: `git diff main | grep -c "<<<<<<<"`)
     - personal config (.env, локальные пути)
   - Если есть лишнее — `git rebase -i` или новая правка + amend.

6. **Validation gates** (обязательно перед push):
   ```bash
   pnpm install
   pnpm typecheck
   pnpm test
   ```
   Если что-то падает — НЕ ПУШИТЬ. Чинить.

7. **Push в свой fork:**
   ```bash
   git push -u origin contrib/<short-name>
   ```

8. **Открыть PR в upstream через `gh`:**
   ```bash
   gh pr create \
     --repo nexu-io/open-design \
     --base main \
     --head infinity-nft:contrib/<short-name> \
     --title "<тип>: <короткое описание>" \
     --body "$(cat <<'EOF'
   ## Summary
   <1-3 пункта что и зачем>

   ## Test plan
   - [ ] <конкретные шаги проверки>
   - [ ] <тесты которые должны пройти>

   ## Screenshots
   <если UI-изменения>
   EOF
   )"
   ```

9. **Финальный отчёт:**
   - URL созданного PR
   - Какие коммиты в нём
   - Что прогнали локально (typecheck/tests)
   - Какую ветку использовать для последующих доработок (если ревьюер попросит правки)

## Важные правила

- **Один PR = одна логическая идея.** Не миксовать рефакторинг + фичу + bug-fix.
- **Маленькие PR**: <400 строк диффа — намного быстрее ревьюят.
- **Сообщение коммита** в стиле upstream (см. `git log upstream/main --oneline -20`):
  - `fix(daemon): ...`, `feat(web): ...`, `docs: ...`, `chore: ...`
- **Никогда не пушить** в `nexu-io/open-design` напрямую — только через PR из своего fork.
- Перед PR — посмотреть `CONTRIBUTING.md` и `AGENTS.md` upstream'а на предмет специфических требований.
- Если PR требует обсуждения дизайна перед кодом — открыть Issue или Discussion первым.

## Если что-то идёт не так

- Cherry-pick не применяется чисто → коммит привязан к старому коду; разрешить конфликт вручную или сделать тот же эффект новым коммитом поверх свежего upstream.
- Ваш коммит делает много всего сразу → разбить с помощью `git rebase -i` (split) ПЕРЕД cherry-pick.
- Ревьюер просит изменения → правки в той же ветке, `git push` (без force, если не было rebase).

## Контекст проекта

- `origin` → `infinity-nft/open-design` (свой fork)
- `upstream` → `nexu-io/open-design`
- Структура веток: `main` (зеркало upstream), `local-main` (с кастомизациями)
