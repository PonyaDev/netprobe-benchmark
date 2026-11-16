# Как устроен Node.js CLI

| Задача | Node.js | Python |
| --- | --- | --- |
| Точка входа | `.mjs`, `import.meta.url`, `process.argv.slice(2)` | `if __name__ == "__main__"`, `argparse` |
| URL | `URL.parse()` и отдельная строка для вывода | `urlsplit()` и `Target` |
| GET и HTTP-статус | `await fetch()` и `response.ok` | `connection.request()`, `getresponse()` и `response.status` |
| Поток и счётчик | `for await...of`, `Uint8Array.byteLength` | `response.read()` и `len(chunk)` |
| Время и таймаут | `performance.now()`, `AbortSignal.timeout()` | `time.perf_counter()`, таймаут сокета |

## Модуль и аргументы

Расширение `.mjs` указывает Node использовать ECMAScript modules (ESM). `import` подключает встроенные модули, `export` позволяет тесту вызвать `main` напрямую. В `process.argv` сначала идут путь к Node и путь к скрипту. `slice(2)` оставляет пользовательские аргументы. Сравнение `import.meta.url` с URL запуска отличает прямой вызов CLI от импорта. В Python похожую роль выполняет проверка `__name__`. [Модули ESM в Node.js](https://nodejs.org/api/esm.html).

`parseArgs` выделяет флаги и позиционный аргумент. `URL.parse` проверяет URL и выделяет origin, путь, query и учётные данные. Клиент использует объект `URL`, а для терминала собирается отдельная строка с `?[redacted]`. Аналог этой пары в Python — `request_path` и `display_url`. Сырые ошибки парсера не печатаются, поскольку могут содержать аргумент целиком. [URL в Node.js](https://nodejs.org/api/url.html), [разбор аргументов](https://nodejs.org/api/util.html#utilparseargsconfig).

## Ответ и поток

`await fetch()` возвращает `Response`, когда доступны заголовки. Содержимое приходит через `Response.body`, поток `ReadableStream`. `for await...of` дожидается каждого доступного фрагмента. Фрагмент — `Uint8Array`, его `byteLength` даёт число байтов. В коде Python синхронный `read()` возвращает блок как `bytes`. Обе версии прибавляют только прочитанные байты. [Документация Fetch](https://undici.nodejs.org/#undici-vs-fetch), [потоки Web API в Node.js](https://nodejs.org/api/webstreams.html).

`redirect: 'manual'` оставляет обработку статуса 3xx вызывающему коду. При любом статусе вне 2xx `download` возвращает короткую категорию ошибки. `catch` превращает исключения отмены, чтения и сети в безопасные сообщения. `finally` освобождает непрочитанный поток через `cancel()`. В Python контекст `with` закрывает объект ответа, а `finally` закрывает соединение. В Node управление соединением остаётся у `fetch`.

## Часы, таймаут и последовательность

`performance.now()` возвращает монотонное время в миллисекундах. Разность берётся между вызовом `fetch` и окончанием итерации по телу. Python делает аналогичные замеры в секундах с `time.perf_counter()`. `AbortSignal.timeout()` запускает таймер на всю попытку. Тот же сигнал действует на отправку запроса, ожидание заголовков и чтение потока. Таймаут Python в этом проекте относится к блокирующим операциям сокета. [Часы `performance`](https://nodejs.org/api/perf_hooks.html#performancenow), [сигнал с таймаутом](https://nodejs.org/api/globals.html#static-method-abortsignaltimeoutdelay).

Когда `await download()` ждёт сеть, event loop может обслуживать таймеры и другие события. Сам цикл `for` при этом приостановлен. Он переходит к следующему GET только после возврата результата и завершения `finally`. Это соответствует синхронному ожиданию `download()` в цикле Python. В тесте обёртка настоящего `fetch` отмечает старт, а обёртка итератора — EOF. Десять пар проверяются без привязки к длительности запроса.

Для среднего CLI делит сумму миллисекунд на число успехов. Для скорости сначала переводит байты в MiB, время — в секунды, затем делит суммы. Таймаут или обрыв тела добавляет ошибку и исключает частичные байты из сводки.
