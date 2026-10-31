// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors

/**
 * Scripts of the two test-only frames the harness adds to the editor page. Both are inline scripts in sandboxed
 * `srcdoc` frames, allowed by hash in the harness's editor policy (server.ts), the same way the runtime's bootstrap
 * is. Neither is part of the app.
 */

/**
 * A hostile window inside the editor page: another opaque-origin frame, standing for anything that can reach the
 * runtime frame's window. On `{ type: 'attack' }` from its parent it posts a forged `load` (with its own worker
 * source) to every other frame of the page, and forged `ready` answers with guessed nonces and its own ports to the
 * page, for `ms` milliseconds. It reports how many it sent.
 */
export const ATTACKER_FRAME_SOURCE = `(function () {
  addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.type !== 'attack') return;
    var until = Date.now() + data.ms;
    var loads = 0, readies = 0;
    var forgedWorker = 'self.onmessage = function (e) { var p = e.ports[0]; if (p) p.onmessage = function () { p.postMessage({ type: "result", invocation: 1, ok: true, value: "forged" }); }; };';
    var tick = function () {
      for (var i = 0; i < parent.frames.length; i++) {
        var target = parent.frames[i];
        if (target === window) continue;
        try { target.postMessage({ type: 'load', nonce: 'forged', worker: forgedWorker, main: 'main.js', files: {} }, '*'); loads++; } catch (e) {}
      }
      var a = new MessageChannel(), b = new MessageChannel();
      a.port1.onmessage = function () { a.port1.postMessage({ type: 'ready', v: 1 }); };
      parent.postMessage({ type: 'ready', nonce: (crypto.randomUUID ? crypto.randomUUID() : String(Math.random())) }, '*', [a.port2, b.port2]);
      readies++;
      if (Date.now() < until) setTimeout(tick, 1);
      else parent.postMessage({ type: 'attacker-done', loads: loads, readies: readies }, '*');
    };
    tick();
  });
})();`;

/**
 * Defense in depth: what code would be able to do if it ran in the runtime frame's document itself. No extension code
 * runs there (it runs in the frame's worker), but the frame's sandbox and policy are the second wall. This probe runs
 * in a frame with the runtime frame's exact sandbox flags and policy, with only the script hash swapped, and reports
 * each attempt to its parent.
 */
export const FRAME_PROBE_SOURCE = `(function () {
  addEventListener('message', async function (event) {
    var p = event.data;
    if (!p || p.type !== 'probe') return;
    var u = function (name) { return p.remote + '/x/' + p.tag + '/' + name; };
    var results = {};
    var attempt = async function (name, f) {
      try {
        var value = await Promise.race([Promise.resolve().then(f), new Promise(function (_, reject) { setTimeout(function () { reject(new Error('no answer')); }, 1500); })]);
        results[name] = { outcome: 'allowed', detail: String(value).slice(0, 160) };
      } catch (e) {
        results[name] = { outcome: 'blocked', detail: String(e && e.name) + ': ' + String(e && e.message).slice(0, 160) };
      }
    };
    var load = function (element, attr, url) {
      return new Promise(function (resolve, reject) {
        element.onload = function () { resolve('loaded'); };
        element.onerror = function () { reject(new Error('error event')); };
        element[attr] = url;
        document.head.appendChild(element);
      });
    };
    await attempt('fetch', function () { return fetch(u('frame-fetch')).then(function (r) { return r.status; }); });
    await attempt('image', function () { return load(new Image(), 'src', u('frame-img')); });
    await attempt('script', function () { return load(document.createElement('script'), 'src', u('frame-script')); });
    await attempt('stylesheet', function () { var l = document.createElement('link'); l.rel = 'stylesheet'; return load(l, 'href', u('frame-style')); });
    await attempt('prefetch', function () { var l = document.createElement('link'); l.rel = 'prefetch'; return load(l, 'href', u('frame-prefetch')); });
    await attempt('nestedFrame', function () { return load(document.createElement('iframe'), 'src', u('frame-iframe')); });
    await attempt('windowOpen', function () { var w = open(u('frame-open')); if (!w) throw new Error('open returned null'); return 'opened'; });
    await attempt('topNavigation', function () { top.location.href = u('frame-top'); return 'assigned'; });
    await attempt('formToTop', function () { var f = document.createElement('form'); f.action = u('frame-form-top'); f.method = 'post'; f.target = '_top'; document.body.appendChild(f); f.submit(); return 'submitted'; });
    await attempt('anchorToTop', function () { var a = document.createElement('a'); a.href = u('frame-anchor-top'); a.target = '_top'; document.body.appendChild(a); a.click(); return 'clicked'; });
    await attempt('modalDialog', function () { var started = Date.now(); alert('Sign in again'); return 'returned after ' + (Date.now() - started) + ' ms'; });
    await attempt('fullscreen', function () { return document.documentElement.requestFullscreen(); });
    await attempt('localStorage', function () { return localStorage.getItem('pf-secret'); });
    await attempt('sessionStorage', function () { return sessionStorage.getItem('pf-secret'); });
    await attempt('cookie', function () { return document.cookie; });
    await attempt('indexedDB', function () { return new Promise(function (resolve, reject) { var r = indexedDB.open('pf-secret-db'); r.onsuccess = function () { resolve('opened'); }; r.onerror = function () { reject(r.error); }; }); });
    await attempt('caches', function () { return caches.keys(); });
    await attempt('parentDocument', function () { return parent.document.title; });
    await attempt('parentStorage', function () { return parent.localStorage.getItem('pf-secret'); });
    await attempt('webrtc', function () {
      return new Promise(function (resolve, reject) {
        if (typeof RTCPeerConnection === 'undefined') throw new ReferenceError('RTCPeerConnection is not defined');
        var pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:' + p.stun }] });
        pc.createDataChannel('x');
        pc.onicegatheringstatechange = function () { if (pc.iceGatheringState === 'complete') { pc.close(); resolve('gathered'); } };
        pc.createOffer().then(function (o) { return pc.setLocalDescription(o); }).catch(reject);
      });
    });
    // Last: a frame may navigate itself, which ends this probe if it succeeds.
    parent.postMessage({ type: 'frame-probe', results: results }, '*');
    setTimeout(function () { try { location.href = u('frame-self-navigation'); } catch (e) {} }, 50);
  });
})();`;
