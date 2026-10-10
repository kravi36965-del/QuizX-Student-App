const CACHE="quizx-v4-student-home-visible";
self.addEventListener("install",event=>{self.skipWaiting();event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(["/","/student.html","/css/style.css","/manifest.webmanifest"])));});
self.addEventListener("activate",event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener("fetch",event=>{if(event.request.method!=="GET"||event.request.url.includes("/socket.io/"))return;event.respondWith(fetch(event.request).catch(()=>caches.match(event.request)));});
