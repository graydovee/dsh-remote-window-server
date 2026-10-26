/** Embed bootstrap + CSS (protocol §9.1/§9.2/§9.3, served as public static routes). */
import { dismissOnboarding } from './onboarding.ts'

/** Classic synchronous script injected before the official app bundle. */
const BOOTSTRAP_BASE = String.raw`(function () {
  'use strict';
  var config = window.__DSH_RW_EMBED__ || {};
  var prefix = typeof config.storagePrefix === 'string' ? config.storagePrefix : 'dshrw:';
  var marker = '__dshRwShimmed__';
  var __dshRwOnboarding__ = __DISMISS_ONBOARDING__;
  var parentOrigin = typeof config.parentOrigin === 'string' ? config.parentOrigin : window.location.origin;
  if (!window[marker]) {
    try { document.documentElement.setAttribute('data-dsh-rw-embed', ''); } catch (e) {}
    if (config.embedCssPath) {
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = config.embedCssPath;
      (document.head || document.documentElement).appendChild(link);
    }
    function wrapStorage(name) {
      var storage = window[name];
      if (!storage) return;
      var proto = Object.getPrototypeOf(storage);
      var original = {
        getItem: proto.getItem,
        setItem: proto.setItem,
        removeItem: proto.removeItem,
        clear: proto.clear,
        key: proto.key
      };
      function keys() {
        var out = [];
        try {
          var total = 0;
          for (var i = 0; ; i++) {
            var k = original.key.call(storage, i);
            if (k === null || k === undefined) break;
            if (typeof k === 'string' && k.indexOf(prefix) === 0) out.push(k);
            total++;
            if (total > 100000) break;
          }
        } catch (e) {}
        return out;
      }
      storage.getItem = function (key) { return original.getItem.call(storage, prefix + String(key)); };
      storage.setItem = function (key, value) { return original.setItem.call(storage, prefix + String(key), value); };
      storage.removeItem = function (key) { return original.removeItem.call(storage, prefix + String(key)); };
      storage.clear = function () {
        keys().forEach(function (key) { original.removeItem.call(storage, key); });
      };
      storage.key = function (index) {
        var list = keys();
        var i = Number(index);
        if (!isFinite(i) || i < 0 || i >= list.length) return null;
        return list[i].slice(prefix.length);
      };
      try {
        Object.defineProperty(storage, 'length', { configurable: true, get: function () { return keys().length; } });
      } catch (e) {}
    }
    wrapStorage('localStorage');
    wrapStorage('sessionStorage');
    window[marker] = true;
  }
  try {
    var params = new URLSearchParams(window.location.search || '');
    var sessionId = params.get('dshRwSession');
    if (sessionId) {
      window.localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: sessionId }));
      // The official preview notice can cover the restored blank composer for
      // several seconds; dismiss only its exact 继续/Continue action, once.
      var onboardingTries = 0;
      var onboardingTimer = setInterval(function () {
        try { if (__dshRwOnboarding__(document)) { clearInterval(onboardingTimer); return; } } catch (e) {}
        if (++onboardingTries >= 100) clearInterval(onboardingTimer);
      }, 100);
    }
    var theme = params.get('dshRwTheme');
    if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
    var lang = params.get('dshRwLang');
    if (lang) document.documentElement.setAttribute('lang', lang);
  } catch (e) {}
  window.addEventListener('message', function (event) {
    if (parentOrigin !== '*' && event.origin !== parentOrigin) return;
    var data = event.data;
    if (!data || data.v !== 1) return;
    if (data.type === 'dsh-rw/open-session' && typeof data.sessionId === 'string') {
      try { window.localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: data.sessionId })); } catch (e) {}
      window.location.reload();
    } else if (data.type === 'dsh-rw/reload') {
      window.location.reload();
    }
  });
  try {
    if (window.parent && window.parent !== window) window.parent.postMessage({ v: 1, type: 'dsh-rw/ready' }, parentOrigin);
  } catch (e) {}
})();`

/** Outer bootstrap with the tested dismissal helper inlined for the iframe realm. */
export const BOOTSTRAP_SCRIPT = BOOTSTRAP_BASE.replace('__DISMISS_ONBOARDING__', `(${dismissOnboarding.toString()})`)

/** Hide the duplicated official navigation and let the conversation main area fill the frame. */
export const EMBED_CSS = String.raw`html[data-dsh-rw-embed] [data-slot="sidebar"],
html[data-dsh-rw-embed] [data-slot="sidebar"] * { display: none !important; }
html[data-dsh-rw-embed] [data-slot="rightbar"],
html[data-dsh-rw-embed] [data-slot="rightbar"] * { display: none !important; }
html[data-dsh-rw-embed] [data-slot="shell.bottom"] { display: none !important; }
html[data-dsh-rw-embed] [data-slot="root"] > div > div { grid-template-columns: minmax(0, 1fr) !important; }`
