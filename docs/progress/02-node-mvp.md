# Node.js MVP

16.11.2026 · `node-implementation`

## Старт и каркас

`git status --short --branch` показал чистую `python-implementation`, `git log --oneline -5` подтвердил HEAD `31fc2a4`. При независимой приёмке Python прошёл 7 тестов на 3.12.3 и проверку HTTPS. Node-этап использует принятую реализацию как базу.

`git branch --list --verbose` показала `main` (`c05901b`) и `python-implementation` (`31fc2a4`). Команда `git switch -c node-implementation python-implementation` создала новую ветку с HEAD `31fc2a4`. Runtime для проверки — Node.js `v24.15.0`. Добавлены `node/netprobe.mjs` и этот отчёт.

Коммит `89ac346` (`Scaffold Node benchmark`). `git diff --cached --check` завершилась с кодом 0, `git status --short --branch` вывела только `## node-implementation`.

## Логика

Добавлены разбор CLI, проверка и маскировка URL, потоковое чтение с `fetch`, единый таймаут и расчёт метрик. `await` внутри цикла дожидается чтения 2xx до EOF или завершения обработки ошибки. Ответы 3xx обрабатываются вручную. В диагностике используются собственные категории и числовой HTTP-код.

`node --check node/netprobe.mjs` и `node node/netprobe.mjs --help` вернули 0. Единственная попытка HTTPS к `https://example.com/` вернула 0, один успех и 577 байт. Полный вывод приведён ниже.

Коммит `a0836d8` (`Implement sequential Node HTTP benchmark`). `git diff --cached --check` вернула 0, рабочее дерево после коммита было чистым.

## Тесты и документация

| Файл | Назначение |
| --- | --- |
| `node/netprobe.mjs` | CLI, проверка входа, HTTP-попытка и сводка |
| `node/test_netprobe.mjs` | Восемь тестов с локальным HTTP-сервером, включая отдельный процесс CLI |
| `README.md` | Команды для обеих версий, единицы измерения и различия транспорта |
| `docs/learning-node.md` | Учебный разбор Node.js с соответствиями Python |
| `docs/progress/02-node-mvp.md` | Этапы, фактические проверки и открытые вопросы |

### Разбор кода по блокам

- Импорты `.mjs` подключают `performance`, `pathToFileURL` и `parseArgs` из Node.js. В конце файла сравнение URL модуля с путём запуска защищает `main` от автоматического вызова при импорте тестами. Прямой запуск берёт `process.argv.slice(2)` и записывает результат в `process.exitCode`, чтобы вывод успел завершиться.
- `readOptions` отделяет параметры от одного URL, проверяет схему, учётные данные и числовые значения. Таймаут переводится из секунд в целые миллисекунды с округлением вверх. Значения свыше `2³¹ − 1` ms отклоняются из-за предела таймеров Node. Исходный query остаётся в объекте для `fetch`, а `displayUrl` содержит маркер `?[redacted]`. [Таймеры Node.js](https://nodejs.org/api/timers.html#settimeoutcallback-delay-args).
- `download` создаёт `AbortSignal.timeout` один раз и запускает монотонный таймер перед `fetch`. `response.ok` ограничивает успех статусами 2xx. Если тело присутствует, `for await...of` суммирует `Uint8Array.byteLength` до EOF. При ошибке возвращается фиксированная категория. `finally` отменяет непрочитанный поток, чтобы освободить его перед следующей попыткой.
- `main` ждёт каждую попытку через `await` внутри `for`. Успешные байты и миллисекунды накапливаются отдельно от счётчика ошибок. Для скорости используются суммарные успешные секунды. Ошибки одного запроса не влияют на байты и время другого.
- Тесты поднимают сервер на `127.0.0.1`, получают динамический порт и закрывают его через `t.after`. В тесте формул подменяются только часы. В тесте последовательности обёртки наблюдают настоящий `fetch` и EOF итератора. Отдельный процесс запускает тот же файл, что запускается по команде из README.

### Решения, альтернативы и ограничения

- Выбран встроенный `fetch` на Undici. Он поддерживает стандартные `Response.body` и `AbortSignal` без внешних npm-пакетов. `node:http` и `node:https` дали бы ручное управление соединением и моментом остановки чтения. `response.arrayBuffer()` потребовал бы держать в памяти всё тело, поэтому используется поток. [Встроенный Fetch и Undici](https://undici.nodejs.org/#undici-vs-fetch).
- Node оставляет управление пулом Undici. Python закрывает соединение после каждого запроса, поэтому повторные попытки в двух версиях могут включать разные затраты на TCP и TLS. Таймаут Node охватывает всю попытку. В Python таймаут ограничивает отдельные операции сокета. Исполнение таймера Node зависит от планирования event loop.
- Тест с gzip подтверждает, что считается размер данных, выданных потоком после распаковки. Ложная длина проверена двумя способами. Ответ с `Content-Length` и `Transfer-Encoding` одновременно отклонён HTTP-клиентом. Ответ, оборванный раньше заявленной длины, дал ошибку тела и добавил ноль частичных байтов в итог. [Правила длины тела HTTP/1.1](https://www.rfc-editor.org/rfc/rfc9112.html#section-6.3).
- Query скрыт в штатном выводе и диагностике, при этом сервер получает query в запросе. Аргументы процесса и история оболочки могут его содержать. Вывод HTTPS ниже — результат одной проверки работоспособности. Сервер, кэширование, TLS, сжатие и повторное использование соединений влияют на сопоставимость замеров.

### Фактические проверки

Windows 11, Node.js `v24.15.0`, 16.11.2026.

```text
> node --test node/test_netprobe.mjs
✔ fixed-length and chunked responses produce aggregate statistics
✔ body bytes come from the stream and contradictory HTTP framing fails
✔ invalid URLs, options and timeout never reach fetch or expose input
✔ manual redirect and 404 are errors and a later 2xx succeeds
✔ HTTP 500 and disconnect before headers yield nonzero exit on zero successes
✔ whole-attempt timeout covers headers and body; truncated bytes are discarded
✔ ten default GETs each start after the previous body EOF
✔ CLI subprocess accepts an HTTP(S) URL and masks query in its output
ℹ tests 8
ℹ suites 0
ℹ pass 8
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 810.2729
```

Индивидуальные длительности тестов опущены. Код выхода 0.

```text
> node --check node/netprobe.mjs
Syntax exit: 0
> node node/netprobe.mjs --help
Usage: node node/netprobe.mjs [options] <url>

Benchmark a sequence of HTTP(S) GET downloads.

Options:
  -n, --requests <count>    Number of GET attempts (default: 10)
  -t, --timeout <seconds>   Timeout for each complete attempt (default: 10)
  -h, --help                Show this help message
Help exit: 0
```

```text
> node node/netprobe.mjs 'https://example.com/' --requests 1 --timeout 15
URL: https://example.com/
Successes: 1; errors: 0
Average time: 432.122 ms
Total volume: 0.000550 MiB (577 bytes)
Throughput: 0.001 MiB/s
HTTPS exit: 0
```

### Состояние Git

`git diff --check` и `git diff --cached --check` вернули 0. Git предупредил о локальной настройке преобразования LF в CRLF. Вывод после коммита тестов и документации, перед обновлением этого раздела.

```text
> git status --short --branch
## node-implementation
> git log --oneline -5
430309a Test and document the Node MVP
a0836d8 Implement sequential Node HTTP benchmark
89ac346 Scaffold Node benchmark
31fc2a4 Test and document the Python MVP
89c52f0 Implement sequential HTTP benchmark
```

Проверка состояния добавлена в последний коммит через `git commit --amend --no-edit`, поэтому `430309a` в снимке — хеш до этого дополнения. Актуальный хеш показывает `git log --oneline -5`.

### Следующий шаг

Передать ветку `node-implementation` на независимую приёмку. При воспроизведении измерений обеими версиями зафиксировать URL, runtime, параметры, сжатие и политику соединений.
