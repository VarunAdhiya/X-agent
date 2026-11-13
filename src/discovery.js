import { XMLParser } from 'fast-xml-parser';
import { safeGet } from './http.js';
import { canonicalUrl, hash, similarity, humanCategories, AgentError, diverseCandidates } from './domain.js';

const parser = new XMLParser({ ignoreAttributes: false, processEntities: false, htmlEntities: false });
const array = x => x == null ? [] : Array.isArray(x) ? x : [x];
export const plainText = value => String(value || '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' ')
  .replace(/&(?:nbsp|amp|lt|gt|quot);/g, ' ').replace(/\s+/g, ' ').trim();
export function normalize(raw, now = new Date()) {
  const title = plainText(raw.title).slice(0, 500);
  if (title.length < 3) return null;
  let url = null;
  if (raw.source_url) { try { url = canonicalUrl(raw.source_url); } catch { return null; } }
  const evergreen = raw.source === 'evergreen';
  const date = new Date(raw.published_at);
  if (!evergreen && (!Number.isFinite(date.getTime()) || now - date > 72 * 3600000 || date - now > 3600000 || !url)) return null;
  const age = evergreen ? 36 : Math.max(0, (now - date) / 3600000);
  return { title, category: raw.category, source: raw.source, source_url: url,
    fingerprint: hash(title), published_at: evergreen ? null : date.toISOString(),
    relevance_score: 0.30 * (1 - Math.min(age / 72, 1)) + 0.30 * (raw.credibility || 0.5)
      + 0.20 * Math.min(Math.log1p(raw.engagement || 0) / 8, 1) + 0.20 * (evergreen ? 0.8 : 0.6),
    evidence: { text: '', type: evergreen ? 'editorial_prompt_not_research' : 'unverified', fetched_at: null } };
}
export function parseFeed(xml, source) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new AgentError('unsafe_xml');
  const doc = parser.parse(xml);
  return array(doc.rss?.channel?.item || doc.feed?.entry).slice(0, 25).map(item => ({
    title: item.title?.['#text'] || item.title, source: new URL(source.url).hostname,
    source_url: typeof item.link === 'string' ? item.link : array(item.link).find(x => !x['@_rel'] || x['@_rel'] === 'alternate')?.['@_href'],
    published_at: item.pubDate || item.published || item.updated,
    category: source.category, credibility: source.credibility
  }));
}
export function shortlist(candidates, context) {
  const used = new Set(context.recent.map(x => x.topic_id));
  const old = context.topics.filter(x => used.has(x.id));
  const kept = [];
  for (const c of candidates.sort((a, b) => b.relevance_score - a.relevance_score)) {
    if ([...old, ...kept].some(t => t.fingerprint === c.fingerprint || (c.source_url && t.source_url === c.source_url) || similarity(t.title, c.title) > 0.72)) continue;
    kept.push(c);
  }
  return kept;
}
export async function discover(config, db, get = safeGet, now = new Date()) {
  const context = await db.command('context');
  if (context.settings.paused || !context.settings.generation_enabled) return { skipped: true };
  const sources = config.sources.feeds.map(source => async () => parseFeed((await get(source.url)).text, source));
  sources.unshift(async () => {
    const ids = JSON.parse((await get('https://hacker-news.firebaseio.com/v0/topstories.json')).text).slice(0, 12);
    const items = [];
    for (let i = 0; i < ids.length; i += 4) {
      const results = await Promise.allSettled(ids.slice(i, i + 4).map(async id => {
        const x = JSON.parse((await get(`https://hacker-news.firebaseio.com/v0/item/${id}.json`)).text);
        if (!x || x.deleted || x.dead || !x.url) return null;
        if (!/\b(ai|llm|model|agent|software|code|coding|compiler|programming|developer|engineering|computer|linux|database|startup|founder|funding|technology|robot|career|psychology)\b/i.test(x.title)) return null;
        const category = /\b(ai|llm|model|agent)\b/i.test(x.title) ? 'ai' : /startup|founder|funding/i.test(x.title) ? 'startups' : 'engineering';
        return { title: x.title, source: 'Hacker News', source_url: x.url, published_at: new Date(x.time * 1000).toISOString(),
          category, engagement: x.score, credibility: 0.6 };
      }));
      items.push(...results.filter(x => x.status === 'fulfilled').map(x => x.value).filter(Boolean));
    }
    return items;
  });
  const results = await Promise.allSettled(sources.map(fn => fn()));
  for (const [i, r] of results.entries()) if (r.status === 'rejected') await db.command('log', {
    workflow: 'discovery', event: 'source_failed', status: 'error', message: `Source ${i} unavailable; continuing with other sources`,
    key: `source:${context.day}:${i}`, alert: true
  });
  const raw = results.filter(x => x.status === 'fulfilled').flatMap(x => x.value);
  raw.push(...config.sources.evergreen.map(x => ({ ...x, source: 'evergreen', credibility: 0.7 })));
  const candidates = shortlist(raw.map(x => normalize(x, now)).filter(Boolean), context);
  const chosen = [...diverseCandidates(candidates.filter(x => !humanCategories.has(x.category))),
    ...diverseCandidates(candidates.filter(x => humanCategories.has(x.category)))];
  const researched = [];
  const research = async c => {
    if (c.source === 'evergreen') return c;
    try {
      const article = await get(c.source_url);
      const text = plainText(article.text).slice(0, 6000);
      // Reject aggregator shells and unreadable/paywalled excerpts rather than invent research.
      if (text.length < 200 || new URL(article.url || c.source_url).hostname === 'news.google.com') return null;
      c.evidence = { url: article.url || c.source_url, text, type: 'source_excerpt', fetched_at: now.toISOString() };
      return c;
    } catch { /* A source that cannot be read is not eligible for factual drafting. */ }
    return null;
  };
  for (let i = 0; i < chosen.length; i += 4) {
    researched.push(...(await Promise.all(chosen.slice(i, i + 4).map(research))).filter(Boolean));
  }
  if (researched.filter(x => !humanCategories.has(x.category)).length < 2 || researched.filter(x => humanCategories.has(x.category)).length < 2) throw new AgentError('insufficient_researched_topics');
  await db.command('topics', { topics: researched });
  return { discovered: researched.length, source_failures: results.filter(x => x.status === 'rejected').length };
}
