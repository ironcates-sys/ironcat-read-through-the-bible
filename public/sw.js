/* Service worker: caches ONLY the app shell, the plan JSON and announcement clips.
 * It never touches Bible Brain audio/text or /api/* responses: those requests are not
 * intercepted at all (no respondWith), so they always go straight to the network. */
importScripts('/js/version.js');

var CACHE = 'ironcat-shell-' + APP_VERSION;
var SHELL = [
  '/', '/index.html', '/css/style.css', '/js/version.js', '/js/queue.js', '/js/app.js',
  '/manifest.webmanifest', '/data/plan.json',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png', '/icons/apple-touch-icon.png',
];

function precache() {
  return caches.open(CACHE).then(function (cache) {
    // Shell must succeed; announcement clips are best-effort (app works without them).
    return cache.addAll(SHELL.map(function (u) { return new Request(u, { cache: 'reload' }); })).then(function () {
      return fetch('/data/plan.json', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (plan) {
        var seen = { 'silence.mp3': 1 }, names = ['silence.mp3'];
        plan.days.forEach(function (d) {
          d.items.forEach(function (it) {
            var single = plan.books[it.book].chapters === 1;
            var n = it.bookId.toLowerCase() + (single ? '' : '-' + it.chapter) + '.mp3';
            if (!seen[n]) { seen[n] = 1; names.push(n); }
          });
        });
        return Promise.all(names.map(function (n) {
          return fetch('/announce/' + n, { cache: 'reload' }).then(function (r) {
            if (r.ok) return cache.put('/announce/' + n, r);
          }).catch(function () {});
        }));
      });
    }).catch(function () {});
  });
}

self.addEventListener('install', function (e) {
  e.waitUntil(precache());           // no skipWaiting: the app offers "refresh" instead
});

self.addEventListener('message', function (e) {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k.indexOf('ironcat-') === 0 && k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

// Safari requests media with Range headers; answer from the cached full file with a 206.
function rangeResponse(req, res) {
  var h = req.headers.get('range');
  var m = /^bytes=(\d*)-(\d*)$/.exec(h || '');
  if (!m) return Promise.resolve(res);
  return res.arrayBuffer().then(function (buf) {
    var size = buf.byteLength;
    var start = m[1] === '' ? Math.max(0, size - Number(m[2])) : Number(m[1]);
    var end = m[1] === '' || m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
    if (start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + size } });
    return new Response(buf.slice(start, end + 1), {
      status: 206,
      headers: {
        'Content-Type': res.headers.get('Content-Type') || 'audio/mpeg',
        'Content-Length': String(end - start + 1),
        'Content-Range': 'bytes ' + start + '-' + end + '/' + size,
        'Accept-Ranges': 'bytes',
      },
    });
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;                 // Bible Brain audio etc.: never intercepted
  var p = url.pathname;
  if (p.indexOf('/api/') === 0 || p.indexOf('/.netlify/') === 0 || p.indexOf('/mock/') === 0) return;

  if (p.indexOf('/announce/') === 0) {                              // announcement clips (same-origin, small)
    e.respondWith(
      caches.open(CACHE).then(function (cache) {
        return cache.match(p).then(function (hit) {
          if (hit) return rangeResponse(req, hit);
          // Not cached yet: serve from network and store a full copy for next time.
          e.waitUntil(fetch(p).then(function (r) { if (r.ok) return cache.put(p, r); }).catch(function () {}));
          return fetch(req);
        });
      })
    );
    return;
  }

  if (req.mode === 'navigate') {                                    // app shell, offline-capable
    e.respondWith(caches.match('/index.html').then(function (hit) { return hit || fetch(req); }));
    return;
  }

  if (SHELL.indexOf(p) !== -1) {
    e.respondWith(caches.match(p).then(function (hit) { return hit || fetch(req); }));
  }
  // anything else: not intercepted
});
