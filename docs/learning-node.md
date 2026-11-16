# Node.js · от аргумента до результата

Исходник главы — [`node/netprobe.mjs`](../node/netprobe.mjs). CLI — интерфейс командной строки, через который программа принимает параметры и выводит результаты HTTP-загрузки. EOF — конец тела ответа. Минимальная версия для использованного `URL.parse` — Node.js 22.1.0. Локальная проверка выполнена на 24.15.0. Номера строк относятся к исходнику этой редакции. Команды запускайте из корня репозитория. [Выпуск Node.js 22.1.0](https://nodejs.org/en/blog/release/v22.1.0).

`CLI → проверка аргументов и URL → GET → чтение тела до EOF → накопление → вывод`

| Шаг | Что открывать |
| --- | --- |
| Загрузка и запуск | [N1. Модуль](#n1-модуль) |
| Ввод, проверки и безопасный адрес | [N2. Вход](#n2-вход), [N3. Аргументы](#n3-аргументы) |
| Запрос, поток, таймаут и очистка | [N4. Попытка](#n4-попытка), [N5. Завершение](#n5-завершение) |
| Последовательность и результат | [N6. Цикл](#n6-цикл), [N7. Сводка](#n7-сводка) |

Части исходника расположены в порядке входа и переходов между функциями. После EOF соединение может остаться открытым для будущих запросов.

## N1. Модуль

ESM (ECMAScript Modules) — стандартный формат модулей JavaScript. Расширение `.mjs` выбирает этот формат при запуске. `import` загружает имена из другого модуля, `export` делает выбранное имя доступным снаружи.

[Строки 1–16](../node/netprobe.mjs#L1-L16)

```javascript
// Command-line HTTP download benchmark for Node.js.

import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const MIB = 1024 * 1024;
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
const HELP = `Usage: node node/netprobe.mjs [options] <url>

Benchmark a sequence of HTTP(S) GET downloads.

Options:
  -n, --requests <count>    Number of GET attempts (default: 10)
  -t, --timeout <seconds>   Timeout for each complete attempt (default: 10)
  -h, --help                Show this help message`;
```

- Комментарий первой строки → задаёт краткое описание файла для читателя → его видно до импортов → на исполнение удаление не повлияет.
- `import { performance } from 'node:perf_hooks'` → подключает высокоточные часы Node → вызывается `performance.now()` при измерениях → без явного импорта ссылка в поддерживаемых версиях могла бы использовать глобальный `performance` вместо явно указанного модуля.
- `import { pathToFileURL } from 'node:url'` → подключает преобразователь системного пути в `file:`-URL → точка входа сможет сопоставить пути в одном формате → прямое сравнение Windows-пути с `import.meta.url` не совпадёт.
- `import { parseArgs } from 'node:util'` → подключает встроенный разбор аргументов → один парсер обрабатывает короткие и длинные флаги → без импорта эта ссылка не определена.
- `const MIB = 1024 * 1024` → объявляет неизменяемое имя для 1 048 576 байт → обе метрики объёма используют одну единицу → `1000 * 1000` изменит расчёт.
- `const MAX_TIMEOUT_MS = 2 ** 31 - 1` → задаёт верхний предел таймера Node в миллисекундах → валидация не даст слишком большому интервалу превратиться в короткий таймер → без ограничения значение за пределом может отработать как задержка около 1 ms.
- `const HELP =` и текст в обратных кавычках → сохраняют многострочную справку с ключами и единицами → её можно вывести без запуска HTTP → если изменить только справку, реальные параметры и значения по умолчанию не изменятся.

После загрузки модуль знает собственный адрес `import.meta.url`. `process.argv` содержит путь к Node, путь к скрипту и пользовательские параметры.

[Строки 137–139](../node/netprobe.mjs#L137-L139)

```javascript
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await main(process.argv.slice(2));
}
```

- `process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url` → проверяет наличие пути и его совпадение с адресом модуля → `import` не запускает CLI → без защиты импорт в тесте может распарсить аргументы тестового процесса.
- `process.argv.slice(2)` → выбрасывает первые два элемента → `main` получает только URL и флаги → `slice(1)` добавил бы лишний позиционный аргумент с путём к скрипту.
- `await main(...)` → берёт результат после завершения асинхронной функции → `process.exitCode` получает целое число → без ожидания результатом был бы `Promise`, то есть объект будущего результата.
- `process.exitCode = ...` → устанавливает код при штатном завершении процесса → буфер вывода может быть дописан → `process.exit(...)` завершил бы процесс сразу и при некоторых способах перенаправления мог бы обрезать вывод.

Соответствующая проверка в Python сравнивает `__name__` со `"__main__"`. В обоих случаях тест импортирует функцию. Дальше — [N2. Вход](#n2-вход). [ESM в Node.js](https://nodejs.org/api/esm.html), [таймеры](https://nodejs.org/api/timers.html#settimeoutcallback-delay-args).

**Мини-эксперимент.** Выполните `node --input-type=module -e "import { main } from './node/netprobe.mjs'; console.log(typeof main)"`. Появится `function`, справки и сетевого запроса не будет. Изменений в файлах нет.

<details>
<summary>Самопроверка</summary>

1. Что заставляет Node трактовать файл как ESM? → Расширение `.mjs`.
2. Что останется в `process.argv.slice(2)` при запуске с URL и `-n 2`? → URL, `-n` и `2` в виде трёх строк.

</details>

## N2. Вход

Функция с `async` возвращает `Promise`. Для тестов в `main` можно передать свои функции вывода и часов. В языке подстановка через `=` применяется к отсутствующему значению или `undefined`.

[Строки 94–110](../node/netprobe.mjs#L94-L110)

```javascript
export async function main(args, {
  stdout = console.log,
  stderr = console.error,
  now = () => performance.now(),
} = {}) {
  const options = readOptions(args);
  if (options.error) {
    stderr(`Error: ${options.error}`);
    return 2;
  }
  if (options.help) {
    stdout(HELP);
    return 0;
  }

  const { url, displayUrl, requests, timeoutMs } = options;
  stdout(`URL: ${displayUrl}`);
```

- `export async function main(args, { ... } = {})` → открывает функцию для импорта и задаёт объект настроек по умолчанию → CLI может вызывать её с одним аргументом, тесты подставляют часы и вывод → без `= {}` при одном аргументе разбор свойств закончился бы ошибкой.
- `stdout = console.log`, `stderr = console.error` → задают обычный вывод и отдельный поток ошибок → тесты могут заменить функции сборщиками строк → без значений по умолчанию CLI не смог бы ничего вывести при прямом запуске.
- `now = () => performance.now()` → задаёт функцию, которая берёт новое показание монотонных часов в ms при вызове → тест формул может вернуть заранее заданные времена → значение `performance.now()` без стрелочной функции было бы одним числом, а код вызывает `now()`.
- `const options = readOptions(args)` → проверяет вход до любых запросов → дальнейший код разделяет ошибку, справку и нормальный результат → перенос проверки после открытия соединения позволил бы неверному вводу дойти до сети.
- `if (options.error)`, `stderr(...)`, `return 2` → печатают безопасную причину и завершают CLI с ошибкой аргументов → запуск не отправляет GET → без раннего `return` программа попробует работать с отсутствующим URL.
- `if (options.help)`, `stdout(HELP)`, `return 0` → печатают справку и завершают успешно → для `--help` не нужен адрес → без ранней ветки справка не была бы самостоятельным режимом.
- Извлечение `{ url, displayUrl, requests, timeoutMs }` и `stdout(...)` → берут проверенные поля и выводят видимый адрес → сетевой URL остаётся для `download` → печать объекта `url` может раскрыть query.

`main` вызывает [N3. Аргументы](#n3-аргументы). Только при нормальном результате файл переходит к [N6. Цикл](#n6-цикл), где фактически вызывается загрузчик.

**Мини-эксперимент.** Выполните `node node/netprobe.mjs --help`, затем `node node/netprobe.mjs` и `$LASTEXITCODE`. Ожидаются справка без URL и затем `Error: expected one HTTP(S) URL` с кодом `2`. Сервер и откат не нужны.

<details>
<summary>Самопроверка</summary>

1. Как тест подставляет фиксированное время? → Передаёт свою функцию `now` в объекте настроек.
2. Что выводится, если `options.error` заполнено? → Сообщение в `stderr`; функция сразу возвращает `2`.

</details>

## N3. Аргументы

`parseArgs` различает позиционные аргументы и флаги. Регулярное выражение описывает допустимый вид начала URL. После предварительной проверки `URL.parse` разбирает строку до отдельных полей или возвращает `null`.

[Строки 18–45](../node/netprobe.mjs#L18-L45)

```javascript
function readOptions(args) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        requests: { type: 'string', short: 'n', default: '10' },
        timeout: { type: 'string', short: 't', default: '10' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch {
    return { error: 'invalid arguments; see --help' };
  }

  const { values, positionals } = parsed;
  if (values.help) return { help: true };
  if (positionals.length !== 1) return { error: 'expected one HTTP(S) URL' };

  const [rawUrl] = positionals;
  if (!/^https?:\/\/[^/?#\\]+/i.test(rawUrl)) {
    return { error: 'expected an absolute http or https URL' };
  }
  if (/[\s\\\u0000-\u001f\u007f]/u.test(rawUrl)) return { error: 'invalid HTTP(S) URL' };
  const url = URL.parse(rawUrl);
  if (!url) return { error: 'invalid HTTP(S) URL' };
  if (url.username || url.password) return { error: 'URL credentials are not allowed' };
```

- `function readOptions(args)` и `let parsed` → начинают разбор, выделяя переменную для результата внутри `try` → она доступна после блока → объявление `parsed` через `const` внутри `try` не дало бы обратиться к ней ниже.
- `parseArgs({ args, allowPositionals: true, options: ... })` → разбирает переданный список и разрешает позиционный URL → вход не привязан к реальному `process.argv`, что помогает тесту → без `allowPositionals` URL был бы отвергнут как неожиданный.
- `requests: { type: 'string', short: 'n', default: '10' }` → задаёт текстовый счётчик `-n` или `--requests` → код ниже проверяет его как целое → без `default` обычный запуск не получил бы десять попыток.
- `timeout: { type: 'string', short: 't', default: '10' }` → принимает строку с секундами → дальнейшая проверка поддерживает доли секунды → булев тип перестал бы принимать `5`. `help: { type: 'boolean', short: 'h' }` → делает справку переключателем без значения → строковый тип потребовал бы лишний аргумент.
- `catch { return { error: 'invalid arguments; see --help' }; }` → переводит исключение парсера в постоянный текст → неизвестный флаг может содержать URL, поэтому его значение остаётся вне диагностики → печать исходной ошибки может раскрыть вход целиком.
- `const { values, positionals } = parsed`, `if (values.help)`, `if (positionals.length !== 1)` → выделяют результаты, обрабатывают справку и требуют один адрес → проверки полей получают ровно один URL → без проверки числа лишняя строка могла бы потеряться.
- `const [rawUrl] = positionals` → берёт первый элемент → после проверки он единственный → взятие второго элемента вернуло бы `undefined`.
- `!/^https?:\/\/[^/?#\\]+/i.test(rawUrl)` → требует начало `http://` или `https://` и непустую сетевую часть перед путём, query или фрагментом. Флаг `i` допускает заглавные буквы → абсолютная форма проверяется до нормализации URL → без условия некоторые сокращённые формы могли бы стать обычным URL при разборе.
- `/[\s\\\u0000-\u001f\u007f]/u.test(rawUrl)` → ищет пробелы, обратную косую черту и управляющие символы → даёт ошибку для неоднозначного ввода → снятие проверки разрешит парсеру нормализовать некоторые символы, например обратную косую в HTTP-пути.
- `const url = URL.parse(rawUrl)` и `if (!url)` → получают структурированный URL и отклоняют `null` при неверном синтаксисе → проверяется в том числе диапазон порта → без проверки обращение к полям `null` прервало бы CLI исключением.
- `if (url.username || url.password)` → отклоняет разобранный логин либо пароль → запрос не должен использовать встроенные учётные данные → без ветки ошибка могла бы проявиться только в `fetch`, как сетевая категория. Python отдельно проверяет наличие поля имени, включая пустое имя.

После разбора строка счётчика должна стать целым, которое `Number` представляет без потери точности. Таймаут флага задаётся в секундах, сигнал Node принимает миллисекунды.

[Строки 47–61](../node/netprobe.mjs#L47-L61)

```javascript
  const requests = Number(values.requests);
  if (!/^\d+$/.test(values.requests) || !Number.isSafeInteger(requests) || requests < 1) {
    return { error: 'requests must be a positive integer' };
  }
  const timeoutMs = Math.ceil(Number(values.timeout) * 1000);
  if (!(timeoutMs > 0 && timeoutMs <= MAX_TIMEOUT_MS)) {
    return { error: 'timeout must be finite, positive and at most 2147483.647 seconds' };
  }

  url.hash = '';
  // Keep the query on the request URL and build a redacted address for display.
  const query = url.href.includes('?') ? '?[redacted]' : '';
  const displayUrl = `${url.origin}${url.pathname}${query}`;
  return { url, displayUrl, requests, timeoutMs };
}
```

- `Number(values.requests)` и `!/^\d+$/.test(values.requests)` в условии → превращают текст в число и требуют запись цифрами → счётчик не допускает дробь, знак или экспоненциальную запись → одна числовая проверка могла бы принять, например, `2e0`.
- `!Number.isSafeInteger(requests) || requests < 1` → проверяет точность представления и нижнюю границу → цикл получает положительное целое → без этих условий возможны ноль, некорректное округление очень больших значений или неверный цикл.
- `Math.ceil(Number(values.timeout) * 1000)` → переводит в ms и округляет вверх → положительная доля миллисекунды становится хотя бы 1 ms → округление вниз могло бы превратить допустимый малый интервал в 0.
- `!(timeoutMs > 0 && timeoutMs <= MAX_TIMEOUT_MS)` → отклоняет нечисло, ноль, отрицательные значения, бесконечность и переполнение таймера → проходит только интервал от 1 до максимального числа ms → проверка одной границы `<= 0` пропустила бы `NaN`.
- `url.hash = ''` → удаляет фрагмент → `?` внутри фрагмента перестаёт влиять на обнаружение query → без удаления видимый адрес мог бы ошибочно получить маркер для URL без query.
- `url.href.includes('?') ? '?[redacted]' : ''` и `` `${url.origin}${url.pathname}${query}` `` → обнаруживают разделитель, включая пустой query, и строят адрес из схемы, хоста, порта и пути → `url` для запроса сохраняет query → печать `href` вместо `displayUrl` раскрыла бы значения.
- `return { url, displayUrl, requests, timeoutMs }` → передаёт четыре проверенные величины в `main` → вывод и запрос получают разные представления адреса → возврат только видимого адреса лишил бы сервер подлинных параметров.

Python делит URL через `urlsplit`, кодирует части `quote` и строит отдельный путь. Node оставляет стандартизованное представление query в `URL`. Дальше параметры используются в [N4. Попытка](#n4-попытка). [URL API](https://nodejs.org/api/url.html#static-method-urlparseinput-base).

**Мини-эксперимент.** Выполните `node --test --test-name-pattern='invalid URLs' node/test_netprobe.mjs`. Тест перебирает URL с паролем, неверные схемы и таймауты, проверяет код `2` и отсутствие вызовов `fetch`. Должен пройти один выбранный тест. Подмена действует только во время теста.

<details>
<summary>Самопроверка</summary>

1. Что станет с `--timeout 0.0015`? → Из 1.5 ms получится 2 ms.
2. Почему проверяется наличие `?` после удаления `hash`? → Так сохраняется различие пустого query и его отсутствия, а `?` во фрагменте игнорируется.

</details>

## N4. Попытка

`fetch` получает HTTP-ответ. `await` приостанавливает текущую функцию до выдачи результата. Пока функция ждёт, цикл событий (event loop) может обслуживать сетевые события и таймеры. Заголовки доступны раньше полного тела, которое приходит как поток `ReadableStream`.

[Строки 63–79](../node/netprobe.mjs#L63-L79)

```javascript
async function download(url, timeoutMs, now) {
  const signal = AbortSignal.timeout(timeoutMs);
  let response;
  try {
    // Start before fetch to include connection setup when there is no pooled socket.
    const started = now();
    // A redirect is an HTTP result for this attempt, with no follow-up GET.
    response = await fetch(url, { method: 'GET', redirect: 'manual', signal });
    if (!response.ok) return { failure: `HTTP ${response.status}` };

    let bytes = 0;
    if (response.body) {
      // Count the chunks as they arrive to avoid buffering the entire response.
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
      }
    }
```

- `async function download(url, timeoutMs, now)` → принимает цель, лимит и часы и возвращает обещание результата одной попытки → внешнему циклу достаточно одного `await` → без `async` нельзя использовать `await` внутри неё.
- `const signal = AbortSignal.timeout(timeoutMs)` → создаёт сигнал, который станет отменённым по истечении времени → один сигнал действует на получение ответа и чтение тела → создание отдельного сигнала для каждого блока превратило бы общий лимит в серию локальных.
- `let response` и `try` → хранят ответ, если он уже появился, и перехватывают ожидаемые исключения → завершение сможет отличить сбой до заголовков от сбоя чтения → локальное объявление `response` только внутри `try` сделало бы её недоступной в `catch` и `finally`.
- `const started = now()` → берёт отметку непосредственно перед запросом → новое соединение и TLS входят в измерение, если клиенту понадобилось подключиться → отметка после `await fetch` исключит ожидание заголовков.
- `await fetch(url, { method: 'GET', redirect: 'manual', signal })` → инициирует GET и ждёт `Response` с заголовками → `manual` оставляет 3xx результатом этой же попытки, `signal` ограничивает её длительность → режим перенаправлений по умолчанию мог бы отправить дополнительные GET.
- `if (!response.ok) return { failure: ... }` → допускает только статусы 200–299 → страница ошибки не накапливает байты, а `finally` освободит её поток → без ветки 404 мог бы стать успешной загрузкой.
- `let bytes = 0` и `if (response.body)` → начинают локальный счётчик и проверяют наличие потока → корректный 204 может не иметь тела → итерация напрямую по `null` вызвала бы исключение.
- `for await (const chunk of response.body)` → ждёт очередной фрагмент, пока итератор не достигнет EOF → не нужно держать целый ответ в памяти → `await response.arrayBuffer()` собрал бы всё тело целиком.
- `bytes += chunk.byteLength` → считает размер `Uint8Array`, массива однобайтовых элементов → учитывает только данные, предоставленные потоком → чтение `Content-Length` дало бы заголовок транспортного представления, который может отличаться от распакованного тела.

Поток прочитан, либо управление попало в обработчик ошибки. Дальше — [N5. Завершение](#n5-завершение). Python похожим образом ставит таймер перед GET, а его `read` ждёт синхронно. [Встроенный Fetch](https://nodejs.org/api/globals.html#fetch), [потоки Web API](https://nodejs.org/api/webstreams.html).

**Мини-эксперимент.** Запустите `node --test --test-name-pattern='body bytes come' node/test_netprobe.mjs`. Локальный сервер отправит gzip-представление с длиной сжатых данных, а затем ответ с конфликтующим обрамлением. Тест ожидает ровно 4096 байт для успешной попытки и ошибку для второго ответа. Сервер закроется автоматически.

<details>
<summary>Самопроверка</summary>

1. Почему одного `await fetch()` недостаточно для замера? → Он возвращает управление при наличии заголовков, а тело ещё требуется прочитать.
2. Чем `byteLength` отличается от HTTP-заголовка `Content-Length` в примере с gzip? → Первое измеряет доступный распакованный фрагмент, второе относится к сжатому представлению.

</details>

## N5. Завершение

`try` содержит обычный путь, `catch` разбирает выброшенное исключение, `finally` выполняется и перед возвратом, и при ошибке. `ReadableStream.cancel()` сообщает клиенту, что оставшееся тело больше не нужно.

[Строки 80–92](../node/netprobe.mjs#L80-L92)

```javascript
    const elapsedMs = now() - started;
    if (signal.aborted || elapsedMs >= timeoutMs) return { failure: 'timeout' };
    return { bytes, elapsedMs };
  } catch {
    if (signal.aborted) return { failure: 'timeout' };
    return { failure: response ? 'incomplete response body' : 'network error' };
  } finally {
    // Release an unread stream before moving to the next attempt.
    if (response?.body && !response.bodyUsed) {
      await response.body.cancel().catch(() => {});
    }
  }
}
```

- `const elapsedMs = now() - started` → берёт длительность до окончания чтения → итог измеряет тело и ожидание ответа, очистка после замера в число не входит → чтение часов раньше EOF уменьшит измеренный интервал.
- `if (signal.aborted || elapsedMs >= timeoutMs)` → проверяет, был ли сигнал отменён или длительность достигла лимита → прошедшее время проверяется даже при запоздалой обработке таймера циклом событий → без второй части слишком долгий результат мог бы пройти до срабатывания сигнала.
- `return { bytes, elapsedMs }` → передаёт только полный допустимый результат → частичные данные остаются внутри `download` → возврат этих полей до EOF нарушит смысл метрик.
- `catch` и `if (signal.aborted) return { failure: 'timeout' }` → обрабатывают исключение, при котором сработал сигнал → одинаковая категория для ожидания заголовков и ожидания тела → без проверки отмена выглядела бы как общий сетевой сбой или обрыв тела.
- `return { failure: response ? 'incomplete response body' : 'network error' }` → выбирает безопасную категорию по наличию ответа → причина различает ошибку до появления заголовков и после них → вывод исходного исключения мог бы содержать части запроса или детали окружения.
- `finally`, `response?.body` и `!response.bodyUsed` → выбирают поток, который существует и ещё не читался → при отсутствии `response` оператор `?.` безопасно даёт `undefined`, а успешное тело уже прочитано → без проверки доступ к несуществующему ответу мог бы скрыть первоначальную ошибку.
- `await response.body.cancel().catch(() => {})` → ждёт завершения отмены потока, игнорируя вторичную ошибку очистки → сохраняет исходный HTTP-результат и освобождает непрочитанный ответ → без отмены соединение могло бы оставаться занятым, а без `.catch` ошибка очистки могла бы перекрыть категорию статуса.

Python закрывает объект ответа через `with` и соединение через `finally`. В Node `fetch` использует Undici, который управляет пулом открытых соединений. Завершённый поток позволяет клиенту использовать соединение снова, если состояние соединения и сервер это допускают. Поэтому несколько попыток Node могут включать меньше открытий TCP и TLS, чем то же число попыток Python. Результат или категория ошибки возвращается в [N6. Цикл](#n6-цикл). [Undici и встроенный Fetch](https://undici.nodejs.org/#undici-vs-fetch).

**Мини-эксперимент.** Запустите `node --test --test-name-pattern='whole-attempt timeout' node/test_netprobe.mjs`. Тест последовательно создаёт ожидание заголовков, поток с регулярными частями, обрыв тела и успех. Ожидаются две категории `timeout`, одна `incomplete response body` и 2 байта успеха, что отражено в утверждениях теста. Очистку выполняет тестовый процесс.

<details>
<summary>Самопроверка</summary>

1. Почему timeout возможен, даже если сервер регулярно передаёт данные? → Один сигнал ограничивает полное время попытки.
2. Означает ли EOF обязательное закрытие TCP-соединения? → Нет. EOF здесь относится к телу, а Undici может сохранить подключение.

</details>

## N6. Цикл

`await` приостанавливает код внутри текущей итерации. Он не запускает следующую итерацию сам, даже когда другие события обслуживаются циклом событий.

[Строки 111–124](../node/netprobe.mjs#L111-L124)

```javascript
  let successes = 0;
  let totalBytes = 0;
  let totalMs = 0;
  for (let attempt = 1; attempt <= requests; attempt += 1) {
    // Hold the next GET until this attempt has finished reading or cleaning up.
    const result = await download(url, timeoutMs, now);
    if (result.failure) {
      stderr(`Attempt ${attempt}: ${result.failure}`);
      continue;
    }
    successes += 1;
    totalBytes += result.bytes;
    totalMs += result.elapsedMs;
  }
```

- `let successes = 0`, `let totalBytes = 0`, `let totalMs = 0` → создают изменяемые накопители → результаты разных попыток складываются → инициализация внутри цикла стирала бы прошлые результаты.
- `for (let attempt = 1; attempt <= requests; attempt += 1)` → задаёт номера 1…`requests` → номер совпадает с видимой диагностикой → замена `<=` на `<` уберёт последний запрос.
- `const result = await download(url, timeoutMs, now)` → ждёт EOF или результат ошибки после `finally` → следующий GET ждёт окончания текущей попытки → без `await` в `result` оставался бы `Promise`, а цикл пошёл бы дальше немедленно.
- `if (result.failure)`, `stderr(...)`, `continue` → печатают номер и категорию и пропускают накопление → одна ошибка не останавливает дальнейшие попытки → без `continue` сложение с отсутствующими полями дало бы `NaN`.
- `successes += 1`, `totalBytes += result.bytes`, `totalMs += result.elapsedMs` → прибавляют только завершённые результаты → объём и время относятся к тем же успехам → если включить время ошибок, знаменатель больше не описывает тот же набор ответов.

Тесты наблюдают порядок событий на настоящих потоках, оборачивая сетевой вызов и итератор. Суммы уходят в [N7. Сводка](#n7-сводка).

**Мини-эксперимент.** Запустите `node --test --test-name-pattern='ten default GETs' node/test_netprobe.mjs`. Должен пройти тест с 20 событиями в порядке `GET, EOF, GET, EOF, …` и итогом 30 байт. Для наблюдения не нужно править `await` в исходнике. После теста подмена снимается.

<details>
<summary>Самопроверка</summary>

1. Где именно предотвращается старт следующей попытки? → В `await download(...)` внутри `for`.
2. Что произойдёт с байтами из ответа, оборвавшегося на середине? → В сводку не попадут; эта попытка даёт ошибку.

</details>

## N7. Сводка

Метрика в MiB/s делит сумму успешных MiB на сумму успешных секунд. Часы Node уже дают миллисекунды, поэтому деление на 1000 требуется для скорости, а для среднего времени дополнительного перевода нет.

[Строки 126–135](../node/netprobe.mjs#L126-L135)

```javascript
  const totalMiB = totalBytes / MIB;
  const average = successes ? (totalMs / successes).toFixed(3) : 'n/a';
  // Use the same successful attempts for both the byte and time totals.
  const throughput = totalMs > 0 ? (totalMiB / (totalMs / 1000)).toFixed(3) : 'n/a';
  stdout(`Successes: ${successes}; errors: ${requests - successes}`);
  stdout(`Average time: ${average} ms`);
  stdout(`Total volume: ${totalMiB.toFixed(6)} MiB (${totalBytes} bytes)`);
  stdout(`Throughput: ${throughput} MiB/s`);
  return successes ? 0 : 1;
}
```

- `const totalMiB = totalBytes / MIB` → переводит байты в MiB → используется одна единица для объёма и скорости → целочисленное округление до расчёта скорости потеряло бы короткие тела.
- `const average = successes ? (totalMs / successes).toFixed(3) : 'n/a'` → делит ms на число успехов и форматирует три знака → при нуле успехов выводится `n/a` → деление на `requests` включило бы неудачи в среднее.
- `const throughput = totalMs > 0 ? (totalMiB / (totalMs / 1000)).toFixed(3) : 'n/a'` → переводит длительность в секунды и делит суммы → защищает от деления на ноль → пропуск `/ 1000` занизит скорость в тысячу раз.
- `stdout` для `Successes` и `Average time` → показывает ошибки как разность и подписывает ms → сводка объясняет, сколько наблюдений стоит за временем → если печатать только среднее, частичный отказ станет менее заметным.
- `stdout` для `Total volume` и `Throughput` → печатает MiB с шестью знаками, точные байты и MiB/s → округление не скрывает точное число байтов → форматирование раньше вычислений исказило бы скорость.
- `return successes ? 0 : 1` → сообщает оболочке `0` при хотя бы одном успехе или `1` при полном отказе → код имеет тот же смысл, что в Python → без возврата ожидаемый код запуска потеряется. Ошибки аргументов возвращают `2` раньше.

Код принимает `process.exitCode` из [N1. Модуль](#n1-модуль). Дальше — [полный маршрут](#полный-маршрут-одного-запуска).

**Мини-эксперимент.** Выполните `node --test --test-name-pattern='aggregate statistics' node/test_netprobe.mjs`. Тест задаёт часы для 250 и 750 ms и тела на 1 и 0.5 MiB. Он проверяет 500 ms и 1.500 MiB/s. Сеть ограничена loopback, откат не нужен.

<details>
<summary>Самопроверка</summary>

1. Почему нельзя сложить скорости запросов и поделить на два? → Требуется скорость по совокупному объёму за совокупное время, которое может распределяться неравномерно.
2. Какой код возвращается после десяти неудач? → `1`; среднее и скорость выводятся как `n/a`.

</details>

## Полный маршрут одного запуска

Запустите [локальный сервер](study-guide.md#локальный-сервер) и во втором окне выполните:

```powershell
node node/netprobe.mjs 'http://127.0.0.1:8765/download?demo=study#local' -n 2 --timeout 5
$LASTEXITCODE
```

1. Сравнение адреса модуля с путём запуска допускает вход. `process.argv.slice(2)` даёт URL, `-n`, `2`, `--timeout`, `5`. `readOptions` возвращает `requests = 2`, `timeoutMs = 5000`, URL без `#local` и видимый адрес `http://127.0.0.1:8765/download?[redacted]`.
2. `main` печатает этот адрес. Первый `download` создаёт сигнал на 5000 ms, отмечает старт и отправляет GET по `/download?demo=study`. На `200` запускается итератор тела. Он читает `abc` (3 байта), достигает EOF и отдаёт миллисекунды.
3. Второй `download` получает новый сигнал. Он может работать через уже открытое соединение. После второго EOF счётчики равны 2 успехам и 6 байтам. Если замеры дали условно 2 и 4 ms, сумма равна 6 ms.
4. `main` печатает `Successes: 2; errors: 0` и `Total volume: 0.000006 MiB (6 bytes)`. Условное среднее равно 3 ms, скорость около 0.001 MiB/s. Реальные времена зависят от запуска. `process.exitCode` получает `0`.
5. Закройте сервер комбинацией `Ctrl+C`. Для сверки с синхронным маршрутом откройте [разбор Python](learning-python.md).
