// BAHIA GMAO V7 - Service Worker avec mode hors-ligne avancé
const CACHE_NAME = 'bahia-gmao-v7';
const OFFLINE_DB = 'bahia-offline-db';

const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// Installation - Cache les assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS_TO_CACHE))
      .then(() => self.skipWaiting())
  );
});

// Activation - Nettoie les anciens caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch - Stratégie Network First avec fallback cache
self.addEventListener('fetch', event => {
  // Ne pas intercepter les requêtes vers Google Apps Script
  if (event.request.url.includes('script.google.com')) {
    return;
  }
  
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Clone la réponse pour la mettre en cache
        const responseClone = response.clone();
        caches.open(CACHE_NAME).then(cache => {
          cache.put(event.request, responseClone);
        });
        return response;
      })
      .catch(() => {
        // Fallback sur le cache
        return caches.match(event.request).then(response => {
          return response || caches.match('./index.html');
        });
      })
  );
});

// Sync - Synchronisation en arrière-plan
self.addEventListener('sync', event => {
  if (event.tag === 'sync-offline-data') {
    event.waitUntil(syncOfflineData());
  }
});

// Message - Communication avec le client
self.addEventListener('message', event => {
  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  
  if (event.data.type === 'SAVE_OFFLINE') {
    saveOfflineData(event.data.payload);
  }
  
  if (event.data.type === 'GET_OFFLINE_COUNT') {
    getOfflineCount().then(count => {
      event.ports[0].postMessage({ count });
    });
  }
});

// Push notifications
self.addEventListener('push', event => {
  if (event.data) {
    const data = event.data.json();
    const options = {
      body: data.body || 'Nouvelle notification',
      icon: './icon-192.png',
      badge: './icon-192.png',
      vibrate: [200, 100, 200],
      tag: data.tag || 'bahia-notification',
      data: { url: data.url || './' }
    };
    
    event.waitUntil(
      self.registration.showNotification(data.title || 'BAHIA GMAO', options)
    );
  }
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow(event.notification.data.url)
  );
});

// Fonctions utilitaires IndexedDB pour stockage hors-ligne
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(OFFLINE_DB, 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = event => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('pendingSync')) {
        db.createObjectStore('pendingSync', { keyPath: 'id', autoIncrement: true });
      }
    };
  });
}

async function saveOfflineData(data) {
  const db = await openDB();
  const tx = db.transaction('pendingSync', 'readwrite');
  const store = tx.objectStore('pendingSync');
  store.add({ ...data, timestamp: Date.now() });
  return tx.complete;
}

async function getOfflineCount() {
  const db = await openDB();
  const tx = db.transaction('pendingSync', 'readonly');
  const store = tx.objectStore('pendingSync');
  const request = store.count();
  return new Promise(resolve => {
    request.onsuccess = () => resolve(request.result);
  });
}

async function syncOfflineData() {
  const db = await openDB();
  const tx = db.transaction('pendingSync', 'readonly');
  const store = tx.objectStore('pendingSync');
  const items = await new Promise(resolve => {
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
  });
  
  if (items.length === 0) return;
  
  // Envoyer les données au serveur
  const url = await getServerUrl();
  const token = await getToken();
  
  if (!url || !token) return;
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        action: 'syncOfflineData',
        token: token,
        offlineData: items
      })
    });
    
    const result = await response.json();
    
    if (result.success) {
      // Supprimer les items synchronisés
      const deleteTx = db.transaction('pendingSync', 'readwrite');
      const deleteStore = deleteTx.objectStore('pendingSync');
      items.forEach(item => deleteStore.delete(item.id));
      
      // Notifier le client
      self.clients.matchAll().then(clients => {
        clients.forEach(client => {
          client.postMessage({ type: 'SYNC_COMPLETE', count: items.length });
        });
      });
    }
  } catch (error) {
    console.error('Sync failed:', error);
  }
}

async function getServerUrl() {
  const clients = await self.clients.matchAll();
  if (clients.length > 0) {
    return new Promise(resolve => {
      const channel = new MessageChannel();
      channel.port1.onmessage = event => resolve(event.data);
      clients[0].postMessage({ type: 'GET_SERVER_URL' }, [channel.port2]);
    });
  }
  return null;
}

async function getToken() {
  const clients = await self.clients.matchAll();
  if (clients.length > 0) {
    return new Promise(resolve => {
      const channel = new MessageChannel();
      channel.port1.onmessage = event => resolve(event.data);
      clients[0].postMessage({ type: 'GET_TOKEN' }, [channel.port2]);
    });
  }
  return null;
}
