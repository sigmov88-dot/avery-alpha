# Avery CLI — инструкции для агента

Терминальный AI coding-агент. Провайдер по умолчанию — OpenCode ZEN; также
поддержаны Anthropic, OpenAI, Gemini, Ollama, кастомные OpenAI-совместимые
эндпоинты и MCP-серверы.

## Конвенции

- TypeScript, ESM, strict mode. **Ноль runtime-зависимостей** — только встроенные модули Node.js (>= 20).
- Относительные импорты пишутся с расширением `.ts` (при сборке переписываются в `.js` через `rewriteRelativeImportExtensions`).
- Тесты: встроенный `node:test` (`npm test`). Запуск без установки зависимостей на Node 24: `node --test test/*.test.ts`.
- Сборка: `npm run build` → `dist/`.
- Код должен быть совместим с Node type-stripping: никаких parameter properties и других non-erasable TS-конструкций.

## Структура

- `src/provider/` — абстракция `Provider` (`types.ts`); OpenAI-совместимый базовый класс `openai.ts` (его расширяет `zen.ts` и используют кастомные провайдеры); `anthropic.ts` (Messages API), `gemini.ts` (streamGenerateContent), `ollama.ts` (NDJSON); фабрика `factory.ts` (`resolveProvider`, `availableProviders`).
- `src/mcp/` — MCP-клиент (`client.ts`: stdio + streamable HTTP), конфиг (`config.ts`: user `~/.config/avery/mcp.json` + project `.mcp.json`, формат совместим с Claude Code), адаптер в инструменты (`index.ts`: `connectMcp`, имена `mcp__<server>__<tool>`).
- `src/agent/` — агентный цикл (`loop.ts`), системный промпт (`prompt.ts`), разрешения (`permissions.ts`: правила матчатся по имени тула **и** по его kind — `write:src/**` покрывает `write_file`/`edit_file`), превью правок для диалога разрешений (`preview.ts`).
- `src/tools/` — инструменты: read_file, write_file, edit_file, bash, ls, glob, grep, todo_write (чеклист сессии, хранится в памяти). Файловые тулы обязаны резолвить пути через `resolveInCwd` (`src/util/fsx.ts`) — symlink-aware песочница cwd; выход наружу только при `ctx.allowOutsideCwd`.
- `src/tui/` — интерактивный терминальный UI (readline + ANSI): `app.ts` (цикл, слэш-команды, автодополнение), `markdown.ts` (стриминговый рендер ответов), `select.ts` (стрелочный селектор), `spinner.ts`, `banner.ts`, `ansi.ts`, `render.ts` (inline-markdown), `diff.ts` (построчный дифф для превью).
- `src/commands/` — подкоманды CLI (auth, models, config, run, mcp, providerCmd).
- `src/session/` — персистентность сессий в `~/.local/share/avery/sessions/` (файлы `0600`).
- `scripts/e2e.mjs` — e2e с мок-серверами ZEN и MCP (async spawn; spawnSync дедлочится с сетевыми детьми в sandbox-окружениях).

## Правила для изменений

- Не добавлять runtime-зависимости без обсуждения — это сознательное ограничение проекта.
- Новые инструменты: добавить файл в `src/tools/`, зарегистрировать в `src/tools/index.ts`, покрыть тестом.
- Новые провайдеры: класс в `src/provider/`, ветка в `resolveProvider`, пункт в `availableProviders`, тест с мок-сервером (образцы: `test/anthropic.test.ts`, `test/gemini.test.ts`).
- Изменения MCP: тесты `test/mcp.test.ts` (мок stdio-сервер — `test/fixtures/mock-mcp-server.mjs`) + шаг в `scripts/e2e.mjs`.
- Новые слэш-команды: кейс в `handleSlash` (`src/tui/app.ts`) + имя в `SLASH_COMMANDS` для автодополнения. Команды, запускающие ход агента (как `/init`), кладут промпт в очередь `pendingInputs`.
- У подкоманд со своими флагами (`mcp`, `provider`) аргументы парсятся сырьём до глобального `parseArgs` — см. `src/cli.ts`.
