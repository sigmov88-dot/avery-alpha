# Участие в разработке Avery

Спасибо, что хочешь помочь проекту! ⚡

## Быстрый старт

```bash
git clone https://github.com/sigmov88-dot/avery-alpha.git
cd avery-cli
npm install
npm run dev        # запуск из исходников (tsx)
npm test           # тесты (node:test, мок-серверы — без API-ключей)
npm run typecheck  # проверка типов
npm run build      # сборка в dist/
node scripts/e2e.mjs   # e2e с мок-сервером ZEN
```

На Node 24 тесты идут и без установки зависимостей: `node --test test/*.test.ts`.

## Конвенции

- TypeScript, ESM, strict mode (`strict` + `noUncheckedIndexedAccess`).
- **Ноль runtime-зависимостей** — только встроенные модули Node.js (>= 20).
  Это сознательное ограничение: PR с новой зависимостью начинай с обсуждения в issue.
- Относительные импорты — с расширением `.ts`.
- UI-тексты — на русском, код и комментарии — на английском/русском (как в соседних файлах).
- Любые изменения провайдеров и MCP проверяются тестами с мок-сервером (`test/zen.test.ts`, `test/mcp.test.ts` — примеры).

## Как добавить…

**Инструмент агента:** файл в `src/tools/`, регистрация в `src/tools/index.ts`, тест в `test/tools.test.ts`.

**Провайдер:** класс в `src/provider/` (смотри `anthropic.ts` / `gemini.ts` как образец), ветка в `resolveProvider` (`src/provider/factory.ts`), пункт в `availableProviders`, тест с мок-сервером, строка в README.

**Слэш-команду TUI:** кейс в `handleSlash` (`src/tui/app.ts`) + добавь имя в `SLASH_COMMANDS` (там же) для автодополнения.

## Pull requests

1. Один PR — одно изменение.
2. `npm run typecheck` и `npm test` должны быть зелёными (CI гоняет Node 20/22/24).
3. Для новых фич — тесты и обновление README.
4. Опиши в PR мотивацию: какую задачу это решает.

## Релизы

Релизы делает maintainer: тег `v*` запускает workflow `release.yml`
(тесты → сборка → `npm publish --provenance` → GitHub Release).

## Вопросы

Открой issue или discussion — отвечаем.
