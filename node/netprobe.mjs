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

  const requests = Number(values.requests);
  if (!/^\d+$/.test(values.requests) || !Number.isSafeInteger(requests) || requests < 1) {
    return { error: 'requests must be a positive integer' };
  }
  const timeoutMs = Math.ceil(Number(values.timeout) * 1000);
  if (!(timeoutMs > 0 && timeoutMs <= MAX_TIMEOUT_MS)) {
    return { error: 'timeout must be finite, positive and at most 2147483.647 seconds' };
  }

  url.hash = '';
  const query = url.href.includes('?') ? '?[redacted]' : '';
  const displayUrl = `${url.origin}${url.pathname}${query}`;
  return { url, displayUrl, requests, timeoutMs };
}

async function download(url, timeoutMs, now) {
  const signal = AbortSignal.timeout(timeoutMs);
  let response;
  try {
    const started = now();
    response = await fetch(url, { method: 'GET', redirect: 'manual', signal });
    if (!response.ok) return { failure: `HTTP ${response.status}` };

    let bytes = 0;
    if (response.body) {
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
      }
    }
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
  let successes = 0;
  let totalBytes = 0;
  let totalMs = 0;
  for (let attempt = 1; attempt <= requests; attempt += 1) {
    const result = await download(url, timeoutMs, now);
    if (result.failure) {
      stderr(`Attempt ${attempt}: ${result.failure}`);
      continue;
    }
    successes += 1;
    totalBytes += result.bytes;
    totalMs += result.elapsedMs;
  }

  const totalMiB = totalBytes / MIB;
  const average = successes ? (totalMs / successes).toFixed(3) : 'n/a';
  const throughput = totalMs > 0 ? (totalMiB / (totalMs / 1000)).toFixed(3) : 'n/a';
  stdout(`Successes: ${successes}; errors: ${requests - successes}`);
  stdout(`Average time: ${average} ms`);
  stdout(`Total volume: ${totalMiB.toFixed(6)} MiB (${totalBytes} bytes)`);
  stdout(`Throughput: ${throughput} MiB/s`);
  return successes ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await main(process.argv.slice(2));
}
