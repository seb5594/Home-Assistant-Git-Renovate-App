// The one HTTP client the providers share: timeouts, JSON, pagination and errors that say what to do.
import { AppError } from '../util/errors.mjs';

const TLS_CODES = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);
const UNREACHABLE_CODES = new Set(['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']);

export class ProviderError extends AppError {
  constructor(code, message, upstreamStatus = undefined) {
    super(502, code, message);
    this.name = 'ProviderError';
    this.upstreamStatus = upstreamStatus;
  }
}

function describeFailure(error, url) {
  const host = new URL(url).host;
  const code = error?.cause?.code ?? error?.code;
  if (TLS_CODES.has(code)) {
    return new ProviderError('provider_tls', `The certificate of ${host} is not trusted (${code}). Add its CA certificate in the app configuration.`);
  }
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return new ProviderError('provider_unreachable', `${host} did not answer in time.`);
  }
  if (UNREACHABLE_CODES.has(code)) {
    return new ProviderError('provider_unreachable', `${host} cannot be reached (${code}). Check the address and that the server is running.`);
  }
  return new ProviderError('provider_unreachable', `The request to ${host} failed: ${error?.message ?? error}`);
}

function describeStatus(status, host, detail) {
  const suffix = detail ? ` (${detail})` : '';
  if (status === 401) return new ProviderError('provider_unauthorized', `${host} rejected the token${suffix}.`, status);
  if (status === 403) return new ProviderError('provider_forbidden', `${host} denied access${suffix}. The token may lack permissions.`, status);
  if (status === 404) return new ProviderError('provider_not_found', `${host} answered "not found"${suffix}. Check the address.`, status);
  if (status === 429) return new ProviderError('provider_rate_limited', `${host} is rate limiting requests${suffix}.`, status);
  return new ProviderError('provider_error', `${host} answered with status ${status}${suffix}.`, status);
}

/**
 * @param {string} url
 * @param {{method?:string, headers?:Record<string,string>, body?:unknown, form?:Record<string,string>,
 *          timeout?:number, fetch?:typeof fetch, accept?:number[]}} options
 * @returns {Promise<{status:number, headers:Headers, data:any}>}
 */
export async function requestJson(url, { method = 'GET', headers = {}, body, form, timeout = 15_000, fetch: fetcher = fetch, accept = [] } = {}) {
  const init = { method, headers: { Accept: 'application/json', 'User-Agent': 'renovate-home-assistant-app', ...headers }, signal: AbortSignal.timeout(timeout) };
  if (form) {
    init.body = new URLSearchParams(form);
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  let response;
  try {
    response = await fetcher(url, init);
  } catch (error) {
    throw describeFailure(error, url);
  }
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!response.ok && !accept.includes(response.status)) {
    const detail = typeof data === 'object' && data ? (data.message ?? data.error_description ?? data.error) : undefined;
    throw describeStatus(response.status, new URL(url).host, typeof detail === 'string' ? detail.slice(0, 200) : undefined);
  }
  return { status: response.status, headers: response.headers, data };
}

const LINK_NEXT = /<([^>]+)>;\s*rel="next"/;

/** Follows `Link: <...>; rel="next"` (GitHub, Gitea, GitLab) or GitLab's x-next-page until the end. */
export async function* paginate(firstUrl, options = {}, { maxPages = 200 } = {}) {
  let url = firstUrl;
  for (let page = 0; url && page < maxPages; page += 1) {
    const { data, headers } = await requestJson(url, options);
    if (!Array.isArray(data)) throw new ProviderError('provider_error', 'The server returned something other than a list.');
    yield* data;
    const link = LINK_NEXT.exec(headers.get('link') ?? '');
    const nextPage = headers.get('x-next-page');
    if (link) {
      url = link[1];
    } else if (nextPage) {
      const next = new URL(url);
      next.searchParams.set('page', nextPage);
      url = next.href;
    } else {
      url = null;
    }
  }
}

/**
 * Splits an address the user typed into origin, host and path (without a trailing slash; empty for the root).
 * A missing scheme means https.
 * @returns {{origin:string, host:string, path:string}}
 */
export function parseBaseUrl(input) {
  let url;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    throw new AppError(400, 'invalid_address', `"${input}" is not a valid address`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError(400, 'invalid_address', 'The address must start with http:// or https://');
  }
  return { origin: url.origin, host: url.host, path: url.pathname.replace(/\/+$/, '') };
}
