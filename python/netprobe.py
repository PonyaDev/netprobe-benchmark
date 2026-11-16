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

    print(f"Successes: {successes}; errors: {args.requests - successes}")
    average_ms = f"{total_seconds * 1000 / successes:.3f}" if successes else "n/a"
    total_mib = total_bytes / MIB
    # Divide the totals so each sample contributes in proportion to its duration.
    rate = f"{total_mib / total_seconds:.3f}" if total_seconds > 0 else "n/a"
    print(f"Average time: {average_ms} ms")
    print(f"Total volume: {total_mib:.6f} MiB ({total_bytes} bytes)")
    print(f"Throughput: {rate} MiB/s")
    return 0 if successes else 1


if __name__ == "__main__":
    sys.exit(main())
