# ⚡ Avery Alpha

**Avery** — терминальный AI-агент для разработки (в духе Claude Code и OpenCode):

- ☁️ **OpenCode ZEN** — облачный шлюз курируемых моделей, провайдер по умолчанию ([opencode.ai/docs/zen](https://opencode.ai/docs/zen))
- 🟣 **Anthropic** — Claude API напрямую
- 🟢 **OpenAI** — GPT-модели
- 🔷 **Google Gemini**
- 🦙 **Ollama** — локальные модели, бесплатно и приватно
- 🧩 **Любой OpenAI-совместимый эндпоинт** — LM Studio, OpenRouter, vLLM, llama.cpp…
- 🔌 **MCP (Model Context Protocol)** — внешние инструменты, конфиг совместим с Claude Code

Zero-dependency ядро на TypeScript: быстрая установка, маленький footprint, Node.js 20+.

## Установка

```bash
npm i -g avery-cli
```

## Быстрый старт

### OpenCode ZEN (по умолчанию)

```bash
avery auth login              # вставь ключ с opencode.ai
avery                         # запуск TUI в текущем проекте
```

### Anthropic / OpenAI / Gemini

```bash
export ANTHROPIC_API_KEY=sk-ant-…        # или OPENAI_API_KEY / GEMINI_API_KEY
avery --provider anthropic               # claude-sonnet-4-5 по умолчанию
avery --provider openai -m gpt-5
avery --provider gemini -m gemini-2.5-pro
```

Ключи можно сохранить в конфиге: `avery config set anthropicApiKey <ключ>`.

### Ollama (локально)

```bash
ollama pull llama3.1          # один раз скачай модель
avery --provider ollama       # модель подхватится автоматически
```

### Кастомный провайдер

```bash
avery provider add lmstudio --url http://localhost:1234/v1
avery provider add openrouter --url https://openrouter.ai/api/v1 --key env:OPENROUTER_API_KEY --model gpt-5
avery --provider lmstudio
```

`--key env:VAR` читает ключ из переменной окружения — секреты не лежат в конфиге.
`avery provider list` показывает все провайдеры, `avery provider remove <имя>` удаляет.

## MCP-серверы (как в Claude Code)

```bash
# stdio-сервер
avery mcp add fs npx -y @modelcontextprotocol/server-filesystem .

# HTTP-сервер
avery mcp add remote --url https://example.com/mcp --header "Authorization: Bearer …"

avery mcp list                 # все серверы
avery mcp test fs              # подключиться и показать инструменты
avery mcp remove fs
```

- Конфиги: `~/.config/avery/mcp.json` (user) и `./.mcp.json` (project, совместим с Claude Code).
- Формат совпадает с `.mcp.json` из Claude Code — можно шарить файл с командой.
- Инструменты серверов видны агенту как `mcp__<сервер>__<инструмент>`.
- Инструменты с `readOnlyHint` выполняются без подтверждения; остальные — через разрешения.
- Упавший сервер не блокирует сессию: предупреждение в stderr, остальные работают.
- В TUI: `/mcp` — статус серверов.

## Агентское качество (по мотивам Claude Code)

- **Системный промпт** с секциями: тон и стиль, дисциплина инструментов (выделенные тулы вместо bash-эквивалентов, читать перед правкой, проверять после), управление задачами, git-этикет, безопасность.
- **`todo_write`** — чеклист сессии: на задачах из 3+ шагов агент разбивает работу, держит один пункт «в работе» и отмечает прогресс.
- **`/init`** — агент анализирует проект и пишет AVERY.md: стек, точные команды сборки/тестов, структура, конвенции.
- **Точные описания инструментов** — «когда использовать / когда нет» (именно это Anthropic называют главным рычагом качества агента).

## Интерфейс

- Анимированный баннер с градиентом при запуске
- **Markdown-рендер ответов**: заголовки, списки, цитаты, блоки кода с фоном
- Спиннеры «думает…» и выполнения инструментов с таймером
- `/model` — **полный список моделей** провайдера: стрелки **↑↓**, ввод фильтрует, Enter выбирает
- `/provider` — переключение провайдера прямо в чате (включая кастомные)
- **Tab** — автодополнение слэш-команд
- **Ctrl+C** — прерывает текущий ход (ответ сохраняется); дважды — выход с сохранением сессии и закрытием MCP
- `-q` / `--quiet` — запуск без анимированного баннера
- Футер после каждого ответа: токены, стоимость, время
- Подтверждения разрешений: `[y] да / [n] нет / [a] всегда`

## Команды

| Команда | Описание |
| --- | --- |
| `avery` | Интерактивный TUI-режим |
| `avery run "промпт"` | One-shot режим (для скриптов и пайплайнов) |
| `avery --provider <p>` | zen (по умолчанию) · anthropic · openai · gemini · ollama · имя кастомного |
| `avery auth login/status/logout` | Ключ OpenCode ZEN |
| `avery models` | Полный список моделей активного провайдера |
| `avery mcp add/list/remove/test` | MCP-серверы |
| `avery provider add/list/remove` | Кастомные провайдеры |
| `avery config get/set` | Конфигурация |
| `avery --continue` / `--resume` | Продолжить / выбрать сессию |

## Слэш-команды в TUI

`/help` · `/init` · `/model` · `/provider` · `/mcp` · `/compact` · `/clear` · `/cost` · `/exit`

`/compact` — сжимает историю диалога через модель (summary + последние 2 сообщения), освобождая контекст на длинных сессиях.

## Разрешения и песочница

- Чтение (`read_file`, `ls`, `glob`, `grep`, read-only MCP-тулы) — без подтверждения, но **только внутри каталога проекта**: песочница symlink-aware, выход через `..`, абсолютные пути и symlink-и наружу запрещён.
- Запись (`write_file`, `edit_file`, write-MCP) и выполнение (`bash`, destructive-MCP) — спрашивают разрешения: `[y]` да, **Enter — отказ**, `[a]` — всегда (правило сразу сохраняется в конфиг).
- **Diff preview**: перед подтверждением записи виден дифф изменения (или первые строки нового файла) — решение не вслепую.
- Правила матчатся по имени тула (`bash:git *`, `write_file:src/**`) или по категории (`write:src/**` покрывает и `write_file`, и `edit_file`):

```bash
avery config set allow "bash:git *,write:src/**"
```

- Песочница при необходимости отключается: `avery config set allowOutsideCwd true`.
- В one-shot режиме (`avery run`) мутации по умолчанию запрещены; `--yes` — авто-подтверждение.

## Конфигурация

- Конфиг: `~/.config/avery/config.json` (права `0600`)
- Ключи конфига: `model`, `provider`, `allow`, `maxIterations`, `anthropicMaxTokens`, `allowOutsideCwd`, `<provider>ApiKey`, `<provider>Model`, `<provider>BaseUrl`, …
- MCP user-scope: `~/.config/avery/mcp.json` (права `0600`)
- Сессии: `~/.local/share/avery/sessions/` (права `0600`)
- Env: `OPENCODE_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` (или `GOOGLE_API_KEY`), `OLLAMA_HOST`
- Контекст проекта: `AVERY.md` в корне репозитория подхватывается автоматически (аналог `CLAUDE.md` / `AGENTS.md`)

## Разработка

```bash
npm run dev        # запуск из исходников (tsx)
npm run typecheck  # проверка типов
npm test           # тесты (node:test)
node scripts/e2e.mjs   # e2e с мок-сервером ZEN и MCP
npm run build      # сборка в dist/
```

Планы развития — [docs/ROADMAP.md](docs/ROADMAP.md). Как помочь проекту — [CONTRIBUTING.md](CONTRIBUTING.md). Сообщить об уязвимости — [SECURITY.md](SECURITY.md).

## Лицензия

MIT © Avery CLI contributors
