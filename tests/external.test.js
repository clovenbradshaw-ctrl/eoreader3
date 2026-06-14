/* ============================================================
   Tests for the external-knowledge stratum (external.js → window.EOExternal).

   external.js is a browser IIFE that also module.exports for Node. It holds no
   network of its own — fetch, the clock, and the persistence store are all
   injectable — so the whole policy surface (rate limiter, priority + budget,
   the two source normalizers, the freeze/replay cache, the private-individual
   gate) is exercised here with a deterministic fake fetch and an in-memory
   store. No network is touched.

   Run with `node tests/external.test.js`.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

/* ---- canned upstream payloads (the only "world" these tests see) ---- */
const WIKI = {
  'nashville downtown partnership': { title: 'Nashville Downtown Partnership', description: 'nonprofit organization in Nashville', extract: 'The Nashville Downtown Partnership is a nonprofit organization.', thumb: 'http://img/ndp.jpg', page: 'https://en.wikipedia.org/wiki/Nashville_Downtown_Partnership' },
  'metro council': { title: 'Metropolitan Council', description: 'local government legislative body', extract: 'The Metropolitan Council is the legislative body.', page: 'https://en.wikipedia.org/wiki/Metropolitan_Council' },
  socialism: { title: 'Socialism', description: 'range of economic and social systems', extract: 'Socialism is a political philosophy and movement.\n\nSocialist systems are divided into market and non-market forms. It has a long intellectual history.', thumb: 'http://img/soc.jpg', page: 'https://en.wikipedia.org/wiki/Socialism' },
};
const WIKT = {
  socialism: { Noun: ['Any of various <a href="/economic">economic</a> systems.', 'A transitional stage between capitalism and communism.'] },
};
const titleIndex = {};      // underscored title → entry (summary endpoint)
const byTitle = {};         // exact title → entry (extracts endpoint)
for (const k of Object.keys(WIKI)) { titleIndex[WIKI[k].title.replace(/ /g, '_')] = WIKI[k]; byTitle[WIKI[k].title] = WIKI[k]; }

function makeFetch(log) {
  return async function fakeFetch(full) {
    const inner = decodeURIComponent(String(full).split('?url=')[1] || '');
    const at = Date.now();
    const ok = (body) => ({ ok: true, status: 200, async text() { return JSON.stringify(body); } });
    const notfound = () => ({ ok: false, status: 404, async text() { return 'nope'; } });
    // Wikipedia search
    let m = /list=search/.test(inner) && /srsearch=([^&]+)/.exec(inner);
    if (m) {
      const term = decodeURIComponent(m[1]).toLowerCase();
      log.push({ at, kind: 'wiki-search', term });
      const hit = WIKI[term];
      const search = hit ? [{ title: hit.title, snippet: 'a <span class="searchmatch">match</span> here' }, { title: 'Other Thing', snippet: 'aside' }] : [];
      return ok({ query: { search } });
    }
    // Wikipedia full-text extracts (article())
    m = /prop=extracts/.test(inner) && /titles=([^&]+)/.exec(inner);
    if (m) {
      const title = decodeURIComponent(m[1]);
      log.push({ at, kind: 'wiki-extract', term: title });
      const e = byTitle[title];
      const pages = e
        ? { '1': { pageid: 1, title: e.title, extract: e.extract, description: e.description, thumbnail: e.thumb ? { source: e.thumb } : undefined } }
        : { '-1': { missing: '' } };
      return ok({ query: { pages } });
    }
    // Normalized /lookup endpoint (enrichTerm): top-level ?q=, not the ?url= proxy
    if (full.indexOf('?url=') === -1 && /[?&]q=/.test(full)) {
      const lm = /[?&]q=([^&]+)/.exec(full);
      const term = decodeURIComponent(lm[1]).toLowerCase();
      log.push({ at, kind: 'lookup', term });
      const e = WIKI[term];
      const d = WIKT[term];
      const encyclopedia = e
        ? { title: e.title, kind: 'standard', description: e.description, summary: e.extract, url: e.page, thumbnail: e.thumb || null, also_see: [] }
        : { title: null, kind: 'not_found' };
      const dictionary = d
        ? { word: term, found: true, senses: Object.keys(d).map(pos => ({ part_of_speech: pos.toLowerCase(), definitions: d[pos].map(x => x.replace(/<[^>]+>/g, '')) })) }
        : { word: term, found: false, senses: [] };
      return ok({ query: term, found: encyclopedia.kind === 'standard' || dictionary.found, encyclopedia, dictionary, sources: [] });
    }
    // Wikipedia summary
    m = /\/page\/summary\/(.+)$/.exec(inner);
    if (m) {
      const titleKey = decodeURIComponent(m[1]);
      log.push({ at, kind: 'wiki-summary', term: titleKey });
      const e = titleIndex[titleKey];
      if (!e) return notfound();
      return ok({ title: e.title, description: e.description, extract: e.extract, thumbnail: e.thumb ? { source: e.thumb } : undefined, content_urls: { desktop: { page: e.page } } });
    }
    // Wiktionary definition
    m = /\/page\/definition\/(.+)$/.exec(inner);
    if (m) {
      const word = decodeURIComponent(m[1]).toLowerCase().replace(/_/g, ' ');
      log.push({ at, kind: 'wikt-def', term: word });
      const e = WIKT[word];
      if (!e) return notfound();
      const out = {};
      out.en = Object.keys(e).map(pos => ({ partOfSpeech: pos, language: 'English', definitions: e[pos].map(def => ({ definition: def, examples: [] })) }));
      return ok(out);
    }
    return notfound();
  };
}

function loadExternal(fetchLog) {
  const kv = {};
  const store = { kvGet: async (k) => kv[k], kvPut: async (k, v) => { kv[k] = v; return true; } };
  let ls = {};
  const localStorage = { getItem: (k) => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = String(v); }, removeItem: (k) => { delete ls[k]; } };
  const sandbox = { window: {}, console, module: { exports: {} }, setTimeout, clearTimeout, localStorage, Date, JSON, Math };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'external.js'), 'utf8'), sandbox, { filename: 'external.js' });
  const X = sandbox.window.EOExternal;
  if (!X) throw new Error('external.js did not publish window.EOExternal');
  X.setConfig({ proxy: 'http://proxy.test/feed', fetchImpl: makeFetch(fetchLog), store, intervalMs: 5, maxRetries: 1, budget: 12 });
  return X;
}

/* ---- tiny assert harness (matches the other test files) ---- */
let pass = 0, fail = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function group(name, fn) { console.log('• ' + name); return fn(); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async function main() {
  const log = [];
  const X = loadExternal(log);
  const I = X._internals;

  await group('config + disabled', async () => {
    eq(X.enabled(), true, 'enabled with a proxy + fetch');
    X.setConfig({ proxy: '' });
    eq(X.enabled(), false, 'disabled when the proxy is cleared');
    const r = await X.lookup('wikipedia', 'Anything');
    eq(r.status, 'disabled', 'a cleared proxy yields status disabled, not a guess');
    X.setConfig({ proxy: 'http://proxy.test/feed' }); // restore
  });

  group('normalizers (pure, no network)', () => {
    eq(I.guessType('nonprofit organization in Nashville'), 'org', 'description → org');
    eq(I.guessType('city in Tennessee'), 'place', 'description → place');
    eq(I.guessType('American politician and author'), 'person', 'description → person');
    eq(I.guessType('a small abstract idea'), null, 'no cue → null (conservative)');
    eq(I.stripTags('a <b>b</b> &amp; <i>c</i>'), 'a b & c', 'stripTags drops markup and decodes entities');
    const w = I.normalizeWiktionary({ en: [{ partOfSpeech: 'Noun', definitions: [{ definition: 'An <a href="/x">economic</a> system.', examples: ['used in a sentence'] }] }] });
    eq(w.entries.length, 1, 'wiktionary: one part-of-speech group');
    eq(w.entries[0].partOfSpeech, 'Noun', 'wiktionary: partOfSpeech carried');
    ok(!/[<>]/.test(w.entries[0].definitions[0].definition), 'wiktionary: definition stripped of tags');
    const wk = I.normalizeWiki({ title: 'X Partnership', description: 'nonprofit organization', extract: 'e', content_urls: { desktop: { page: 'http://p' } } }, [{ title: 'X Partnership' }, { title: 'Y', snippet: 's' }]);
    eq(wk.typeGuess, 'org', 'wiki: typeGuess from description');
    eq(wk.others.length, 1, 'wiki: other matches carried (minus the chosen title)');
  });

  await group('lookup + freeze / replay / abstain', async () => {
    log.length = 0;
    const a = await X.lookup('wikipedia', 'Nashville Downtown Partnership');
    eq(a.status, 'hit', 'wikipedia hit');
    eq(a.payload.title, 'Nashville Downtown Partnership', 'hit carries the title');
    eq(a.basis.src, 'wikipedia', 'basis stamped with source');
    ok(/^cyrb53:/.test(a.basis.hash), 'basis carries a content hash');
    const reqAfterFirst = log.length;
    ok(reqAfterFirst >= 2, 'a wikipedia hit is two upstream requests (search + summary)');
    const b = await X.lookup('wikipedia', 'Nashville Downtown Partnership');
    eq(b.status, 'hit', 'second lookup also a hit');
    eq(b.cached, true, 'second lookup served from the freeze');
    eq(log.length, reqAfterFirst, 'a frozen term pays no further network');

    const miss = await X.lookup('wikipedia', 'Nonexistent Subject Xyzzy');
    eq(miss.status, 'miss', 'no search hits → miss (reached, nothing found), never fabricated');

    log.length = 0;
    const pend = await X.lookup('wiktionary', 'freshunseenword', { replayOnly: true });
    eq(pend.status, 'pending', 'replayOnly + uncached → pending (abstain)');
    eq(log.length, 0, 'replayOnly pays no network');
  });

  await group('private-individual gate', async () => {
    log.length = 0;
    const g = await X.lookup('wikipedia', 'Mrs. Mill');
    eq(g.status, 'gated', 'a courtesy-title person is gated from the world tier');
    eq(log.length, 0, 'a gated lookup makes no request');
    const lex = await X.lookup('wiktionary', 'Mrs. Mill');
    ok(lex.status !== 'gated', 'the language tier (Wiktionary) is not gated — a name there is harmless');
  });

  group('classifyNeeds — seriousness ranking', () => {
    const entities = [
      { name: 'Nashville Downtown Partnership', type: 'place', mass: 9, key: 'ndp' },
      { name: 'Socialism', type: 'thing', mass: 2, key: 'soc' },
      { name: 'Metro Council', type: 'place', mass: 5, key: 'mc' },
      { name: 'Poland', type: 'place', mass: 3, key: 'pol' },
      { name: 'Tom Turner', type: 'person', mass: 4, key: 'tt' },
      { name: 'Mrs. Mill', type: 'person', mass: 2, key: 'mm' },
      { name: 'Departments Should Not Be', type: 'thing', mass: 1, key: 'noise' },
    ];
    const needs = X.classifyNeeds(entities);
    const terms = needs.map(n => n.term);
    ok(needs.every(n => !n.gated), 'no gated need in the default set');
    ok(!terms.includes('Poland'), 'single-word place excluded (assumed correct)');
    ok(!terms.includes('Tom Turner'), 'an already-person is not a residual');
    ok(!terms.includes('Mrs. Mill'), 'private individual excluded by default');
    ok(!terms.includes('Departments Should Not Be'), 'heading/TOC noise excluded');
    eq(needs[0].term, 'Nashville Downtown Partnership', 'heaviest org is the most serious need');
    const soc = needs.find(n => n.term === 'Socialism');
    ok(soc && soc.source === 'wiktionary' && soc.kind === 'abstract-kind', 'abstract noun → safe language tier');
    const ndp = needs.find(n => n.term === 'Nashville Downtown Partnership');
    ok(ndp && ndp.source === 'wikipedia' && ndp.kind === 'org-or-law', 'proper referent → world tier');
    const withGated = X.classifyNeeds(entities, { includeGated: true });
    ok(withGated.some(n => n.term === 'Mrs. Mill' && n.gated), 'includeGated surfaces the gated need, marked');
  });

  await group('resolveNeeds — budget spends on the worst holes first', async () => {
    log.length = 0;
    const entities = [
      { name: 'Nashville Downtown Partnership', type: 'place', mass: 9, key: 'ndp' },
      { name: 'Metro Council', type: 'place', mass: 5, key: 'mc' },
      { name: 'Socialism', type: 'thing', mass: 2, key: 'soc' },
    ];
    const needs = X.classifyNeeds(entities);
    eq(needs.length, 3, 'three real needs');
    const results = await X.resolveNeeds(needs, { budget: 2 });
    eq(results.size, 3, 'every need gets a result row');
    eq(results.get('soc').status, 'skipped', 'the lowest-severity need is skipped under budget');
    eq(results.get('soc').reason, 'budget', 'skip reason is budget');
    ok(['hit', 'miss'].includes(results.get('ndp').status), 'the heaviest need was actually fetched');
    ok(['hit', 'miss'].includes(results.get('mc').status), 'the second need was actually fetched');
    const askedSoc = log.some(e => e.kind === 'wikt-def' && e.term === 'socialism');
    ok(!askedSoc, 'the skipped need never touched the network');
  });

  await group('article() — full text for ingestion (chat with Wikipedia)', async () => {
    log.length = 0;
    const a = await X.article('socialism');
    eq(a.status, 'hit', 'article hit');
    eq(a.payload.title, 'Socialism', 'resolved title');
    ok(/political philosophy/.test(a.payload.text), 'full extract text carried');
    ok(a.payload.text.indexOf('intellectual history') !== -1, 'text is the whole article, not just the lead');
    ok(a.payload.intro && a.payload.intro.length < a.payload.text.length, 'a short intro is derived for the card');
    eq(a.basis.src, 'article', 'basis stamped src=article');
    const reqs = log.length;
    ok(reqs >= 2, 'article is search + extract (two requests)');
    const b = await X.article('socialism');
    eq(b.cached, true, 'second article served from the freeze');
    eq(log.length, reqs, 'a frozen article pays no network');
    const miss = await X.article('Nonexistent Subject Xyzzy');
    eq(miss.status, 'miss', 'no search hit → miss, never fabricated');
    const g = await X.article('Mrs. Mill');
    eq(g.status, 'gated', 'article honours the private-individual gate');
  });

  await group('searchOptions() — the lightweight options step (offer, do not fetch)', async () => {
    log.length = 0;
    const r = await X.searchOptions('socialism');
    eq(r.status, 'hit', 'options hit');
    ok(Array.isArray(r.options) && r.options.length >= 1, 'options carried as a list');
    eq(r.options[0].title, 'Socialism', 'top option is the matching title');
    ok(r.options.some(o => o.title === 'Other Thing'), 'sibling candidates carried too (a real choice)');
    ok(!/[<>]/.test(r.options[0].snippet || ''), 'option snippet stripped of markup');
    eq(r.basis.src, 'search', 'basis stamped src=search');
    eq(log.filter(e => e.kind === 'wiki-search').length, 1, 'exactly one search request');
    eq(log.filter(e => e.kind === 'wiki-extract').length, 0, 'no article extract fetched at the options step');
    const miss = await X.searchOptions('Nonexistent Subject Xyzzy');
    eq(miss.status, 'miss', 'no hits → miss, never fabricated');
    const g = await X.searchOptions('Mrs. Mill');
    eq(g.status, 'gated', 'options honour the private-individual gate');
    X.setConfig({ proxy: '' });
    eq((await X.searchOptions('socialism')).status, 'disabled', 'no proxy → disabled, not a guess');
    X.setConfig({ proxy: 'http://proxy.test/feed' });
  });

  await group('enrichTerm() — the normalized /lookup card', async () => {
    log.length = 0;
    const r = await X.enrichTerm('socialism');
    eq(r.status, 'hit', 'lookup hit');
    ok(r.payload.encyclopedia && r.payload.encyclopedia.title === 'Socialism', 'encyclopedia carried');
    ok(r.payload.dictionary && r.payload.dictionary.found, 'dictionary carried');
    eq(log.filter(e => e.kind === 'lookup').length, 1, 'one normalized server-side call');
  });

  group('pickQuery() — the salient term from a chat message', () => {
    eq(X.pickQuery('Who is David Corman?'), 'David Corman', 'name after a wh-question');
    eq(X.pickQuery('what is socialism?'), 'socialism', 'lowercase topic after a wh-question');
    eq(X.pickQuery('Tell me about the Nashville Downtown Partnership'), 'Nashville Downtown Partnership', 'capitalized run after a lead-in');
    eq(X.pickQuery('"quantum entanglement" explained'), 'quantum entanglement', 'a quoted phrase wins');
    // a leading acquisition frame is stripped so the stab is the subject
    eq(X.pickQuery('search for dogs'), 'dogs', 'strips "search for" → the bare subject');
    eq(X.pickQuery('look up Howard Shore'), 'Howard Shore', 'strips "look up" before the name');
    eq(X.pickQuery('find the article on socialism'), 'socialism', 'strips "find the article on"');
    eq(X.pickQuery('google quantum computing'), 'quantum computing', 'strips "google"');
    // "research <X>" — research is a lookup verb, stripped to the subject; a BARE
    // "research" (no subject) stays the common noun (seedQuery anchors it).
    eq(X.pickQuery('research Vincent Cassel'), 'Vincent Cassel', 'strips "research" before a name');
    eq(X.pickQuery('research on socialism'), 'socialism', 'strips "research on" → the subject');
    eq(X.pickQuery('research'), 'research', 'bare "research" (no subject) stays the common noun');
    // a bare "wikipedia for/on/about X" frame reduces to the subject (the search
    // term used to keep the word "wikipedia" and search "wikipedia for dolphins")
    eq(X.pickQuery('search wikipedia for dolphins'), 'dolphins', 'strips "search wikipedia for" → the subject');
    eq(X.pickQuery('pull up wikipedia on the French Revolution'), 'French Revolution', 'strips "wikipedia on" before the subject');
    // a residual conversational frame the question-word run leaves behind
    eq(X.pickQuery('what do you know about dolphins?'), 'dolphins', 'strips "what do you know about" → the subject');
    eq(X.pickQuery(''), null, 'empty → null');
  });

  group('acquireIntent() — only an explicit acquisition reaches the fetcher', () => {
    // explicit lookup verbs / acquisition frames acquire
    ok(X.acquireIntent('look up howard shore'), 'a lookup verb is acquisition');
    ok(X.acquireIntent('find the article on socialism'), 'an acquisition frame is acquisition');
    ok(X.acquireIntent('search for David Cronenberg'), 'search is acquisition');
    ok(X.acquireIntent('pull up the Wikipedia page for Toronto'), 'pull up / wikipedia is acquisition');
    // "research <X>" is a lookup verb (the reported "research Vincent Cassel")
    ok(X.acquireIntent('research Vincent Cassel'), '"research <ProperName>" is acquisition');
    ok(X.acquireIntent('research on socialism'), '"research on <topic>" is acquisition');
    ok(X.acquireIntent('do some research about the French Revolution'), '"do some research about <X>" is acquisition');
    // but the NOUN sense of "research" must NOT trip the desk
    ok(!X.acquireIntent('research'), 'a bare "research" with no subject is not acquisition');
    ok(!X.acquireIntent('the research shows that vaccines work'), '"research" as a noun is not acquisition');
    // who/what/tell-me frames acquire only with a proper-name target
    ok(X.acquireIntent('who is Howard Shore'), '"who is <ProperName>" is acquisition');
    ok(X.acquireIntent('tell me about Noah Kahan'), '"tell me about <ProperName>" is acquisition');
    // bare factual / follow-up turns are NOT acquisition (the turn-3 bug)
    ok(!X.acquireIntent('what are his inspirations?'), 'a pronoun follow-up is factual, not acquisition');
    ok(!X.acquireIntent('when was he born?'), 'a bare factual question is not acquisition');
    ok(!X.acquireIntent('who is the funniest character'), '"who is the <common noun>" is not acquisition');
    ok(!X.acquireIntent('what is the craziest stuff in there?'), 'no proper-name target ⇒ not acquisition');
    ok(!X.acquireIntent('summarize this'), 'a summary ask is not acquisition');
    ok(!X.acquireIntent('tell me more'), 'a vague follow-up is not acquisition');
  });

  group('isSpecificQuery() — can the term stand on its own?', () => {
    ok(X.isSpecificQuery('Skydio'), 'a Capitalized proper-noun-like token is specific');
    ok(X.isSpecificQuery('French Revolution'), 'a multi-word topic is specific');
    ok(!X.isSpecificQuery('research'), 'a bare lowercase common noun is not');
    ok(!X.isSpecificQuery('DFR'), 'a lone ALL-CAPS acronym is not');
    ok(!X.isSpecificQuery(''), 'empty is not');
  });

  group('seedQuery() — anchor a contextless forced query to the reader’s subject', () => {
    const ctx = { subject: 'Skydio', entities: ['Skydio', 'MNPD', 'surveillance'] };
    // the reported gap: a forced bare common noun ("research") searched its own
    // token → disambiguation soup. Anchor it to the active subject instead.
    eq(X.seedQuery('research', ctx), 'Skydio research', 'a bare common noun is anchored to the active subject');
    eq(X.seedQuery('DFR', ctx), 'Skydio DFR', 'a lone acronym is anchored too');
    // an EXPLICIT acquisition names its own target — pass it through untouched
    eq(X.seedQuery('search wikipedia for dolphins', ctx), 'dolphins', 'an explicit lookup is not seeded');
    eq(X.seedQuery('look up Howard Shore', ctx), 'Howard Shore', 'an explicit name lookup is not seeded');
    eq(X.seedQuery('research Vincent Cassel', ctx), 'Vincent Cassel', 'an explicit "research <name>" is not seeded');
    // an already-specific extraction (a proper noun in the message) needs no anchor
    eq(X.seedQuery('Skydio drones are everywhere', ctx), 'Skydio', 'a proper noun in the message wins, no seed');
    // the anchor skips an entity the bare term already names (no "surveillance surveillance")
    eq(X.seedQuery('surveillance', ctx), 'Skydio surveillance', 'the first DISTINCT anchor wins');
    // no context → the bare term, unchanged (never worse than before the seed)
    eq(X.seedQuery('research', {}), 'research', 'no subject → unchanged');
    eq(X.seedQuery('research', null), 'research', 'no context → unchanged');
    eq(X.seedQuery('', ctx), null, 'empty → null');
  });

  await group('searchEntities() — offer the hottest subjects at once, hottest on top', async () => {
    const r = await X.searchEntities(['socialism', 'metro council'], { subjects: 3, perSubject: 2 });
    eq(r.status, 'hit', 'a hit when any subject matches');
    ok(r.options.length >= 2, 'options merged across subjects');
    eq(r.options[0].title, 'Socialism', 'the hottest subject leads');
    eq(r.options[0].via, 'socialism', 'each option carries the subject it came from');
    ok(r.options.some(o => o.title === 'Metropolitan Council'), 'a later subject contributes too');
    eq(r.options.filter(o => o.title === 'Other Thing').length, 1, 'a title two subjects share is merged, not duplicated');
    // a subject is searched at most once even if it repeats in the heat list
    const log2 = [];
    const X2 = loadExternal(log2);
    await X2.searchEntities(['socialism', 'Socialism', 'metro council'], { subjects: 3, perSubject: 2 });
    eq(log2.filter(e => e.kind === 'wiki-search').length, 2, 'duplicate subjects collapse to one search each');
    // graceful edges
    const miss = await X.searchEntities(['no such subject here'], {});
    ok(miss.status === 'miss' || miss.status === 'no-options', 'all-miss → miss/no-options, not a throw');
    eq((await X.searchEntities([], {})).status, 'miss', 'no subjects → miss');
    eq((await X.searchEntities(['socialism'], { subjects: 9 })).status, 'hit', 'subjects clamps high, still a hit');
  });

  await group('rate limiter — calls are spaced by the interval', async () => {
    X.setConfig({ intervalMs: 25 });
    const log2 = [];
    X.setConfig({ fetchImpl: makeFetch(log2) });
    const words = ['rl_alpha', 'rl_beta', 'rl_gamma']; // fresh, uncached, all miss → 1 request each
    await Promise.all(words.map(w => X.lookup('wiktionary', w)));
    const times = log2.filter(e => e.kind === 'wikt-def').map(e => e.at).sort((a, b) => a - b);
    eq(times.length, 3, 'three requests issued');
    let spaced = true;
    for (let i = 1; i < times.length; i++) if (times[i] - times[i - 1] < 18) spaced = false;
    ok(spaced, `consecutive requests are ≥ ~interval apart (gaps: ${times.map((t, i) => i ? t - times[i - 1] : 0).join(',')})`);
    X.setConfig({ intervalMs: 5 });
  });

  // ---- summary ----
  await sleep(5);
  console.log(`\n${fail ? '✗' : '✓'} external.js: ${pass} passed, ${fail} failed`);
  if (fail) { console.error('\nFailures:\n - ' + fails.join('\n - ')); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
