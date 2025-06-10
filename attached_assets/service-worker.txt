const CACHE_NAME = 'chatterhub-v2';
const OFFLINE_MESSAGE_QUEUE = 'offline-messages';
const OFFLINE_DM_QUEUE = 'offline-dms';

const urlsToCache = [
  '/',
  '/static/style.css',
  '/static/main.js',
  '/static/manifest.json',
  '/static/icons/icon-192x192.svg',
  '/static/icons/icon-512x512.svg',
  'https://cdnjs.cloudflare.com/ajax/libs/socket.io/4.6.1/socket.io.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.1.1/css/all.min.css'
];

// Install service worker and cache assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Opened cache');
        return cache.addAll(urlsToCache);
      })
  );
  
  // Create IndexedDB for offline message queuing if it doesn't exist
  self.clients.matchAll().then(clients => {
    clients.forEach(client => {
      client.postMessage({
        type: 'INIT_INDEXED_DB'
      });
    });
  });
});

// Activate the service worker and clean up old caches
self.addEventListener('activate', event => {
  const cacheWhitelist = [CACHE_NAME];
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheWhitelist.indexOf(cacheName) === -1) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  
  // Claim clients so the service worker is in control
  event.waitUntil(self.clients.claim());
});

// Listen for messages from clients
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'CHECK_CONNECTIVITY') {
    event.source.postMessage({
      type: 'CONNECTIVITY_STATUS',
      online: self.navigator.onLine
    });
  }
});

// Background sync for queued messages
self.addEventListener('sync', event => {
  if (event.tag === 'sync-messages') {
    console.log('Syncing queued messages...');
    event.waitUntil(
      self.clients.matchAll().then(clients => {
        if (clients.length > 0) {
          clients[0].postMessage({
            type: 'SYNC_QUEUED_MESSAGES'
          });
        }
      })
    );
  }
  
  if (event.tag === 'sync-dms') {
    console.log('Syncing queued direct messages...');
    event.waitUntil(
      self.clients.matchAll().then(clients => {
        if (clients.length > 0) {
          clients[0].postMessage({
            type: 'SYNC_QUEUED_DMS'
          });
        }
      })
    );
  }
});

// Listen for connectivity changes
self.addEventListener('online', () => {
  console.log('Service worker detected online status');
  self.clients.matchAll().then(clients => {
    clients.forEach(client => {
      client.postMessage({
        type: 'ONLINE_STATUS',
        online: true
      });
    });
  });
  
  // Register a sync when we come back online
  self.registration.sync.register('sync-messages');
  self.registration.sync.register('sync-dms');
});

self.addEventListener('offline', () => {
  console.log('Service worker detected offline status');
  self.clients.matchAll().then(clients => {
    clients.forEach(client => {
      client.postMessage({
        type: 'ONLINE_STATUS',
        online: false
      });
    });
  });
});

// Serve cached content when offline
self.addEventListener('fetch', event => {
  // Skip cross-origin requests and socket.io calls
  if (
    event.request.url.startsWith(self.location.origin) && 
    !event.request.url.includes('socket.io')
  ) {
    event.respondWith(
      caches.match(event.request)
        .then(response => {
          if (response) {
            return response;
          }
          
          // Clone the request because it's a one-time use stream
          const fetchRequest = event.request.clone();
          
          return fetch(fetchRequest).then(response => {
            // Check if we received a valid response
            if (!response || response.status !== 200 || response.type !== 'basic') {
              return response;
            }
            
            // Clone the response because it's a one-time use stream
            const responseToCache = response.clone();
            
            caches.open(CACHE_NAME)
              .then(cache => {
                cache.put(event.request, responseToCache);
              });
              
            return response;
          }).catch(() => {
            // Return a fallback page if offline and no cache hit
            if (event.request.mode === 'navigate') {
              return caches.match('/');
            }
            
            return new Response('Network error occurred', {
              status: 408,
              headers: { 'Content-Type': 'text/plain' }
            });
          });
        })
    );
  }
});