import io
import threading
import unittest
from contextlib import contextmanager, redirect_stderr, redirect_stdout
from http import client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

import netprobe


def send_body(handler, body, *, length=None):
    handler.send_response(200)
    handler.send_header("Content-Length", str(len(body) if length is None else length))
    handler.end_headers()
    handler.wfile.write(body)


@contextmanager
def mock_server(*responders):
    paths = []
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self):
            with lock:
                index = len(paths)
                paths.append(self.path)
            if index < len(responders):
                responders[index](self)
            else:
                self.send_error(500)

        def log_message(self, *_):
            pass

    with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
        thread = threading.Thread(target=server.serve_forever, args=(0.01,))
        thread.start()
        try:
            yield f"http://127.0.0.1:{server.server_port}/download", paths
        finally:
            server.shutdown()
            thread.join()


def run_cli(*args):
    stdout, stderr = io.StringIO(), io.StringIO()
    with redirect_stdout(stdout), redirect_stderr(stderr):
        try:
            code = netprobe.main(list(args))
        except SystemExit as error:
            code = error.code
    return code, stdout.getvalue(), stderr.getvalue()


class NetProbeTests(unittest.TestCase):
    def test_statistics_for_fixed_length_and_chunked_bodies(self):
        fixed = b"x" * (1024 * 1024)

        def send_chunked(handler):
            handler.send_response(200)
            handler.send_header("Transfer-Encoding", "chunked")
            handler.send_header("Content-Length", "999")
            handler.end_headers()
            chunk = b"y" * (128 * 1024)
            for _ in range(4):
                handler.wfile.write(b"20000\r\n" + chunk + b"\r\n")
            handler.wfile.write(b"0\r\n\r\n")

        with mock_server(lambda h: send_body(h, fixed), send_chunked) as (url, paths):
            with patch.object(netprobe.time, "perf_counter", side_effect=[1, 1.25, 2, 2.75]):
                code, out, err = run_cli(url + "?token=hidden", "-n", "2")

        self.assertEqual(code, 0)
        self.assertEqual(err, "")
        self.assertEqual(paths, ["/download?token=hidden"] * 2)
        self.assertIn("?[redacted]", out)
        self.assertNotIn("hidden", out)
        self.assertIn("Successes: 2; errors: 0", out)
        self.assertIn("Average time: 500.000 ms", out)
        self.assertIn("Total volume: 1.500000 MiB (1572864 bytes)", out)
        self.assertIn("Throughput: 1.500 MiB/s", out)

    def test_rejects_bad_url_before_a_connection(self):
        for url in ("ftp://host/?hidden", "file:///somewhere", "http:///path?hidden",
                    "https://host:65536/?hidden", "https://user:password@host/?hidden"):
            with self.subTest(url=url), patch.object(netprobe, "download") as download:
                code, out, err = run_cli(url)
                download.assert_not_called()
                self.assertEqual(code, 2)
                self.assertIn("argument url:", err)
                self.assertNotIn("hidden", out + err)
                self.assertNotIn("password", out + err)

    def test_rejects_invalid_timeout_before_a_connection(self):
        for timeout in ("0", "-1", "nan", "inf"):
            with self.subTest(timeout=timeout), patch.object(netprobe, "download") as download:
                code, _, err = run_cli("http://localhost", "--timeout", timeout)
                download.assert_not_called()
                self.assertEqual(code, 2)
                self.assertIn("timeout must be finite and positive", err)

    def test_continues_after_http_error_and_hides_server_reason(self):
        def send_missing(handler):
            handler.send_error(404, handler.path)

        with mock_server(send_missing, lambda h: send_body(h, b"ok")) as (url, paths):
            code, out, err = run_cli(url + "?hidden", "-n", "2")

        self.assertEqual(code, 0)
        self.assertEqual(len(paths), 2)
        self.assertEqual(err, "Attempt 1: HTTP 404\n")
        self.assertNotIn("hidden", out + err)
        self.assertIn("Successes: 1; errors: 1", out)
        self.assertIn("(2 bytes)", out)

    def test_all_errors_return_nonzero(self):
        def disconnect(handler):
            handler.close_connection = True

        with mock_server(lambda h: h.send_error(500), disconnect) as (url, paths):
            code, out, err = run_cli(url, "-n", "2")

        self.assertEqual(code, 1)
        self.assertEqual(len(paths), 2)
        self.assertIn("Attempt 1: HTTP 500", err)
        self.assertIn("Attempt 2: RemoteDisconnected", err)
        self.assertIn("Successes: 0; errors: 2", out)
        self.assertIn("Total volume: 0.000000 MiB (0 bytes)", out)
        self.assertIn("Throughput: n/a MiB/s", out)

    def test_timeout_and_truncated_body_do_not_contribute(self):
        release = threading.Event()

        def stall(handler):
            send_body(handler, b"partial", length=100)
            release.wait(5)

        with mock_server(stall, lambda h: send_body(h, b"short", length=100),
                         lambda h: send_body(h, b"ok")) as (url, paths):
            try:
                code, out, err = run_cli(url, "-n", "3", "-t", "0.25")
            finally:
                release.set()

        self.assertEqual(code, 0)
        self.assertEqual(len(paths), 3)
        self.assertIn("Attempt 1: timeout", err)
        self.assertIn("Attempt 2: incomplete response body", err)
        self.assertIn("Successes: 1; errors: 2", out)
        self.assertIn("(2 bytes)", out)

    def test_default_ten_requests_start_after_previous_eof(self):
        events = []
        original_request = client.HTTPConnection.request
        original_read = client.HTTPResponse.read

        def observe_request(connection, *args, **kwargs):
            events.append("GET")
            return original_request(connection, *args, **kwargs)

        def observe_read(response, size):
            chunk = original_read(response, size)
            if not chunk:
                events.append("EOF")
            return chunk

        def close_delimited(handler):
            handler.send_response(200)
            handler.send_header("Connection", "close")
            handler.end_headers()
            handler.wfile.write(b"abc")

        with mock_server(*([close_delimited] * 10)) as (url, paths):
            with patch.object(client.HTTPConnection, "request", observe_request):
                with patch.object(client.HTTPResponse, "read", observe_read):
                    code, out, err = run_cli(url)

        self.assertEqual(code, 0)
        self.assertEqual(err, "")
        self.assertEqual(len(paths), 10)
        self.assertEqual(events, ["GET", "EOF"] * 10)
        self.assertIn("Successes: 10; errors: 0", out)
        self.assertIn("(30 bytes)", out)


if __name__ == "__main__":
    unittest.main()
