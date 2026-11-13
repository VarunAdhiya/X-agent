import { lookup } from 'node:dns';
import { Agent, fetch } from 'undici';
import ipaddr from 'ipaddr.js';
import { AgentError, canonicalUrl } from './domain.js';

export const isPublicAddress = address => {
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
};
// Check the exact resolved address used for the socket; preflight DNS alone is
// vulnerable to rebinding. Reject private/link-local/reserved/mapped addresses.
const dispatcher = new Agent({ connect: { lookup(hostname, options, callback) {
  lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || addresses.some(x => !isPublicAddress(x.address))) return callback(new AgentError('blocked_source_address'));
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
} } });

export async function request(url, { method = 'GET', headers = {}, body, timeout = 15000, maxBytes = 1000000, publicSource = false } = {}) {
  let current = url;
  const signal = AbortSignal.timeout(timeout);
  for (let redirect = 0; redirect < 4; redirect++) {
    if (publicSource) {
      canonicalUrl(current);
      const host = new URL(current).hostname.replace(/^\[|\]$/g, '');
      if (ipaddr.isValid(host) && !isPublicAddress(host)) throw new AgentError('blocked_source_address');
    }
    const response = await fetch(current, { method, headers: { 'User-Agent': 'PersonalContentAgent/1.0', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual',
      dispatcher: publicSource ? dispatcher : undefined, signal });
    if (response.status >= 300 && response.status < 400 && publicSource && method === 'GET') {
      await response.body?.cancel();
      current = new URL(response.headers.get('location'), current).href;
      continue;
    }
    const parts = []; let size = 0;
    for await (const part of response.body || []) {
      size += part.length;
      if (size > maxBytes) throw new AgentError('response_too_large');
      parts.push(Buffer.from(part));
    }
    return { status: response.status, headers: response.headers, text: Buffer.concat(parts).toString('utf8'), url: current };
  }
  throw new AgentError('too_many_redirects');
}
export async function safeGet(url) {
  let last;
  for (let i = 0; i < 2; i++) {
    try {
      const r = await request(url, { publicSource: true });
      if (r.status !== 200) throw new AgentError(`source_http_${r.status}`);
      return r;
    } catch (e) { last = e; }
  }
  throw last;
}
