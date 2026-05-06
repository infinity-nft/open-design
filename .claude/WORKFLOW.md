# Local-fork workflow

Правила работы с этим форком `nexu-io/open-design`. Только для `local-main`,
в upstream не уходит (`.claude/` в upstream `.gitignore`).

## 1. Карта веток

```
main                     ← зеркало upstream/main, never commit here
local-main               ← рабочая ветка: кастом фичи + WIP
contrib/<feature>        ← PR-ветка, создаётся только под одобренный RFC
archive/*                ← снапшоты истории, не трогать
wip/*                    ← одноразовые бэкапы, можно удалять
```

**Правило:** ежедневная работа — на `local-main`. Никогда не коммитить
напрямую в `main`. PR-ветки никогда не базируются на `local-main` —
только от свежего `upstream/main`.

## 2. Daily rhythm

- **Старт сессии:** `/start` → видно текущее состояние, что нового в upstream
- **Раз в 1-3 дня:** `/sync` → обновляет main + rebase local-main
- **Перед PR:** `/contribute <sha>` → cherry-pick на чистую contrib-ветку

## 3. Как НЕ создавать конфликты

### a) Не развивать конкурирующие фичи

Перед тем как кодить новое в существующих файлах — посмотреть в upstream
issues/PRs нет ли там аналогичной фичи в работе. Если есть — присоединиться
к обсуждению, а не делать своё параллельно.

Пример что у нас сейчас сломалось: drawing/editing на `local-main` пишет
в те же кнопки FileViewer.toolbar, куда upstream добавил `manualEdit`.
При rebase — naive auto-merge ломает JSX.

### b) Маленькие изолированные коммиты

Один коммит = одна логическая правка. Если фича большая — несколько
коммитов в порядке наследования (contracts → daemon → web → docs → tests).
Это позволяет dropp'ить отдельные коммиты при rebase, не теряя всю фичу.

### c) Rebase'иться часто

Если main отстал от upstream на 3-5 коммитов — `/sync`. Не давать
расхождению расти до десятков — там точно будут конфликты.

### d) При конкурирующих фичах — стратегия

Когда rebase встречает «обе стороны меняли одну строку»:

```bash
# Вариант 1: ваш патч — приоритет (drawing/editing — ваша фича)
git rebase upstream/main --strategy-option=theirs

# Вариант 2: drop конфликтующий коммит, переписать поверх свежего upstream
git rebase -i upstream/main   # пометить commit как `drop`

# Вариант 3: вручную смержить — только если структура файла понятна
# (НЕ через python концат — ломает JSX/синтаксис)
```

## 4. Работа над несколькими контрибуциями

```
Issue / RFC  →  ждём direction от maintainer
              ↓
              git checkout -b contrib/<feature> upstream/main
              ↓
              cherry-pick relevant commits (НЕ branch из local-main)
              ↓
              cleanup: один логический коммит на единицу review
                - feat(contracts): types
                - feat(daemon): backend
                - feat(web): UI
                - test(daemon): coverage
                - docs(architecture): API mention
              ↓
              validation gates ниже
              ↓
              push + gh pr create
```

**Никогда** не открывать второй PR пока первый не приземлился. Maintainer'ы
маленьких проектов не любят флуд из одного источника.

## 5. Validation gates перед PR

Все обязательные:

```bash
pnpm guard                                   # repo invariants
pnpm typecheck                               # все пакеты
pnpm --filter <pkg> test                     # tests touched-by-PR
pnpm --filter @open-design/web build         # production SSG check
git diff upstream/main..HEAD | grep -iE "console\.|TODO|debugger"  # 0 hits
```

## 6. PR review iteration

1. Получили review (Codex bot или человек) → читать внимательно
2. **Fix push в ту же ветку**, не создавать новую (комменты теряют контекст)
3. Reply комментарий: `commit SHA + что изменилось + новые тесты`
4. Если попросили rebase — `git fetch upstream && git rebase upstream/main && git push --force-with-lease`
5. Никогда `git push --force` — всегда `--force-with-lease`

## 7. Когда что-то ломается

### Daemon на старом коде после переключения веток

```bash
pnpm install
pnpm --filter @open-design/daemon build
pnpm --filter @open-design/contracts build  # если меняли contracts
pnpm tools-dev stop && pnpm tools-dev
# Cmd+R в desktop окне
```

### Проекты в DB не отображаются

DB одна на машине между всеми ветками. Если проект создан на ветке X
с metadata.foo, а вы на ветке Y где код смотрит metadata.bar — file panel
будет пустым. Решение: остаться на ветке создания, ИЛИ удалить:

```bash
curl -X DELETE http://127.0.0.1:<daemon-port>/api/projects/<id>
```

### Rebase в кризисе

Если interactive rebase ушёл в bad state (broken JSX от naive auto-merge,
unresolvable conflicts):

```bash
git rebase --abort   # возвращает в исходную точку, ничего не теряется
```

Потом вручную решить strategy (см. §3.d).

## 8. Anti-patterns (никогда так не делать)

- ❌ Открывать PR без предшествующего RFC для большой фичи
- ❌ Контрибуть `.claude/`, `.cursor/`, `.opencode/` в upstream
- ❌ Использовать `git push --force` (только `--force-with-lease`)
- ❌ Коммитить `.env`, секреты, ключи
- ❌ Использовать `--no-verify` (skip hooks) без явного разрешения
- ❌ Базировать contrib-ветку на local-main (тащит в PR лишние коммиты)
- ❌ Мердж двух конфликтующих JSX-блоков через python concat (ломает синтаксис)
- ❌ Изменять .gitignore чтобы добавить кастомные пути (rebase-конфликт)

## 9. Skills как helpers

В `.claude/commands/`:
- `/start` — snapshot session state, что нового, на какой ветке
- `/sync` — обновить main с upstream, rebase local-main, валидация
- `/contribute <sha>` — подготовить чистый PR от заданного коммита

При добавлении новых скиллов — force-add (`.claude/` gitignored upstream'ом):
```bash
git add -f .claude/commands/<new>.md
```

## 10. Где искать historical context

- **Memory:** `~/.claude/projects/.../memory/MEMORY.md` — структура форка
- **PR threads:** реальное обсуждение direction'ов
- **`docs/rfc-drafts/`** (gitignored) — черновики будущих контрибуций
