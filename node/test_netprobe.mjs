import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { main } from './netprobe.mjs';

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL('./netprobe.mjs', import.meta.url));

async function mockServer(t, ...responders) {
  const requests = [];
  const server = createServer((request, response) => {
    const respond = responders[requests.length];
    requests.push(`${request.method} ${request.url}`);
    if (respond) respond(response, request);
    else response.writeHead(500).end();
  });
  server.listen(0, '127.0.0.1');
  t.after(async () => {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closed;
  });
  await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}/download`, requests };
}

async function run(args, now) {
  const stdout = [];
  const stderr = [];
  const code = await main(args, {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    now,
  });
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

function fixed(body) {
  return (response) => {
    response.writeHead(200, { 'Content-Length': Buffer.byteLength(body) }).end(body);
  };
}

test('fixed-length and chunked responses produce aggregate statistics', async (t) => {
  const chunk = Buffer.alloc(128 * 1024, 'y');
  const { url, requests } = await mockServer(t, fixed(Buffer.alloc(1024 * 1024, 'x')),
    (response) => {
      response.writeHead(200, { 'Transfer-Encoding': 'chunked' });
      for (let i = 0; i < 4; i += 1) response.write(chunk);
      response.end();
    });
  const ticks = [100, 350, 500, 1250];
  const result = await run([`${url}?token=private%2fvalue`, '-n', '2'], () => ticks.shift());

  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(ticks, []);
  assert.deepEqual(requests, Array(2).fill('GET /download?token=private%2fvalue'));
  assert.match(result.stdout, /\?\[redacted\]/);
  assert.doesNotMatch(result.stdout, /token|private/);
  assert.match(result.stdout, /Successes: 2; errors: 0/);
  assert.match(result.stdout, /Average time: 500\.000 ms/);
  assert.match(result.stdout, /Total volume: 1\.500000 MiB \(1572864 bytes\)/);
  assert.match(result.stdout, /Throughput: 1\.500 MiB\/s/);
});

test('body bytes come from the stream and contradictory HTTP framing fails', async (t) => {
  const compressed = gzipSync(Buffer.alloc(4096, 'x'));
  const { url } = await mockServer(t,
    (response) => {
      response.writeHead(200, {
        'Content-Encoding': 'gzip', 'Content-Length': compressed.length,
      }).end(compressed);
    },
    (response) => {
      response.writeHead(200, { 'Transfer-Encoding': 'chunked', 'Content-Length': 999 });
      response.end('short');
    });
  const result = await run([url, '-n', '2']);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Successes: 1; errors: 1/);
  assert.match(result.stdout, /\(4096 bytes\)/);
  assert.equal(result.stderr, 'Attempt 2: network error');
});

test('invalid URLs, options and timeout never reach fetch or expose input', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch');
  const url = 'http://127.0.0.1/download?token=private';
  const invalid = [
    ['ftp://127.0.0.1/?token=private'], ['http:///example.invalid/?token=private'],
    ['http://alice:password@127.0.0.1/?token=private'],
    ['http://127.0.0.1:65536/?token=private'], [`--unknown=${url}`], [url, '-n', '0'],
    ...['0', '-1', 'NaN', 'Infinity', '2147483.648'].map((x) => [url, `--timeout=${x}`]),
  ];
  for (const args of invalid) {
    const result = await run(args);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^Error: /);
    assert.doesNotMatch(result.stderr, /token|private|alice|password/);
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('manual redirect and 404 are errors and a later 2xx succeeds', async (t) => {
  const { url, requests } = await mockServer(t,
    (response) => response.writeHead(302, { Location: '/redirected?private' }).end(),
    (response, request) => response.writeHead(404, request.url).end('missing'),
    fixed('ok'));
  const result = await run([`${url}?private`, '-n', '3']);

  assert.equal(result.code, 0);
  assert.equal(result.stderr, 'Attempt 1: HTTP 302\nAttempt 2: HTTP 404');
  assert.match(result.stdout, /Successes: 1; errors: 2/);
  assert.match(result.stdout, /\(2 bytes\)/);
  assert.doesNotMatch(result.stdout + result.stderr, /private|redirected/);
  assert.deepEqual(requests, Array(3).fill('GET /download?private'));
});

test('HTTP 500 and disconnect before headers yield nonzero exit on zero successes', async (t) => {
  const { url, requests } = await mockServer(t,
    (response) => response.writeHead(500).end('failure'),
    (_response, request) => request.socket.destroy());
  const result = await run([url, '-n', '2']);

  assert.equal(result.code, 1);
  assert.equal(result.stderr, 'Attempt 1: HTTP 500\nAttempt 2: network error');
  assert.match(result.stdout, /Successes: 0; errors: 2/);
  assert.match(result.stdout, /Average time: n\/a ms/);
  assert.match(result.stdout, /Total volume: 0\.000000 MiB \(0 bytes\)/);
  assert.match(result.stdout, /Throughput: n\/a MiB\/s/);
  assert.equal(requests.length, 2);
});

test('whole-attempt timeout covers headers and body; truncated bytes are discarded', async (t) => {
  const { url, requests } = await mockServer(t,
    () => {},
    (response) => {
      response.writeHead(200).write('start');
      const interval = setInterval(() => response.write('more'), 30);
      response.once('close', () => clearInterval(interval));
    },
    (response, request) => {
      response.writeHead(200, { 'Content-Length': 100 });
      response.end('short', () => request.socket.end());
    },
    fixed('ok'));
  const result = await run([url, '-n', '4', '-t', '0.25']);

  assert.equal(result.code, 0);
  assert.equal(result.stderr,
    'Attempt 1: timeout\nAttempt 2: timeout\nAttempt 3: incomplete response body');
  assert.match(result.stdout, /Successes: 1; errors: 3/);
  assert.match(result.stdout, /\(2 bytes\)/);
  assert.equal(requests.length, 4);
});

test('ten default GETs each start after the previous body EOF', async (t) => {
  const { url, requests } = await mockServer(t, ...Array(10).fill(fixed('abc')));
  const events = [];
  const fetchImpl = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (...args) => {
    events.push('GET');
    const response = await fetchImpl(...args);
    const iterator = response.body[Symbol.asyncIterator].bind(response.body);
    response.body[Symbol.asyncIterator] = async function* () {
      yield* iterator();
      events.push('EOF');
    };
    return response;
  });
  const result = await run([url]);

  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(requests, Array(10).fill('GET /download'));
  assert.deepEqual(events, Array.from({ length: 20 }, (_, i) => i % 2 ? 'EOF' : 'GET'));
  assert.match(result.stdout, /Successes: 10; errors: 0/);
  assert.match(result.stdout, /\(30 bytes\)/);
});

test('CLI subprocess accepts an HTTP(S) URL and masks query in its output', async (t) => {
  const { url, requests } = await mockServer(t, fixed('smoke'));
  const result = await execFileAsync(process.execPath, [cliPath, `${url}?hidden`, '-n', '1'], {
    encoding: 'utf8', timeout: 10_000,
  });

  assert.equal(result.stderr, '');
  assert.match(result.stdout, /\?\[redacted\]/);
  assert.match(result.stdout, /Successes: 1; errors: 0/);
  assert.match(result.stdout, /\(5 bytes\)/);
  assert.doesNotMatch(result.stdout, /hidden/);
  assert.deepEqual(requests, ['GET /download?hidden']);
});
