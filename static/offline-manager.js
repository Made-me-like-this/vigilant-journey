// Offline Manager for ChatterHub
// Handles offline message storage and synchronization

// IndexedDB Configuration
const DB_NAME = 'chatterhub-db';
const DB_VERSION = 1;
const MESSAGE_STORE = 'messages';
const DM_STORE = 'direct-messages';
const STATUS_STORE = 'connection-status';

// Global variables
let db = null;
let isOnline = navigator.onLine;

// Initialize the database
function initIndexedDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        
        // Create object stores when database is first created or upgraded
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            
            // Create store for room messages with auto-incrementing key
            if (!db.objectStoreNames.contains(MESSAGE_STORE)) {
                const messageStore = db.createObjectStore(MESSAGE_STORE, { keyPath: 'id', autoIncrement: true });
                messageStore.createIndex('room', 'room', { unique: false });
                messageStore.createIndex('timestamp', 'timestamp', { unique: false });
            }
            
            // Create store for direct messages
            if (!db.objectStoreNames.contains(DM_STORE)) {
                const dmStore = db.createObjectStore(DM_STORE, { keyPath: 'id', autoIncrement: true });
                dmStore.createIndex('sender', 'sender', { unique: false });
                dmStore.createIndex('recipient', 'recipient', { unique: false });
                dmStore.createIndex('timestamp', 'timestamp', { unique: false });
            }
            
            // Create store for connection status
            if (!db.objectStoreNames.contains(STATUS_STORE)) {
                db.createObjectStore(STATUS_STORE, { keyPath: 'key' });
            }
            
            console.log('Database setup complete');
        };
        
        // Handle errors
        request.onerror = (event) => {
            console.error('IndexedDB error:', event.target.error);
            reject(event.target.error);
        };
        
        // Success handler - store the database instance
        request.onsuccess = (event) => {
            db = event.target.result;
            console.log('IndexedDB initialized successfully');
            
            // Initialize connection status
            updateConnectionStatus(isOnline);
            
            resolve(db);
        };
    });
}

// Update connection status in the database
function updateConnectionStatus(status) {
    if (!db) return;
    
    const transaction = db.transaction([STATUS_STORE], 'readwrite');
    const store = transaction.objectStore(STATUS_STORE);
    
    store.put({ key: 'online', value: status });
    
    // Update global variable
    isOnline = status;
    
    // Update UI to reflect connection status
    updateConnectionUI(status);
}

// Update UI to reflect connection status
function updateConnectionUI(status) {
    const statusIndicator = document.getElementById('connectionStatus');
    
    if (!statusIndicator) {
        // Create status indicator if it doesn't exist
        const appContainer = document.querySelector('.app-container');
        const indicator = document.createElement('div');
        indicator.id = 'connectionStatus';
        indicator.className = status ? 'online' : 'offline';
        indicator.innerHTML = status ? 
            '<i class="fas fa-wifi"></i> Online' : 
            '<i class="fas fa-exclamation-triangle"></i> Offline';
        
        if (appContainer) {
            appContainer.appendChild(indicator);
        }
    } else {
        // Update existing indicator
        statusIndicator.className = status ? 'online' : 'offline';
        statusIndicator.innerHTML = status ? 
            '<i class="fas fa-wifi"></i> Online' : 
            '<i class="fas fa-exclamation-triangle"></i> Offline';
    }
}

// Queue a message when offline
function queueMessage(messageData) {
    return new Promise((resolve, reject) => {
        if (!db) {
            reject(new Error('Database not initialized'));
            return;
        }
        
        const transaction = db.transaction([MESSAGE_STORE], 'readwrite');
        const store = transaction.objectStore(MESSAGE_STORE);
        
        // Add message to queue
        const request = store.add(messageData);
        
        request.onsuccess = () => {
            console.log('Message queued for later sending');
            
            // Show queued indicator in UI
            addQueuedMessageToUI(messageData);
            
            resolve(request.result);
        };
        
        request.onerror = (event) => {
            console.error('Error queuing message:', event.target.error);
            reject(event.target.error);
        };
    });
}

// Queue a direct message when offline
function queueDirectMessage(messageData) {
    return new Promise((resolve, reject) => {
        if (!db) {
            reject(new Error('Database not initialized'));
            return;
        }
        
        const transaction = db.transaction([DM_STORE], 'readwrite');
        const store = transaction.objectStore(DM_STORE);
        
        // Add message to queue
        const request = store.add(messageData);
        
        request.onsuccess = () => {
            console.log('Direct message queued for later sending');
            
            // Show queued indicator in UI
            addQueuedDMToUI(messageData);
            
            resolve(request.result);
        };
        
        request.onerror = (event) => {
            console.error('Error queuing direct message:', event.target.error);
            reject(event.target.error);
        };
    });
}

// Add a queued message indicator to the UI
function addQueuedMessageToUI(messageData) {
    const messagesContainer = document.getElementById('messages');
    if (!messagesContainer) return;
    
    // Create message element
    const messageElement = document.createElement('div');
    messageElement.className = 'message queued';
    messageElement.dataset.id = messageData.id;
    
    // Add message content
    messageElement.innerHTML = `
        <div class="message-header">
            <span class="username">${messageData.username}</span>
            <span class="timestamp">Queued</span>
        </div>
        <div class="message-body">${messageData.message}</div>
        <div class="queued-indicator">
            <i class="fas fa-clock"></i> Will be sent when back online
        </div>
    `;
    
    messagesContainer.appendChild(messageElement);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// Add a queued direct message indicator to the UI
function addQueuedDMToUI(messageData) {
    const dmContainer = document.getElementById('directMessages');
    if (!dmContainer) return;
    
    // Create message element
    const messageElement = document.createElement('div');
    messageElement.className = 'direct-message queued outgoing';
    messageElement.dataset.id = messageData.id;
    
    // Add message content
    messageElement.innerHTML = `
        <div class="message-body">${messageData.message}</div>
        <div class="queued-indicator">
            <i class="fas fa-clock"></i> Will be sent when back online
        </div>
    `;
    
    dmContainer.appendChild(messageElement);
    dmContainer.scrollTop = dmContainer.scrollHeight;
}

// Send all queued messages when back online
async function syncQueuedMessages(socket) {
    if (!db || !socket || !socket.connected) {
        return false;
    }
    
    try {
        const transaction = db.transaction([MESSAGE_STORE], 'readwrite');
        const store = transaction.objectStore(MESSAGE_STORE);
        const request = store.getAll();
        
        request.onsuccess = () => {
            const messages = request.result;
            if (messages && messages.length > 0) {
                console.log(`Sending ${messages.length} queued messages`);
                
                messages.forEach(async (message) => {
                    try {
                        // Emit the message to the server
                        socket.emit('message', message);
                        
                        // Remove from queue after successful send
                        const deleteTransaction = db.transaction([MESSAGE_STORE], 'readwrite');
                        const deleteStore = deleteTransaction.objectStore(MESSAGE_STORE);
                        deleteStore.delete(message.id);
                        
                        // Update UI to show message is no longer queued
                        updateQueuedMessageUI(message.id);
                        
                        console.log(`Sent queued message: ${message.id}`);
                    } catch (error) {
                        console.error('Error sending queued message:', error);
                    }
                });
            } else {
                console.log('No queued messages to sync');
            }
        };
        
        request.onerror = (event) => {
            console.error('Error getting queued messages:', event.target.error);
        };
        
        return true;
    } catch (error) {
        console.error('Error syncing queued messages:', error);
        return false;
    }
}

// Send all queued direct messages when back online
async function syncQueuedDirectMessages(socket) {
    if (!db || !socket || !socket.connected) {
        return false;
    }
    
    try {
        const transaction = db.transaction([DM_STORE], 'readwrite');
        const store = transaction.objectStore(DM_STORE);
        const request = store.getAll();
        
        request.onsuccess = () => {
            const messages = request.result;
            if (messages && messages.length > 0) {
                console.log(`Sending ${messages.length} queued direct messages`);
                
                messages.forEach(async (message) => {
                    try {
                        // Emit the direct message to the server
                        socket.emit('direct_message', message);
                        
                        // Remove from queue after successful send
                        const deleteTransaction = db.transaction([DM_STORE], 'readwrite');
                        const deleteStore = deleteTransaction.objectStore(DM_STORE);
                        deleteStore.delete(message.id);
                        
                        // Update UI to show message is no longer queued
                        updateQueuedDMUI(message.id);
                        
                        console.log(`Sent queued direct message: ${message.id}`);
                    } catch (error) {
                        console.error('Error sending queued direct message:', error);
                    }
                });
            } else {
                console.log('No queued direct messages to sync');
            }
        };
        
        request.onerror = (event) => {
            console.error('Error getting queued direct messages:', event.target.error);
        };
        
        return true;
    } catch (error) {
        console.error('Error syncing queued direct messages:', error);
        return false;
    }
}

// Update UI for a queued message that was sent
function updateQueuedMessageUI(messageId) {
    const messageElement = document.querySelector(`.message[data-id="${messageId}"]`);
    if (messageElement) {
        // Remove queued class and indicator
        messageElement.classList.remove('queued');
        const indicator = messageElement.querySelector('.queued-indicator');
        if (indicator) indicator.remove();
        
        // Update timestamp
        const timestamp = messageElement.querySelector('.timestamp');
        if (timestamp) timestamp.textContent = 'Sent';
    }
}

// Update UI for a queued direct message that was sent
function updateQueuedDMUI(messageId) {
    const messageElement = document.querySelector(`.direct-message[data-id="${messageId}"]`);
    if (messageElement) {
        // Remove queued class and indicator
        messageElement.classList.remove('queued');
        const indicator = messageElement.querySelector('.queued-indicator');
        if (indicator) indicator.remove();
    }
}

// Handle online status change
function handleOnlineStatus() {
    console.log('Device is online');
    updateConnectionStatus(true);
    
    // Register for background sync if supported
    if ('serviceWorker' in navigator && 'SyncManager' in window) {
        navigator.serviceWorker.ready.then(registration => {
            registration.sync.register('sync-messages');
            registration.sync.register('sync-dms');
        });
    } else {
        // Fall back to manual sync if background sync not supported
        syncQueuedMessages(window.socket);
        syncQueuedDirectMessages(window.socket);
    }
}

// Handle offline status change
function handleOfflineStatus() {
    console.log('Device is offline');
    updateConnectionStatus(false);
    
    // Show notification
    showNotification('You are offline. Messages will be queued and sent when you reconnect.', 'info');
}

// Listen for messages from service worker
navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data && event.data.type) {
        switch (event.data.type) {
            case 'INIT_INDEXED_DB':
                initIndexedDB();
                break;
            case 'SYNC_QUEUED_MESSAGES':
                syncQueuedMessages(window.socket);
                break;
            case 'SYNC_QUEUED_DMS':
                syncQueuedDirectMessages(window.socket);
                break;
            case 'ONLINE_STATUS':
                updateConnectionStatus(event.data.online);
                break;
        }
    }
});

// Export functions for use in main.js
window.offlineManager = {
    initIndexedDB,
    queueMessage,
    queueDirectMessage,
    syncQueuedMessages,
    syncQueuedDirectMessages,
    handleOnlineStatus,
    handleOfflineStatus,
    updateConnectionStatus,
    isOnline: () => isOnline
};