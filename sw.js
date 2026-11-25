/* Offline cache so the app opens instantly and works with no signal. Bump VERSION when you update files. */
const VERSION = 'funcam-v4';
const FILES = [
  './', 'index.html', 'style.css', 'app.js', 'pitch-worklet.js', 'manifest.webmanifest',
  'icon-192.png', 'icon-512.png',
  'face_mesh.js', 'face_mesh.binarypb', 'face_mesh_solution_packed_assets.data',
  'face_mesh_solution_packed_assets_loader.js', 'face_mesh_solution_simd_wasm_bin.js', 'face_mesh_solution_simd_wasm_bin.wasm'
];
self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    await Promise.all(FILES.map(f => c.add(f).catch(() => {})));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const c = await caches.open(VERSION);
    const hit = await c.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    } catch (err) {
      return (await c.match('index.html')) || Response.error();
    }
  })());
});
