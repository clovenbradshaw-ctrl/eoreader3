/* ============================================================
   Local persistence — the privacy promise with a memory.

   Nothing leaves the browser, but until now nothing stayed either: a
   refresh wiped every document, chat, rule toggle, and the engine's
   induced learning. This module keeps them on the device.

     • IndexedDB  — documents and the running chat (can be large; the
                    parsed doc carries a Map, which structured-clone stores
                    natively, so docs persist without re-parsing on load).
     • localStorage — small things: UI prefs, rule toggles, and the learned
                    rules-ledger delta (so learning compounds across visits).

   Published as window.EOStore. Every call is defensive: storage can be
   absent (private mode, disabled), full, or corrupt — a failure degrades
   to in-memory only, never throws into the app.
   ============================================================ */
(function () {
  'use strict';
  const DB_NAME = 'cleo';
  const DB_VERSION = 1;
  const KV = 'kv';                       // one object store, keyed by name
  const LS_PREFS = 'cleo.prefs';
  const LS_LEDGER = 'cleo.ledger';

  let _dbp = null;
  function openDB() {
    if (_dbp) return _dbp;
    _dbp = new Promise((resolve) => {
      let req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); }
      catch (e) { resolve(null); return; }
      req.onupgradeneeded = () => { try { req.result.createObjectStore(KV); } catch (e) {} };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    });
    return _dbp;
  }

  async function kvGet(key) {
    const db = await openDB(); if (!db) return undefined;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(KV, 'readonly');
        const r = tx.objectStore(KV).get(key);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => resolve(undefined);
      } catch (e) { resolve(undefined); }
    });
  }
  async function kvPut(key, value) {
    const db = await openDB(); if (!db) return false;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(KV, 'readwrite');
        tx.objectStore(KV).put(value, key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch (e) { resolve(false); }
    });
  }

  // ---- documents: stored as-is (structured clone keeps the _seqToSent Map) ----
  async function saveDocs(docs) { return kvPut('docs', Array.isArray(docs) ? docs : []); }
  async function loadDocs() { const d = await kvGet('docs'); return Array.isArray(d) ? d : []; }

  // ---- the running chat ----
  async function saveChat(snapshot) { return kvPut('chat', snapshot || {}); }
  async function loadChat() { const c = await kvGet('chat'); return c && typeof c === 'object' ? c : null; }

  // ---- the audit trace (the glass box; persisted so it survives reloads,
  //      until the user intentionally clears it) ----
  async function saveAudit(turns) { return kvPut('audit', Array.isArray(turns) ? turns : []); }
  async function loadAudit() { const a = await kvGet('audit'); return Array.isArray(a) ? a : []; }

  // ---- web sources (web-source/1) — external pages admitted as first-class
  //      groundable sources (websource.js). Stored as an array keyed by id, with
  //      a content-hash lookup so a re-paste of the same URL finds the frozen
  //      record and pays no network. supersede/retract are status mutations, so
  //      an upsert by id covers them (the old record is retained, not deleted).
  async function loadWebSources() { const w = await kvGet('websources'); return Array.isArray(w) ? w : []; }
  async function saveWebSources(list) { return kvPut('websources', Array.isArray(list) ? list : []); }
  async function saveWebSource(record) {
    if (!record || !record.id) return false;
    const list = await loadWebSources();
    const i = list.findIndex(r => r && r.id === record.id);
    if (i >= 0) list[i] = record; else list.push(record);
    return saveWebSources(list);
  }
  async function findWebSourceByHash(contentHash) {
    if (!contentHash) return null;
    const list = await loadWebSources();
    return list.find(r => r && r.content_hash === contentHash) || null;
  }
  async function setWebSourceStatus(id, status) {
    const list = await loadWebSources();
    const r = list.find(x => x && x.id === id);
    if (!r) return false;
    r.status = status;
    return saveWebSources(list);
  }

  // ---- small JSON in localStorage ----
  const lsGet = (k) => { try { const s = localStorage.getItem(k); return s ? JSON.parse(s) : null; } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } };

  function savePrefs(prefs) { return lsSet(LS_PREFS, prefs || {}); }
  function loadPrefs() { return lsGet(LS_PREFS) || {}; }

  // ---- learned rules-ledger delta ----
  function saveLedger(events) { return lsSet(LS_LEDGER, Array.isArray(events) ? events : []); }
  function loadLedger() { const e = lsGet(LS_LEDGER); return Array.isArray(e) ? e : []; }

  // Wipe everything (used by a "clear local data" affordance / tests).
  async function clearAll() {
    try { localStorage.removeItem(LS_PREFS); localStorage.removeItem(LS_LEDGER); } catch (e) {}
    try { await kvPut('docs', []); await kvPut('chat', {}); await kvPut('audit', []); await kvPut('websources', []); } catch (e) {}
  }

  window.EOStore = {
    available: typeof indexedDB !== 'undefined',
    saveDocs, loadDocs, saveChat, loadChat, saveAudit, loadAudit,
    loadWebSources, saveWebSources, saveWebSource, findWebSourceByHash, setWebSourceStatus,
    savePrefs, loadPrefs, saveLedger, loadLedger, clearAll,
    // generic IndexedDB kv (used by the external-knowledge freeze cache). Same
    // defensive contract as the rest: a storage failure resolves undefined/false,
    // never throws into the caller.
    kvGet, kvPut,
  };
})();
