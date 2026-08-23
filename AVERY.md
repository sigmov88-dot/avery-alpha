# Avery CLI — инструкции для агента

Терминальный AI coding-агент. Провайдер по умолчанию — OpenCode ZEN; также
поддержаны Anthropic, OpenAI, Gemini, Ollama, кастомные OpenAI-совместимые
эндпоинты и MCP-серверы. Маскот проекта — птичка **Avi** (`src/tui/mascot.ts`).

## Конвенции

- TypeScript, ESM, strict mode. **Ноль runtime-зависимостей** — только встроенные модули Node.js (>= 20).
- Относительные импорты пишутся с расширением `.ts` (при сборке переписываются в `.js` через `rewriteRelativeImportExtensions`).
- Тесты: встроенный `node:test` (`npm test`). Запуск без установки зависимостей на Node 24: `node --test test/*.test.ts`.
- Сборка: `npm run build` → `dist/`.
- Код должен быть совместим с Node type-stripping: никаких parameter properties и других non-erasable TS-конструкций.
- Перед коммитом прогоняй `npm run typecheck` — CI падёт на любой ошибке типов (`strict` + `noUncheckedIndexedAccess`).

## Структура

- `src/provider/` — абстракция `Provider` (`types.ts`); OpenAI-совместимый базовый класс `openai.ts` (его расширяет `zen.ts` и используют кастомные провайдеры); `anthropic.ts` (Messages API), `gemini.ts` (streamGenerateContent), `ollama.ts` (NDJSON); фабрика `factory.ts` (`resolveProvider`, `availableProviders`).
- `src/mcp/` — MCP-клиент (`client.ts`: stdio + streamable HTTP), конфиг (`config.ts`: user `~/.config/avery/mcp.json` + project `.mcp.json`, формат совместим с Claude Code), адаптер в инструменты (`index.ts`: `connectMcp`, имена `mcp__<server>__<tool>`).
- `src/agent/` — агентный цикл (`loop.ts`: режимы разрешений, превью, сабагент `runSubagent`), системный промпт (`prompt.ts`), разрешения (`permissions.ts`: режимы `auto`/`ask`/`allow-all`/`plan`/`accept-edits`; правила матчатся по имени тула **и** по kind), превью правок (`preview.ts`).
- `src/tools/` — инструменты: read_file, write_file, edit_file, bash, ls, glob, grep, todo_write (чеклист сессии, в памяти), task (read-only сабагент; запуск — через `ctx.runSubagent` из loop). Файловые тулы обязаны резолвить пути через `resolveInCwd` (`src/util/fsx.ts`) — symlink-aware песочница cwd; выход наружу только при `ctx.allowOutsideCwd`.
- `src/tui/` — интерактивный терминальный UI (readline + ANSI): `app.ts` (цикл, слэш-команды, автодополнение, Shift+Tab режимы), `markdown.ts` (стриминговый рендер ответов: таблицы, подсветка кода), `highlight.ts` (zero-dep подсветка), `mascot.ts` (маскот Avi: настроения, кадры анимации), `select.ts` (стрелочный селектор), `spinner.ts` (кастомные кадры через `start(text, { frames })`), `banner.ts`, `ansi.ts`, `render.ts` (inline-markdown), `diff.ts` (построчный дифф для превью).
- `src/commands/` — подкоманды CLI (auth, models, config, run, mcp, providerCmd).
- `src/session/` — персистентность сессий в `~/.local/share/avery/sessions/` (файлы `0600`); поле `mode` хранит режим разрешений.
- `scripts/e2e.mjs` — e2e с мок-серверами ZEN и MCP (async spawn; spawnSync дедлочится с сетевыми детьми в sandbox-окружениях).

## Правила для изменений

- Не добавлять runtime-зависимости без обсуждения — это сознательное ограничение проекта.
- Новые инструменты: добавить файл в `src/tools/`, зарегистрировать в `src/tools/index.ts`, покрыть тестом.
- Новые провайдеры: класс в `src/provider/`, ветка в `resolveProvider`, пункт в `availableProviders`, тест с мок-сервером (образцы: `test/anthropic.test.ts`, `test/gemini.test.ts`).
- Изменения MCP: тесты `test/mcp.test.ts` (мок stdio-сервер — `test/fixtures/mock-mcp-server.mjs`) + шаг в `scripts/e2e.mjs`.
- Новые слэш-команды: кейс в `handleSlash` (`src/tui/app.ts`) + имя в `SLASH_COMMANDS` для автодополнения. Команды, запускающие ход агента (как `/init`), кладут промпт в очередь `pendingInputs`.
- Новые режимы разрешений: расширить `PermissionMode` в `src/agent/permissions.ts` + матрица в `makePermissionChecker` + переключение в TUI (`MODES` в `app.ts`).
- Маскот и визуал: настроения — в `src/tui/mascot.ts`; подсветка — `src/tui/highlight.ts` (однопроходный regex, левейшая альтернатива побеждает).
- У подкоманд со своими флагами (`mcp`, `provider`) аргументы парсятся сырьём до глобального `parseArgs` — см. `src/cli.ts`.
