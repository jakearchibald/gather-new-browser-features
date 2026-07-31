/**
 * A proxy-aware `fetch`.
 *
 * Why this exists: Node's built-in `fetch` ignores HTTP_PROXY/HTTPS_PROXY. Every
 * other tool an environment configures — curl, git, gcloud, rsync — honours them,
 * so a proxy-only network is invisible until you try Node, and then every hostname
 * fails with `ENOTFOUND`, which reads like broken DNS rather than a missing proxy.
 * (Node 24 added NODE_USE_ENV_PROXY; on 18–22 there is nothing built in.)
 *
 * That matters beyond any one sandbox: a corporate proxy breaks these scripts the
 * same way.
 *
 * This was briefly a hand-rolled CONNECT tunnel with its own gzip and redirect
 * handling, to keep the repo dependency-free. It cost two bugs in one sitting,
 * both of which failed *misleadingly*: `.pipe()` instead of `pipeline()` made the
 * process exit 0 with no output and no error, and an `agent: false` that looked
 * harmless turned into `ENOTFOUND`. Reimplementing a proxy client is not worth
 * that, so it now uses undici's ProxyAgent — which is what Node's own fetch is
 * built on, just with the proxy support Node doesn't expose.
 *
 * The returned value is a real `Response`, so callers get exactly the semantics
 * they would get from global `fetch`, including a web `ReadableStream` body.
 */

const { fetch: undiciFetch, ProxyAgent, Agent } = require('undici');

// These bodies are ~330MB. undici's defaults would time out a transfer that big
// on a slow link, so the limits are raised rather than left to bite unpredictably.
const TIMEOUTS = { headersTimeout: 60_000, bodyTimeout: 300_000 };

/** Does NO_PROXY exempt this host? */
function bypassed(hostname) {
  const raw = process.env.NO_PROXY || process.env.no_proxy || '';
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .some((entry) => entry === hostname || (entry.startsWith('.') && hostname.endsWith(entry)));
}

function proxyUrlFor(target) {
  if (bypassed(target.hostname.toLowerCase())) return null;
  const env =
    target.protocol === 'https:'
      ? process.env.HTTPS_PROXY || process.env.https_proxy
      : process.env.HTTP_PROXY || process.env.http_proxy;
  if (!env) return null;
  try {
    return new URL(env);
  } catch {
    return null;
  }
}

// One dispatcher per proxy, reused across calls: building a fresh agent per
// request would open a new connection pool every time.
const dispatchers = new Map();

function dispatcherFor(target) {
  const proxy = proxyUrlFor(target);
  const key = proxy ? proxy.toString() : '';
  if (!dispatchers.has(key)) {
    if (!proxy) {
      dispatchers.set(key, new Agent(TIMEOUTS));
    } else {
      // Credentials live in the URL's userinfo; ProxyAgent wants them as a header.
      const token = proxy.username
        ? Buffer.from(
            `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password || '')}`,
          ).toString('base64')
        : null;
      dispatchers.set(
        key,
        new ProxyAgent({
          uri: `${proxy.protocol}//${proxy.host}`,
          ...(token ? { token: `Basic ${token}` } : {}),
          ...TIMEOUTS,
        }),
      );
    }
  }
  return dispatchers.get(key);
}

/** GET a URL, through a proxy when one is configured. Drop-in for `fetch(url)`. */
function netFetch(url) {
  return undiciFetch(url, { dispatcher: dispatcherFor(new URL(url)) });
}

module.exports = { netFetch };
