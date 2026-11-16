# Python · от аргумента до результата

Исходник главы — [`python/netprobe.py`](../python/netprobe.py). CLI — интерфейс командной строки. Эта программа запускается на Python 3.10+ и измеряет HTTP-загрузку средствами стандартной библиотеки. EOF означает конец тела ответа. Номера строк относятся к исходнику этой редакции. Команды запускайте из корня репозитория.

`CLI → проверка аргументов и URL → GET → чтение тела до EOF → накопление → вывод`

| Шаг | Что открывать |
| --- | --- |
| Подготовка и вход | [P1. Модуль](#p1-модуль) |
| Параметры и проверка | [P2. Аргументы](#p2-аргументы), [P3. URL и числа](#p3-url-и-числа) |
| Запрос и тело | [P4. Попытка](#p4-попытка) |
| Ошибки, цикл и метрики | [P5. Диагностика](#p5-диагностика), [P6. Цикл](#p6-цикл), [P7. Сводка](#p7-сводка) |

Части исходника приведены в порядке входа в программу и переходов между функциями. Python сначала объявляет все функции, а при запуске вызывает `main`. Соединение имеет свой жизненный цикл и может оставаться открытым после EOF.

## P1. Модуль

Модуль — файл, который Python может запустить или импортировать. Импорт делает определения доступными другому коду. Аннотация типа описывает ожидаемое значение и помогает при чтении кода.

[Строки 1–28](../python/netprobe.py#L1-L28)

```python
"""Command-line HTTP download benchmark."""

import argparse
import math
import socket
import ssl
import sys
import time
from dataclasses import dataclass
from http import client
from urllib.parse import quote, urlsplit


CHUNK_SIZE = 64 * 1024
MIB = 1024 * 1024


@dataclass(frozen=True)
class Target:
    scheme: str
    host: str
    port: int | None
    request_path: str
    display_url: str


class UnexpectedStatus(Exception):
    """A response outside the 2xx range."""
```

- `"""Command-line ..."""` → задаёт документационную строку модуля → описывает назначение при просмотре `__doc__` → удаление изменит встроенную справку о модуле.
- `import argparse` и `import math` → подключают парсер аргументов и числовые функции → нужны для преобразования параметров и проверки конечного таймаута → без импортов ссылки на `ArgumentParser` и `isfinite` станут неизвестными именами.
- `import socket` и `import ssl` → подключают типы сетевых исключений и исключений TLS → помогают различить сбой DNS (поиска адреса) и ошибку проверки сертификата → без этих типов диагностика потеряет специальные категории.
- `import sys` и `import time` → дают доступ к потоку диагностики, коду выхода и таймеру → связывают вычисления с терминалом и часами → без них вызовы `sys.exit`, `sys.stderr` и `time.perf_counter` не сработают.
- `from dataclasses import dataclass`, `from http import client`, `from urllib.parse import quote, urlsplit` → импортируют фабрику класса данных, HTTP-клиент и операции над URL → объединяют стандартные средства для хранения цели, запроса и кодирования → удаление любого импорта оставит соответствующие вызовы без определения.
- `CHUNK_SIZE = 64 * 1024` → задаёт верхнюю границу одного прикладного чтения (65 536 байт) → ограничивает размер отдельного блока → меньшее значение увеличит число проходов цикла. `MIB = 1024 * 1024` → задаёт 1 MiB в байтах → используется в расчёте объёма и скорости → замена на миллион изменит обе метрики.
- `@dataclass(frozen=True)` и `class Target` → автоматически создают конструктор по перечисленным полям и запрещают обычное присваивание полям после создания → передают проверенный адрес одним объектом → без декоратора вызов `Target(...)` потребует ручного конструктора. Без `frozen=True` поля могли бы случайно измениться между попытками.
- `scheme`, `host`, `port: int | None` → хранят схему, хост и необязательный номер порта → задают параметры соединения → без `None` пришлось бы явно подставлять стандартный для схемы порт перед созданием `Target`.
- `request_path` и `display_url` → хранят путь запроса и безопасную строку для экрана → связаны с разными потребителями → печать `request_path` может показать query.
- `class UnexpectedStatus(Exception)` и его документационная строка → выделяют неподходящий HTTP-статус как собственный тип исключения (сигнала об ошибке) → дают циклу возможность обработать его вместе с сетевыми сбоями → замена типом без соответствующей ветки `except` может прервать все попытки.

[Строки 166–167](../python/netprobe.py#L166-L167)

```python
if __name__ == "__main__":
    sys.exit(main())
```

- `if __name__ == "__main__"` → проверяет режим прямого запуска → импорт в тестах оставляет запуск под их контролем → без условия импорт запустит CLI.
- `sys.exit(main())` → передаёт целый результат `main` оболочке как код выхода → позволяет автоматике отличить успех от ошибок → один вызов `main()` не передаст возвращённое число оболочке.

Прямой запуск передаёт управление в [P2. Аргументы](#p2-аргументы).

**Мини-эксперимент.** Запустите `python -B -c "import sys; sys.path.insert(0, 'python'); import netprobe; print(netprobe.CHUNK_SIZE)"`. Должно появиться `65536` без справки или запроса. Временное изменение пути существует только до выхода процесса. `-B` отключает запись байткода.

<details>
<summary>Самопроверка</summary>

1. Зачем нужны два поля для адреса? → Путь для сети может содержать query. Строка для экрана скрывает его.
2. Как тест импортирует `main` без сетевых действий? → При импорте `__name__` отличается от `"__main__"`.

</details>

## P2. Аргументы

Позиционный аргумент распознаётся по месту среди параметров. Именованный задаётся ключом, например `--timeout 5`. `argparse` превращает их в объект с атрибутами и вызывает функции, переданные в `type`.

[Строки 120–136](../python/netprobe.py#L120-L136)

```python
def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Benchmark a sequence of HTTP(S) GET downloads.",
        allow_abbrev=False,
    )
    parser.add_argument("url", type=parse_target, help="HTTP(S) URL")
    parser.add_argument(
        "-n", "--requests", type=positive_int, default=10,
        help="number of GET attempts (default: %(default)s)",
    )
    parser.add_argument(
        "-t", "--timeout", type=positive_timeout, default=10.0,
        help="socket timeout in seconds (default: %(default)s)",
    )
    args, unknown = parser.parse_known_args(argv)
    if unknown:
        parser.error("unexpected arguments")
```

- `def main(argv: list[str] | None = None) -> int` → принимает список аргументов либо `None` → тест может передать свой список, при `None` парсер берёт параметры процесса → обязательный список лишил бы точку входа `main()` рабочего значения по умолчанию.
- `argparse.ArgumentParser(description=..., allow_abbrev=False)` → задаёт вводный текст и отключает сокращение длинного имени по префиксу → документированные флаги имеют однозначные имена → без запрета `--time` мог бы интерпретироваться как `--timeout`.
- `add_argument("url", type=parse_target, help=...)` → требует одну цель и передаёт строку валидатору → `args.url` получается объектом `Target` → без `type` чтение `args.url.display_url` обратилось бы к полю обычной строки.
- `"-n", "--requests", type=positive_int, default=10` → определяет два имени одного счётчика → явный ввод проходит проверку, числовое значение по умолчанию равно 10 → неверный `type` допустит неподходящие значения или передаст строку в `range`. `%(default)s` в `help` вставляет заданный default → справка остаётся согласованной с конфигурацией → буквальное число пришлось бы обновлять отдельно.
- `"-t", "--timeout", type=positive_timeout, default=10.0` → задаёт таймаут сокета в секундах → дробный ввод допустим, по умолчанию действует `10.0` → замена `type` на `int` отклонит `0.25`. Шаблон справки берёт значение из того же `default`.
- `args, unknown = parser.parse_known_args(argv)` → разделяет распознанные и неизвестные параметры → даёт возможность безопасно обработать неизвестный хвост → строгий `parse_args` может напечатать этот хвост целиком.
- `if unknown: parser.error("unexpected arguments")` → завершает CLI с кодом 2 и фиксированным сообщением → неизвестный параметр не игнорируется, а его значение не выводится этой веткой → без проверки опечатка сможет пройти незамеченной.

Парсер обращается к [P3. URL и числа](#p3-url-и-числа) и возвращает уже проверенные значения в [P6. Цикл](#p6-цикл).

**Мини-эксперимент.** Выполните `python -B python/netprobe.py --help`, затем `python -B python/netprobe.py 'http://127.0.0.1/' '--unknown=demo'` и `$LASTEXITCODE`. Ожидаются справка с `10` и `10.0`, затем `unexpected arguments` и `2`. Сервер не нужен, возвращать настройки не требуется.

<details>
<summary>Самопроверка</summary>

1. Какой код обрабатывает `--requests 2`? → `positive_int` вызывается через `type=positive_int`.
2. Почему неизвестный параметр даёт сообщение без его значения? → Его отбросили при формировании текста `parser.error`.

</details>

## P3. URL и числа

Схема (`http` либо `https`) задаёт протокол. Хост и порт указывают получателя. Query начинается с `?`, фрагмент начинается с `#` и используется на стороне клиента. Процентное кодирование представляет специальные символы через `%` и шестнадцатеричные цифры.

[Строки 31–53](../python/netprobe.py#L31-L53)

```python
def parse_target(url: str) -> Target:
    try:
        if any(char.isspace() or not char.isprintable() for char in url):
            raise ValueError
        parsed = urlsplit(url)
        if parsed.scheme not in ("http", "https"):
            raise argparse.ArgumentTypeError("URL scheme must be http or https")
        host = parsed.hostname
        port = parsed.port
        if not host or parsed.username is not None or port == 0:
            raise ValueError
    except ValueError:
        raise argparse.ArgumentTypeError("invalid HTTP(S) URL") from None
    path = quote(parsed.path or "/", safe="/%:@!$&'()*+,;=-._~")
    has_query = "?" in url.split("#", 1)[0]
    # Keep the server's query separate from the address printed to the user.
    request_path = path
    display_url = f"{parsed.scheme}://{parsed.netloc}{path}"
    if has_query:
        query = quote(parsed.query, safe="%/:?@!$&'()*+,;=-._~")
        request_path += f"?{query}"
        display_url += "?[redacted]"
    return Target(parsed.scheme, host, port, request_path, display_url)
```

- `def parse_target(url: str) -> Target` → принимает строку и возвращает объект для HTTP-клиента → у `argparse` есть единый преобразователь → при возврате необработанной строки вызывающий код не получит полей `Target`.
- `try` и `any(char.isspace() or not char.isprintable() for char in url)` → перед разбором ищут хотя бы один пробел или непечатаемый символ → мешают случайно принять URL с управляющим символом, который парсер может убрать → без проверки вход мог бы незаметно измениться. `raise ValueError` отправляет такой ввод в общую ветку обработки.
- `parsed = urlsplit(url)` → разделяет строку на схему, сетевую часть, путь, query и фрагмент → дальнейшие проверки работают с отдельными полями → разбиение вручную по `/` потеряло бы часть структуры.
- `parsed.scheme not in ("http", "https")` и `raise argparse.ArgumentTypeError(...)` → отклоняют другие схемы с отдельной причиной → загрузчик поддерживает только HTTP и HTTPS → удаление проверки направило бы другие схемы в HTTP-ветку выбора клиента.
- `host = parsed.hostname` и `port = parsed.port` → берут имя хоста и целый порт либо `None` → `parsed.port` сразу вызывает `ValueError` для некорректного или слишком большого порта → без чтения свойства ошибка обнаружилась бы позже.
- `if not host or parsed.username is not None or port == 0: raise ValueError` → запрещает пустой хост, встроенные учётные данные и нулевой порт → отделяет неверный ввод от сетевых ошибок → удаление ветки допустит URL с логином до построения `display_url`. `is not None` проверяет также пустую часть имени пользователя перед `@`.
- `except ValueError: raise ... from None` → заменяет ошибку разбора безопасным сообщением, скрывая цепочку исходного исключения → вход целиком не нужен для объяснения ошибки → вывод текста исходного исключения мог бы включить часть адреса.
- `path = quote(parsed.path or "/", safe=...)` → кодирует путь и подставляет `/` для корня → `safe` оставляет структурные символы и имеющиеся `%`-последовательности → удаление `or "/"` меняет представление корня, а удаление `%` из списка может закодировать `%2F` второй раз.
- `has_query = "?" in url.split("#", 1)[0]` → проверяет наличие разделителя даже у пустого query → `?` внутри фрагмента не влияет на вывод → проверка только `bool(parsed.query)` потеряет пустой `?`.
- `request_path = path` и `display_url = f"...{parsed.netloc}{path}"` → строят HTTP-цель отдельно от видимого адреса → в запрос идут путь и параметры, на экран попадает адрес с хостом → объединение строк повысило бы риск утечки query.
- `if has_query`, `quote(parsed.query, safe=...)`, `request_path += ...`, `display_url += ...` → сохраняют кодированный query для запроса и выводят только `?[redacted]` → сервер получает параметры → печать `query` вместо маркера раскроет значения.
- `return Target(...)` → отдаёт схему, хост, порт и обе строки парсеру → `main` получает готовую цель → потеря `port` сломает запуск на явно указанном нестандартном порту.

[Строки 56–73](../python/netprobe.py#L56-L73)

```python
def positive_int(value: str) -> int:
    try:
        count = int(value)
    except ValueError:
        count = 0
    if count < 1:
        raise argparse.ArgumentTypeError("requests must be a positive integer")
    return count


def positive_timeout(value: str) -> float:
    try:
        seconds = float(value)
    except ValueError:
        seconds = 0
    if not math.isfinite(seconds) or seconds <= 0:
        raise argparse.ArgumentTypeError("timeout must be finite and positive")
    return seconds
```

- `positive_int`, `int(value)` и `except ValueError: count = 0` → преобразуют число попыток или направляют нечисловой ввод в общую проверку → подходит только положительное целое → `float` разрешил бы дроби, с которыми `range` не работает.
- `if count < 1: raise ...` и `return count` → запрещают ноль и отрицательные значения, возвращают целое → цикл должен иметь хотя бы одну попытку → без проверки `-n 0` дошло бы до пустой сводки вместо ошибки аргументов.
- `positive_timeout`, `float(value)` и `except ValueError: seconds = 0` → принимают дробный интервал и подменяют некорректную строку нулём → следующий тест обрабатывает все непригодные значения → при `int` интервал меньше секунды невозможно ввести в таком виде.
- `not math.isfinite(seconds) or seconds <= 0` и `return seconds` → отклоняют `NaN`, бесконечность и неположительный интервал → сокету нужен конечный положительный таймаут → одна проверка `<= 0` не поймает `NaN`.

Готовый `Target` и числовые аргументы возвращаются в `main`. Дальше цель и таймаут получает [P4. Попытка](#p4-попытка).

**Мини-эксперимент.** Выполните `python -B -c "import sys; sys.path.insert(0, 'python'); from netprobe import parse_target; t=parse_target('http://127.0.0.1:8765/a%2Fb?demo=study#local'); print(t.request_path, t.display_url)"`. Сравните `/a%2Fb?demo=study` и адрес с `?[redacted]`. Используется учебное значение `demo`, сеть и последующий откат не нужны.

<details>
<summary>Самопроверка</summary>

1. Почему проверяется `parsed.port` внутри `try`? → Преобразование свойства может выбросить `ValueError` ещё до открытия сокета.
2. Что произойдёт с `http://127.0.0.1/?#f`? → Запрос сохранит пустой query как `/?`, видимый URL покажет `?[redacted]`, фрагмент отброшен.

</details>

## P4. Попытка

HTTP GET запрашивает ресурс. Ответ содержит числовой статус, заголовки и, как правило, тело. `2xx` означает успешный класс статусов. TLS защищает HTTPS-соединение, а монотонный таймер измеряет интервал независимо от перевода системных часов.

[Строки 76–87](../python/netprobe.py#L76-L87)

```python
def download(target: Target, timeout: float) -> tuple[int, float]:
    connection_class = (
        client.HTTPSConnection if target.scheme == "https" else client.HTTPConnection
    )
    connection = connection_class(target.host, target.port, timeout=timeout)
    try:
        # Start before the GET so opening the socket and TLS are part of the sample.
        started = time.perf_counter()
        connection.request("GET", target.request_path, headers={"Connection": "close"})
        with connection.getresponse() as response:
            if not 200 <= response.status < 300:
                raise UnexpectedStatus(f"HTTP {response.status}")
```

- `download(target: Target, timeout: float) -> tuple[int, float]` → принимает цель и таймаут и обещает пару «байты, секунды» при успехе → `main` может распаковать два числа → замена порядка значений поменяет смысл подсчёта.
- `client.HTTPSConnection if ... else client.HTTPConnection` → выбирает класс по схеме → HTTPS использует обычную проверку сертификата и имени сервера → выбор только `HTTPConnection` не выполнит TLS для HTTPS.
- `connection_class(target.host, target.port, timeout=timeout)` → создаёт объект для одной попытки → передаёт выбранный порт и таймаут блокирующих операций сокета → удаление `timeout` оставит глобальное значение по умолчанию.
- `try` и `started = time.perf_counter()` → ставят начальную отметку перед отправкой, внутри участка с гарантированным закрытием → в замер входят установление нового соединения и TLS → перенос старта после `getresponse` исключит ожидание заголовков.
- `connection.request("GET", target.request_path, headers={"Connection": "close"})` → отправляет GET по нужному пути и просит закрыть соединение после ответа → измерение относится к отдельной HTTP-попытке с новым подключением → удаление только заголовка не превратит клиент в пул, поскольку объект всё равно закрывается в `finally`.
- `with connection.getresponse() as response` → получает статус и заголовки и открывает контекст объекта ответа → при выходе из блока, в том числе при исключении, объект ответа закрывается → без контекста пришлось бы закрывать его явно.
- `if not 200 <= response.status < 300: raise UnexpectedStatus(...)` → останавливает неуспешные ответы перед чтением и статистикой → 302, 404 и 500 не учитываются как полезная загрузка → без условия тело страницы ошибки могло попасть в сводку. В сообщение подставляется число, а не текст сервера.

Тело читается порциями. `Content-Length` объявляет размер тела, а CPython хранит в `response.length` оставшийся объём для ответа с фиксированной длиной. При chunked-передаче библиотека сама разбирает служебное обрамление.

[Строки 89–100](../python/netprobe.py#L89-L100)

```python
            byte_count = 0
            # A bounded read keeps memory use independent of the response size.
            while chunk := response.read(CHUNK_SIZE):
                byte_count += len(chunk)
            elapsed = time.perf_counter() - started

            # Bounded reads can return EOF before the declared body length.
            if response.length:
                raise client.IncompleteRead(b"", response.length)
            return byte_count, elapsed
    finally:
        connection.close()
```

- `byte_count = 0` → начинает локальный счётчик → остатки предыдущего запроса не переносятся → без отдельного счётчика трудно исключить частично прочитанную неудачную попытку.
- `while chunk := response.read(CHUNK_SIZE)` → оператор `:=` сохраняет прочитанный блок и проверяет его непустоту → цикл выполняется до пустого блока, чтение ограничено `CHUNK_SIZE` → `read()` без размера мог бы занять память под всё тело.
- `byte_count += len(chunk)` → прибавляет размер фактически полученного блока → `Content-Length` не подменяет наблюдаемое число → если прибавлять `CHUNK_SIZE`, последний неполный блок завысит объём.
- `elapsed = time.perf_counter() - started` → измеряет до выхода из чтения → последующее закрытие соединения отдельно от замера → остановка на `getresponse()` потеряет длительность загрузки.
- `if response.length: raise client.IncompleteRead(b"", response.length)` → обнаруживает объявленный остаток после преждевременного EOF → прерванный ответ не идёт в успешные метрики → без ветки частичное тело могло бы считаться успехом. Пустой `bytes` в исключении не копирует уже просмотренные данные.
- `return byte_count, elapsed` → передаёт только завершённую загрузку → агрегатор получает проверенные числа → перенос до проверки длины отменит защиту от обрыва.
- `finally: connection.close()` → закрывает соединение после возврата или исключения → следующая попытка открывает своё подключение → без `finally` ошибки могут оставить ненужные сетевые ресурсы.

Успех возвращается в [P6. Цикл](#p6-цикл). Сбой попадает в [P5. Диагностика](#p5-диагностика). [Документация `http.client`](https://docs.python.org/3/library/http.client.html).

**Мини-эксперимент.** Запустите `python -B -m unittest discover -s python -k timeout_and_truncated -v`. Тест держит частичный ответ, затем отдаёт оборванное тело и завершается удачным двухбайтовым ответом. Ожидается `OK`. Временный сервер закрывается самим тестом.

<details>
<summary>Самопроверка</summary>

1. Когда начинается подсчёт байтов? → После проверки статуса, при первом непустом результате `read`.
2. Зачем проверять остаток после EOF? → Некоторые ограниченные чтения CPython завершаются пустым блоком даже при недостающих объявленных байтах.

</details>

## P5. Диагностика

Исключение несёт тип и иногда служебный номер ошибки. Текст исключения может содержать сведения из запроса или ответа. Диагностика здесь использует небольшой перечень безопасных сообщений.

[Строки 103–117](../python/netprobe.py#L103-L117)

```python
def failure_reason(error: Exception) -> str:
    # Raw exceptions can include request targets or server-controlled text.
    if isinstance(error, UnexpectedStatus):
        return str(error)
    if isinstance(error, TimeoutError):
        return "timeout"
    if isinstance(error, client.IncompleteRead):
        return "incomplete response body"
    if isinstance(error, socket.gaierror):
        return f"DNS resolution failed (error {error.errno})"
    if isinstance(error, ssl.SSLCertVerificationError):
        return "TLS certificate verification failed"
    if isinstance(error, OSError) and error.errno is not None:
        return f"{type(error).__name__} (error {error.errno})"
    return type(error).__name__
```

- `def failure_reason(error: Exception) -> str` → принимает пойманную ошибку и формирует строку → у цикла один способ печати → вывод самого объекта вместо преобразования открыл бы доступ к произвольному тексту.
- `isinstance(error, UnexpectedStatus): return str(error)` → берёт сообщение, которое сформировал сам `download` из числа → сохраняет HTTP-код → исключение этой ветки из обработки заменило бы `HTTP 404` общим именем класса.
- `isinstance(error, TimeoutError): return "timeout"` → выделяет истечение времени ожидания → причина видна без системного текста → перенос ниже общего `OSError` может убрать специфичную категорию.
- `isinstance(error, client.IncompleteRead): return "incomplete response body"` → выделяет сбой чтения заявленного тела → можно отличить обрыв от HTTP 404 → без ветки вернётся только имя `IncompleteRead`.
- `isinstance(error, socket.gaierror)` и `error.errno` → сообщают о сбое преобразования имени в адрес с номером → объясняют, на каком этапе возникла ошибка → без проверки `gaierror` сольётся с прочими ошибками ОС.
- `isinstance(error, ssl.SSLCertVerificationError)` → даёт отдельную категорию проверки TLS → указывает причину без сертификата и адреса → общий обработчик потерял бы этот контекст.
- `isinstance(error, OSError) and error.errno is not None` → возвращает имя типа и системный номер при его наличии → сохраняет короткую полезную деталь → без проверки печатался бы `None`.
- `return type(error).__name__` → оставляет имя класса для остальных исключений → диагностирует редкий сбой без текста сервера → замена на `str(error)` может раскрыть query или чужую строку статуса.

Строка возвращается в обработчик [P6. Цикл](#p6-цикл).

**Мини-эксперимент.** Выполните `python -B -m unittest discover -s python -k hides_server_reason -v`. Ожидается `OK`: тестовый сервер помещает путь с query в HTTP-причину, но проверяется строгое `Attempt 1: HTTP 404`. Файлы не меняются.

<details>
<summary>Самопроверка</summary>

1. Почему для `UnexpectedStatus` допустим `str(error)`? → Это собственное сообщение только из `HTTP` и числового статуса.
2. Что увидите при оборванном теле? → `incomplete response body` вместе с номером текущей попытки.

</details>

## P6. Цикл

`stdout` предназначен для результата программы, `stderr` — для диагностики. Синхронный вызов удерживает выполнение в текущей итерации до возврата или исключения.

[Строки 138–153](../python/netprobe.py#L138-L153)

```python
    print(f"URL: {args.url.display_url}", flush=True)
    successes = 0
    total_bytes = 0
    total_seconds = 0.0
    for attempt in range(1, args.requests + 1):
        try:
            byte_count, seconds = download(args.url, args.timeout)
        except (
            UnexpectedStatus, client.HTTPException, OSError, UnicodeError, OverflowError
        ) as error:
            print(f"Attempt {attempt}: {failure_reason(error)}", file=sys.stderr)
            continue

        successes += 1
        total_bytes += byte_count
        total_seconds += seconds
```

- `print(f"URL: {args.url.display_url}", flush=True)` → выводит безопасный адрес и сразу сбрасывает буфер → адрес виден перед долгой загрузкой → подстановка `request_path` может раскрыть query, удаление `flush` может задержать вывод при перенаправлении.
- `successes = 0`, `total_bytes = 0`, `total_seconds = 0.0` → создают счётчики текущего запуска → объём и время накапливаются только для удачных попыток → инициализация внутри цикла сохранила бы лишь данные последней итерации.
- `for attempt in range(1, args.requests + 1)` → перебирает номера от 1 до запрошенного числа включительно → совпадает с номерами диагностики → без `+ 1` последний запрос не будет выполнен.
- `try: byte_count, seconds = download(args.url, args.timeout)` → ждёт результат одной попытки и распаковывает пару → второй GET начинается после первого тела или после обработки ошибки → запуск независимых задач вместо прямого вызова изменил бы смысл последовательного теста.
- `except (UnexpectedStatus, client.HTTPException, OSError, UnicodeError, OverflowError) as error` → ловит ошибки статуса, HTTP-протокола, сети, кодирования и числового переполнения → одна ожидаемая ошибка не завершает весь запуск → без `OSError` сетевой сбой может прервать цикл.
- `print(... file=sys.stderr)` и `continue` → выводят номер и безопасную причину, затем начинают следующую итерацию → переменные отсутствующей или частичной загрузки не читаются → без `continue` счётчики могли бы получить старые значения или возникла бы ошибка обращения к ним.
- `successes += 1`, `total_bytes += byte_count`, `total_seconds += seconds` → добавляют только вернувшиеся результаты → числитель и знаменатель относятся к одним попыткам → если прибавлять время неудач, скорость станет описывать другой показатель.

Три суммы и число запрошенных попыток передаются в [P7. Сводка](#p7-сводка).

**Мини-эксперимент.** Запустите `python -B -m unittest discover -s python -k ten_requests -v`. Ожидается `OK`: проверяется `GET, EOF` десять раз по порядку. Тест сам закрывает локальный сервер.

<details>
<summary>Самопроверка</summary>

1. Где исключается параллельный старт? → В синхронном вызове `download` внутри одной итерации `for`.
2. Почему `continue` стоит перед изменением счётчиков? → Оно пропускает агрегирование после ошибки.

</details>

## P7. Сводка

MiB равен 1 048 576 байтам. Среднее время делит сумму длительностей на число успехов. Скорость делит сумму объёмов на сумму длительностей для тех же успехов.

[Строки 155–163](../python/netprobe.py#L155-L163)

```python
    print(f"Successes: {successes}; errors: {args.requests - successes}")
    average_ms = f"{total_seconds * 1000 / successes:.3f}" if successes else "n/a"
    total_mib = total_bytes / MIB
    # Divide the totals so each sample contributes in proportion to its duration.
    rate = f"{total_mib / total_seconds:.3f}" if total_seconds > 0 else "n/a"
    print(f"Average time: {average_ms} ms")
    print(f"Total volume: {total_mib:.6f} MiB ({total_bytes} bytes)")
    print(f"Throughput: {rate} MiB/s")
    return 0 if successes else 1
```

- `print(f"Successes: ... errors: {args.requests - successes}")` → вычисляет ошибки как разность общего количества и успехов → отдельный счётчик ошибок не нужен → вычитание в обратном порядке даст отрицательное число.
- `average_ms = ... if successes else "n/a"` → переводит секунды в миллисекунды, делит на успехи и оставляет три знака → при нуле успехов деления нет → замена делителя на `args.requests` учтёт неудачи в среднем.
- `total_mib = total_bytes / MIB` → переводит байты в MiB → один результат используется для объёма и скорости → целочисленное деление потеряло бы дробную часть для небольших тел.
- `rate = ... if total_seconds > 0 else "n/a"` → делит суммарный объём на суммарные секунды с защитой от деления на ноль → более долгие попытки сильнее влияют на итог → среднее арифметическое отдельных скоростей исказит эту взвешенную оценку.
- Три `print(...)` → подписывают единицы, показывают точное число байтов и форматируют MiB с шестью знаками → маленькие тела остаются заметны даже при округлении MiB → вывод объёма только в MiB может скрыть небольшое изменение.
- `return 0 if successes else 1` → завершает успешный или частично успешный запуск кодом `0`, полностью неуспешный — `1` → оболочка может различить эти случаи → без `return` `sys.exit(None)` выдаст `0` даже при полном отказе. Код `2` приходит раньше от парсера.

Вернитесь к [P1. Модуль](#p1-модуль), чтобы увидеть, кто передаёт результат оболочке, или пройдите [полный маршрут](#полный-маршрут-одного-запуска).

**Мини-эксперимент.** Запустите `python -B -m unittest discover -s python -k statistics -v`. Мысленно посчитайте скорость для 1 MiB за 0.25 с и 0.5 MiB за 0.75 с. Тест сверяет `1.500 MiB/s` и возвращает `OK`. Ничего возвращать вручную не нужно.

<details>
<summary>Самопроверка</summary>

1. Чему равно среднее для 250 и 750 ms? → 500 ms.
2. Что выведет скорость при нуле суммарных секунд? → `n/a MiB/s`.

</details>

## Полный маршрут одного запуска

Запустите [локальный сервер](study-guide.md#локальный-сервер) и во втором окне выполните:

```powershell
python -B python/netprobe.py 'http://127.0.0.1:8765/download?demo=study#local' -n 2 --timeout 5
$LASTEXITCODE
```

1. `sys.exit(main())` вызывает парсер. `parse_target` отдаёт `Target(scheme="http", host="127.0.0.1", port=8765, request_path="/download?demo=study", display_url="http://127.0.0.1:8765/download?[redacted]")`. Параметры преобразуются в `2` и `5.0`.
2. `main` печатает безопасный адрес и вызывает `download` с новым `HTTPConnection`. Сокет использует блокирующий таймаут 5 секунд. Замер начинается перед GET, статус `200` разрешает чтение.
3. Сервер отдаёт `abc`. Чтение получает 3 байта и достигает EOF, остаток длины равен нулю. `finally` закрывает соединение. Второй GET проходит тот же путь после окончания первого.
4. Сводка показывает `Successes: 2; errors: 0` и `Total volume: 0.000006 MiB (6 bytes)`. Для условных длительностей 0.002 и 0.004 с среднее составит 3 ms, скорость около 0.001 MiB/s. Числа времени в реальном запуске меняются. Код выхода `0`.
5. Закройте учебный сервер комбинацией `Ctrl+C`. Для параллельного чтения главы об этой же программе используйте [разбор Node.js](learning-node.md).
