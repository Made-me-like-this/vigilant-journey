
// Socket.io connection
let socket;
let currentRoom = '';
let currentUsername = '';
let currentPage = 1;
let isLoadingMessages = false;
let allMessages = [];
let searchMode = false;

// PWA Service Worker Registration
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/static/service-worker.js')
      .then(registration => {
        console.log('ServiceWorker registration successful');
      })
      .catch(err => {
        console.log('ServiceWorker registration failed: ', err);
      });
  });
}

// Reconnection variables
let reconnectAttempts = 0;
const maxReconnectAttempts = 5;
let reconnectTimer = null;
let dmRecipient = '';
let onlineUsers = [];
let userStatuses = {}; // Track user online/offline status
let typingUsers = new Set(); // Track who's typing
let messageReactions = {}; // Track message reactions
let replyingTo = null; // Track message being replied to
let drafts = {}; // Store message drafts
let notificationSettings = {
  enabled: true,
  sound: true,
  desktop: true
};

// Performance optimization variables
const MESSAGE_BATCH_SIZE = 50;
const MESSAGE_CACHE_LIMIT = 500;
const TYPING_TIMEOUT = 2000;
const RATE_LIMIT_MESSAGES = 10;
const RATE_LIMIT_WINDOW = 60000; // 1 minute

// Message rate limiting
let messageTimestamps = [];

function setupDirectMessagingUI() {
  // Check if direct messaging UI already exists
  if (document.getElementById('direct-messaging')) {
    return;
  }

  // Create direct messaging interface
  const chatContainer = document.querySelector('.app-container');
  const dmContainer = document.createElement('div');
  dmContainer.id = 'direct-messaging';
  dmContainer.className = 'direct-messaging';
  dmContainer.style.display = 'none';
  dmContainer.innerHTML = `
    <header class="dm-header">
      <button class="back-btn" onclick="closeDM()">
        <i class="fas fa-arrow-left"></i>
      </button>
      <div class="dm-recipient">
        <i class="fas fa-user"></i>
        <span id="dm-recipient">User</span>
        <span id="dm-status" class="user-status"></span>
      </div>
      <div class="dm-actions">
        <button class="room-action-btn" id="dmSearchBtn" title="Search Messages">
          <i class="fas fa-search"></i>
        </button>
      </div>
    </header>
    <div class="dm-messages" id="dm-messages"></div>
    <div id="dm-reply-indicator" class="reply-indicator" style="display: none;">
      <span class="replying-to">Replying to: <span id="dm-reply-preview"></span></span>
      <button class="cancel-reply" onclick="cancelDMReply()">&times;</button>
    </div>
    <div id="dm-typing-indicator" class="typing-indicator" style="display: none;"></div>
    <footer class="dm-input-area">
      <input type="file" id="dmFileInput" accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.txt" style="display: none;" multiple>
      <input type="file" id="dmCameraInput" accept="image/*" capture="environment" style="display: none;">
      <button class="action-btn dm-action-btn" id="dmAttachButton" aria-label="Attach file">
        <i class="fas fa-paperclip"></i>
      </button>
      <button class="action-btn dm-action-btn" id="dmCameraButton" aria-label="Take photo">
        <i class="fas fa-camera"></i>
      </button>
      <div class="message-input-wrapper dm-input-wrapper">
        <input id="dm-input" placeholder="Type a direct message..." disabled />
        <div class="input-actions">
          <button class="action-btn" id="dmEmojiButton" aria-label="Insert emoji">
            <i class="fas fa-smile"></i>
          </button>
        </div>
      </div>
      <button id="dm-send-btn" onclick="sendDirectMessage()" disabled>
        <i class="fas fa-paper-plane"></i>
      </button>
    </footer>
  `;
  chatContainer.appendChild(dmContainer);

  // Setup DM input event listeners
  const dmInput = document.getElementById('dm-input');
  if (dmInput) {
    dmInput.addEventListener('keypress', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        sendDirectMessage();
      }
    });

    dmInput.addEventListener('input', handleDMTyping);
    dmInput.addEventListener('input', saveDMDraft);
  }

  // Setup DM search
  const dmSearchBtn = document.getElementById('dmSearchBtn');
  if (dmSearchBtn) {
    dmSearchBtn.addEventListener('click', toggleDMSearch);
  }
}

function closeDM() {
  const dmEl = document.getElementById('direct-messaging');
  const chatEl = document.getElementById('chat');
  if (dmEl && chatEl) {
    dmEl.style.display = 'none';
    chatEl.style.display = 'flex';
    dmRecipient = '';
    clearInterval(typingTimer);
  }
}

function reconnectWithBackoff() {
  if (socket && socket.connected) return;

  const baseDelay = 1000;  // Start with 1 second
  const maxDelay = 30000;  // Max 30 seconds between attempts
  const currentDelay = Math.min(baseDelay * Math.pow(2, reconnectAttempts), maxDelay);

  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    if (reconnectAttempts < maxReconnectAttempts) {
      console.log(`Attempting to reconnect (${reconnectAttempts + 1}/${maxReconnectAttempts})...`);
      updateConnectionStatus('reconnecting');
      socket.connect();
      reconnectAttempts++;
    } else {
      updateConnectionStatus('failed');
      showNotification("Unable to reconnect. Please refresh the page.", "error");
    }
  }, currentDelay);
}

// Connection status indicator
function updateConnectionStatus(status) {
  let statusIndicator = document.getElementById('connectionStatus');
  if (!statusIndicator) {
    statusIndicator = document.createElement('div');
    statusIndicator.id = 'connectionStatus';
    statusIndicator.className = 'connection-status';
    document.body.appendChild(statusIndicator);
  }

  statusIndicator.className = `connection-status ${status}`;

  switch (status) {
    case 'connected':
      statusIndicator.innerHTML = '<i class="fas fa-wifi"></i> Connected';
      setTimeout(() => statusIndicator.style.display = 'none', 2000);
      break;
    case 'reconnecting':
      statusIndicator.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Reconnecting...';
      statusIndicator.style.display = 'block';
      break;
    case 'failed':
      statusIndicator.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Connection failed';
      statusIndicator.style.display = 'block';
      break;
    default:
      statusIndicator.innerHTML = '<i class="fas fa-wifi-slash"></i> Disconnected';
      statusIndicator.style.display = 'block';
  }
}

// Menu functionality
function toggleMenu() {
  const sidebar = document.querySelector('.sidebar');
  sidebar.classList.toggle('open');
  // Change hamburger icon to close icon
  const hamburger = document.querySelector('.hamburger');
  hamburger.classList.toggle('active');
}

// Rate limiting function
function checkRateLimit() {
  const now = Date.now();
  messageTimestamps = messageTimestamps.filter(timestamp => now - timestamp < RATE_LIMIT_WINDOW);
  
  if (messageTimestamps.length >= RATE_LIMIT_MESSAGES) {
    showNotification("You're sending messages too quickly. Please slow down.", "warning");
    return false;
  }
  
  messageTimestamps.push(now);
  return true;
}

// Message pagination
function loadMoreMessages() {
  if (isLoadingMessages || !currentRoom) return;
  
  isLoadingMessages = true;
  currentPage++;
  
  // Simulate loading more messages (in real app, this would be a server call)
  setTimeout(() => {
    isLoadingMessages = false;
    showNotification(`Loading page ${currentPage}...`, "info");
  }, 500);
}

// Search functionality
function toggleSearch() {
  const searchContainer = document.querySelector('.search-container');
  if (!searchContainer) {
    addSearchToHeader();
  } else {
    searchContainer.style.display = searchContainer.style.display === 'none' ? 'flex' : 'none';
  }
}

function addSearchToHeader() {
  const roomHeader = document.querySelector('.room-header .room-actions');
  if (!roomHeader) return;

  const searchContainer = document.createElement('div');
  searchContainer.className = 'search-container';
  searchContainer.innerHTML = `
    <input type="text" class="search-input" placeholder="Search messages..." id="messageSearch">
    <button class="search-btn" onclick="searchMessages()">
      <i class="fas fa-search"></i>
    </button>
  `;

  roomHeader.insertBefore(searchContainer, roomHeader.firstChild);

  const searchInput = document.getElementById('messageSearch');
  if (searchInput) {
    searchInput.addEventListener('input', debounce(performSearch, 300));
    searchInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        performSearch();
      }
    });
  }
}

function performSearch() {
  const searchInput = document.getElementById('messageSearch');
  if (!searchInput) return;

  const query = searchInput.value.trim().toLowerCase();
  const messages = document.querySelectorAll('.message-container');

  messages.forEach(msg => {
    const content = msg.querySelector('.message-content');
    if (content) {
      const text = content.textContent.toLowerCase();
      if (query && text.includes(query)) {
        msg.classList.add('search-highlight');
        msg.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else {
        msg.classList.remove('search-highlight');
      }
    }
  });
}

// Message reactions
function addReaction(messageId, emoji) {
  if (!messageReactions[messageId]) {
    messageReactions[messageId] = {};
  }
  
  if (!messageReactions[messageId][emoji]) {
    messageReactions[messageId][emoji] = [];
  }
  
  if (!messageReactions[messageId][emoji].includes(currentUsername)) {
    messageReactions[messageId][emoji].push(currentUsername);
    updateReactionDisplay(messageId);
    
    // Emit to server
    if (socket) {
      socket.emit('message_reaction', {
        messageId,
        emoji,
        username: currentUsername,
        room: currentRoom
      });
    }
  }
}

function updateReactionDisplay(messageId) {
  const messageEl = document.querySelector(`[data-message-id="${messageId}"]`);
  if (!messageEl) return;

  let reactionsContainer = messageEl.querySelector('.message-reactions');
  if (!reactionsContainer) {
    reactionsContainer = document.createElement('div');
    reactionsContainer.className = 'message-reactions';
    messageEl.querySelector('.message-bubble').appendChild(reactionsContainer);
  }

  reactionsContainer.innerHTML = '';
  const reactions = messageReactions[messageId] || {};

  Object.entries(reactions).forEach(([emoji, users]) => {
    if (users.length > 0) {
      const reactionEl = document.createElement('span');
      reactionEl.className = 'reaction';
      reactionEl.innerHTML = `${emoji} ${users.length}`;
      reactionEl.title = `Reacted by: ${users.join(', ')}`;
      reactionEl.onclick = () => addReaction(messageId, emoji);
      reactionsContainer.appendChild(reactionEl);
    }
  });
}

// Message status tracking
function updateMessageStatus(messageId, status) {
  const messageEl = document.querySelector(`[data-message-id="${messageId}"]`);
  if (!messageEl) return;

  let statusEl = messageEl.querySelector('.message-status');
  if (!statusEl) {
    statusEl = document.createElement('span');
    statusEl.className = 'message-status';
    const footer = messageEl.querySelector('.message-footer') || 
                   messageEl.querySelector('.message-timestamp').parentNode;
    footer.appendChild(statusEl);
  }

  const icons = {
    'sending': '<i class="fas fa-clock"></i>',
    'sent': '<i class="fas fa-check"></i>',
    'delivered': '<i class="fas fa-check-double"></i>',
    'read': '<i class="fas fa-check-double" style="color: #4F46E5;"></i>'
  };

  statusEl.innerHTML = icons[status] || '';
}

// Utility functions
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

function generateMessageId() {
  return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Draft saving
function saveDraft() {
  const messageInput = document.getElementById('messageInput');
  if (messageInput && currentRoom) {
    const draft = messageInput.value.trim();
    if (draft) {
      drafts[currentRoom] = draft;
    } else {
      delete drafts[currentRoom];
    }
    localStorage.setItem('messageDrafts', JSON.stringify(drafts));
  }
}

function loadDraft() {
  const messageInput = document.getElementById('messageInput');
  if (messageInput && currentRoom && drafts[currentRoom]) {
    messageInput.value = drafts[currentRoom];
  }
}

function saveDMDraft() {
  const dmInput = document.getElementById('dm-input');
  if (dmInput && dmRecipient) {
    const draft = dmInput.value.trim();
    const key = `dm_${currentUsername}_${dmRecipient}`;
    if (draft) {
      drafts[key] = draft;
    } else {
      delete drafts[key];
    }
    localStorage.setItem('messageDrafts', JSON.stringify(drafts));
  }
}

function loadDMDraft() {
  const dmInput = document.getElementById('dm-input');
  if (dmInput && dmRecipient) {
    const key = `dm_${currentUsername}_${dmRecipient}`;
    if (drafts[key]) {
      dmInput.value = drafts[key];
    }
  }
}

// Initialize the app
document.addEventListener('DOMContentLoaded', () => {
  // Setup direct messaging UI
  setupDirectMessagingUI();

  // Load drafts from localStorage
  try {
    drafts = JSON.parse(localStorage.getItem('messageDrafts') || '{}');
  } catch (e) {
    drafts = {};
  }

  // Load notification settings
  try {
    const saved = localStorage.getItem('notificationSettings');
    if (saved) {
      notificationSettings = { ...notificationSettings, ...JSON.parse(saved) };
    }
  } catch (e) {
    console.warn('Failed to load notification settings');
  }

  // Setup profile picture upload
  const profileUpload = document.getElementById('profile-upload');
  const profileImg = document.getElementById('profile-img');
  const defaultAvatar = document.getElementById('default-avatar');

  if (profileUpload) {
    profileUpload.addEventListener('change', function(e) {
      const file = e.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = function(e) {
          profileImg.src = e.target.result;
          profileImg.style.display = 'block';
          defaultAvatar.style.display = 'none';
          // Store in localStorage for persistence
          localStorage.setItem('profilePicture', e.target.result);
        };
        reader.readAsDataURL(file);
      }
    });

    // Load saved profile picture
    const savedPicture = localStorage.getItem('profilePicture');
    if (savedPicture) {
      profileImg.src = savedPicture;
      profileImg.style.display = 'block';
      defaultAvatar.style.display = 'none';
    }
  }

  // Setup UI event listeners
  document.getElementById("isPrivateRoom").addEventListener("change", (e) => {
    document.getElementById("secretKey").style.display = e.target.checked ? "block" : "none";
  });

  // Setup direct chat toggle
  document.getElementById("directChatMode").addEventListener("change", (e) => {
    const roomForm = document.getElementById("roomJoinForm");
    const onlineUsersSection = document.getElementById("onlineUsersSection");

    if (e.target.checked) {
      roomForm.style.display = "none";
      onlineUsersSection.style.display = "block";
      if (socket && socket.connected) {
        socket.emit('get_online_users');
      }
    } else {
      roomForm.style.display = "block";
      onlineUsersSection.style.display = "none";
    }
  });

  // Load initial rooms
  loadRooms();

  // Setup mobile menu toggle
  const hamburger = document.querySelector('.hamburger');
  if (hamburger) {
    hamburger.addEventListener('click', toggleMenu);
  }

  // Disable message input and send button initially
  updateChatInputState(false);

  // Initialize Socket.IO connection
  initializeSocket();

  // Setup message input event listeners
  const messageInput = document.getElementById('messageInput');
  if (messageInput) {
    messageInput.addEventListener('input', handleTypingEvent);
    messageInput.addEventListener('input', saveDraft);
    messageInput.addEventListener('keypress', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        sendMessage();
      }
    });
  }

  // Setup close sidebar button
  const closeSidebar = document.getElementById('close-sidebar');
  if (closeSidebar) {
    closeSidebar.addEventListener('click', () => {
      const sidebar = document.querySelector('.sidebar');
      if (sidebar) {
        sidebar.classList.remove('open');
        const hamburger = document.querySelector('.hamburger');
        if (hamburger) {
          hamburger.classList.remove('active');
        }
      }
    });
  }

  // Setup scroll detection for message loading
  const messagesContainer = document.getElementById('messages');
  if (messagesContainer) {
    messagesContainer.addEventListener('scroll', () => {
      if (messagesContainer.scrollTop === 0 && !isLoadingMessages) {
        loadMoreMessages();
      }
    });
  }

  // Setup file upload functionality
  setupFileUpload();
  setupCameraCapture();

  // Setup emoji functionality
  setupEmojiPicker();

  // Request notification permission
  if ('Notification' in window && notificationSettings.desktop) {
    Notification.requestPermission();
  }
});

// Initialize Socket.IO
function initializeSocket() {
  socket = io({
    transports: ['websocket', 'polling'],
    upgrade: true,
    rememberUpgrade: true
  });
  setupSocketListeners();
  console.log("Socket.IO initialized");
}

// Update chat input state (enable/disable)
function updateChatInputState(enabled) {
  const messageInput = document.getElementById("messageInput");
  const sendButton = document.getElementById("sendButton");
  if (messageInput && sendButton) {
    if (enabled) {
      messageInput.removeAttribute("disabled");
      sendButton.removeAttribute("disabled");
      messageInput.focus();
      loadDraft();
    } else {
      messageInput.setAttribute("disabled", "disabled");
      sendButton.setAttribute("disabled", "disabled");
    }
  }
}

// Room management functions
function createRoom() {
  const name = document.getElementById("newRoomName").value;
  const isPrivate = document.getElementById("isPrivateRoom").checked;
  const key = document.getElementById("secretKey").value;
  if (!name) {
    showNotification("Room name required", "error");
    return;
  }

  if (isPrivate && !key) {
    showNotification("Secret key required for private rooms", "error");
    return;
  }

  fetch('/create_room', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({ name, isPrivate, key })
  })
  .then(res => {
    if (!res.ok) {
      return res.json().then(err => Promise.reject(err));
    }
    return res.json();
  })
  .then(data => {
    if (data.success) {
      showNotification("Room created successfully!", "success");
      loadRooms();

      document.getElementById("newRoomName").value = "";
      document.getElementById("secretKey").value = "";
      document.getElementById("isPrivateRoom").checked = false;
      document.getElementById("secretKey").style.display = "none";
    } else {
      throw new Error(data.message || "Failed to create room");
    }
  })
  .catch(error => {
    console.error("Error creating room:", error);
    showNotification(error.message || "Failed to create room. Please try again.", "error");
  });
}

function loadRooms() {
  fetch('/rooms')
  .then(res => res.json())
  .then(rooms => {
    const list = document.getElementById("room-list");
    if (!list) {
      console.error("Room list element not found");
      return;
    }
    list.innerHTML = "";

    if (rooms.length === 0) {
      const emptyState = document.createElement("div");
      emptyState.className = "empty-state";
      emptyState.innerText = "No public rooms available";
      list.appendChild(emptyState);
      return;
    }

    rooms.forEach(r => {
      const roomItem = document.createElement("div");
      roomItem.className = "room-item";

      const roomIcon = document.createElement("div");
      roomIcon.className = "room-icon";
      roomIcon.innerHTML = r.private ? '<i class="fas fa-lock"></i>' : '<i class="fas fa-users"></i>';

      const roomName = document.createElement("div");
      roomName.className = "room-name";
      roomName.innerText = r.name;

      roomItem.appendChild(roomIcon);
      roomItem.appendChild(roomName);
      roomItem.onclick = () => {
        document.getElementById("room").value = r.name;
        if (window.innerWidth < 768) {
          toggleMenu(); // Close menu on mobile after selection
        }
      };
      list.appendChild(roomItem);
    });
  })
  .catch(error => {
    console.error("Error loading rooms:", error);
    showNotification("Failed to load rooms. Please refresh the page.", "error");
  });
}

function joinRoom() {
  const username = document.getElementById("username").value.trim();
  const room = document.getElementById("room").value.trim();
  if (!username || !room) {
    showNotification("Username and room name are required", "error");
    return;
  }

  // Show loading state
  const joinBtn = document.querySelector('.btn.primary');
  const originalText = joinBtn.innerHTML;
  joinBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Joining...';
  joinBtn.disabled = true;

  // Check if room exists and if it's private
  fetch(`/check_room/${room}`)
  .then(res => res.json())
  .then(data => {
    // Reset button state
    joinBtn.innerHTML = originalText;
    joinBtn.disabled = false;
    if (!data.exists) {
      showNotification("Room doesn't exist", "error");
      return;
    }

    if (data.private) {
      // Prompt for secret key
      const secretKey = prompt("Enter the secret key for this private room:");
      if (!secretKey) return;

      fetch('/join_private', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ room, key: secretKey })
      })
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          initializeSocketAndJoin(username, room);
        } else {
          showNotification("Invalid secret key", "error");
        }
      });
    } else {
      // Join public room
      initializeSocketAndJoin(username, room);
    }
  })
  .catch(error => {
    console.error("Error checking room:", error);
    showNotification("Failed to check room status. Please try again.", "error");
    // Reset button state on error
    joinBtn.innerHTML = originalText;
    joinBtn.disabled = false;
  });
}

function initializeSocketAndJoin(username, room) {
  // Leave previous room if any
  if (currentRoom) {
    socket.emit('leave', { username: currentUsername, room: currentRoom });
  }

  currentUsername = username;
  currentRoom = room;
  currentPage = 1;
  allMessages = [];

  // Register user with socket
  socket.emit('register_user', { username });

  // Join new room
  socket.emit('join', { username, room });

  // Update UI
  const currentRoomElement = document.getElementById("currentRoom");
  if (currentRoomElement) {
    currentRoomElement.innerHTML = `
      <div class="room-info">
        <i class="fas fa-hashtag room-icon"></i>
        <span class="room-name">${room}</span>
      </div>
      <div class="room-actions">
        <button class="room-action-btn" onclick="toggleSearch()" title="Search Messages">
          <i class="fas fa-search"></i>
        </button>
        <button id="leaveBtn" class="room-action-btn" onclick="leaveRoom()" title="Leave Room">
          <i class="fas fa-sign-out-alt"></i>
        </button>
      </div>
    `;
  }

  // Show chat and enable inputs
  const chatElement = document.getElementById("chat");
  if (chatElement) {
    chatElement.style.display = "flex";
  }

  const messagesElement = document.getElementById("messages");
  if (messagesElement) {
    messagesElement.innerHTML = "";  // Clear previous messages
  }
  updateChatInputState(true);

  // Scroll to bottom of messages
  const messagesContainer = document.getElementById("messages");
  if (messagesContainer) {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  if (window.innerWidth < 768) {
    toggleMenu(); // Close sidebar on mobile
  }

  showNotification(`Joined room: ${room}`, "success");
}

function leaveRoom() {
  if (currentRoom && socket) {
    socket.emit('leave', { username: currentUsername, room: currentRoom });
    document.getElementById("chat").style.display = "none";

    // Reset state
    currentRoom = '';
    currentPage = 1;
    allMessages = [];
    updateChatInputState(false);
    showNotification("Left the room", "info");
  }
}

function setupSocketListeners() {
  socket.on('connect', () => {
    console.log('Connected to Socket.IO server');
    reconnectAttempts = 0;
    updateChatInputState(true);
    updateConnectionStatus('connected');

    // Rejoin room if we were in one
    if (currentRoom && currentUsername) {
      socket.emit('register_user', { username: currentUsername });
      socket.emit('join', { username: currentUsername, room: currentRoom });
    } else {
      showNotification("Welcome to ChatterHub!", "info");
    }
  });

  socket.on('connect_error', (error) => {
    console.error('Connection error:', error);
    updateChatInputState(false);
    updateConnectionStatus('failed');
    showNotification("Connection error. Retrying...", "warning");
  });

  socket.on('disconnect', (reason) => {
    console.log('Disconnected:', reason);
    updateChatInputState(false);
    updateConnectionStatus('disconnected');

    if (reason === 'io server disconnect') {
      showNotification("Disconnected by server. Please refresh.", "error");
    } else {
      showNotification("Connection lost. Attempting to reconnect...", "warning");
      reconnectWithBackoff();
    }
  });

  socket.on('connection_established', (data) => {
    console.log('Connection established:', data);
    showNotification("Connected to server", "success");
  });

  socket.on('error', (error) => {
    console.error('Socket error:', error);
    showNotification(error.message || "An error occurred", "error");
  });

  socket.on('message', (data) => {
    displayMessage(data);
    playNotificationSound();
  });

  socket.on('user_joined', (data) => {
    addSystemMessage(`${data.username} joined the room`);
    updateUsersList();
  });

  socket.on('user_left', (data) => {
    addSystemMessage(`${data.username} left the room`);
    updateUsersList();
  });

  socket.on('user_online', (data) => {
    userStatuses[data.username] = 'online';
    updateUserStatus(data.username, 'online');
  });

  socket.on('user_offline', (data) => {
    userStatuses[data.username] = 'offline';
    updateUserStatus(data.username, 'offline');
  });

  socket.on('room_full', (data) => {
    showNotification(`Room ${data.room} is full (max 50 people)`, "error");
    const chatElement = document.getElementById("chat");
    if (chatElement) {
      chatElement.style.display = "none";
    }
    currentRoom = '';
    updateChatInputState(false);
  });

  socket.on('users_list', (data) => {
    onlineUsers = data.users;
    updateOnlineUsersList();
  });

  socket.on('staring_alert', (data) => {
    if (data.target === currentUsername) {
      showNotification(`${data.username} is staring at your message...`, "staring");

      const staringIndicator = document.createElement("div");
      staringIndicator.className = "staring-indicator";
      staringIndicator.innerHTML = '<i class="fas fa-eye"></i>';
      document.body.appendChild(staringIndicator);

      setTimeout(() => {
        staringIndicator.classList.add("fade-out");
        setTimeout(() => {
          if (document.body.contains(staringIndicator)) {
            document.body.removeChild(staringIndicator);
          }
        }, 1000);
      }, 3000);
    }
  });

  socket.on('user_typing', (data) => {
    if (data.username !== currentUsername) {
      showTypingIndicator(data.username);
    }
  });

  socket.on('online_users', (data) => {
    onlineUsers = data.users;
    updateOnlineUsersList();
  });

  socket.on('direct_message', (data) => {
    if ((data.sender === dmRecipient && data.sender !== currentUsername) ||
        (data.recipient === dmRecipient && data.sender === currentUsername)) {
      displayMessage(data, true);
    } else if (data.sender !== currentUsername) {
      showNotification(`New message from ${data.sender}`, "info");
      showDesktopNotification(`New message from ${data.sender}`, data.message);
    }
  });

  socket.on('dm_history', (data) => {
    const dmMessages = document.getElementById('dm-messages');
    if (dmMessages) {
      dmMessages.innerHTML = '';
      if (data.history && data.history.length > 0) {
        data.history.reverse().forEach(msg => {
          if (msg.file) {
            displayFileMessage({
              sender: msg.sender,
              file: JSON.parse(msg.message),
              timestamp: msg.timestamp
            }, true);
          } else {
            displayMessage({
              username: msg.sender,
              message: msg.message,
              timestamp: msg.timestamp
            }, true);
          }
        });
      } else {
        const emptyState = document.createElement('div');
        emptyState.className = 'system-message';
        emptyState.innerText = 'No messages yet. Start a conversation!';
        dmMessages.appendChild(emptyState);
      }
      dmMessages.scrollTop = dmMessages.scrollHeight;
    }
  });

  socket.on('file_message', (data) => {
    if (data.isDm) {
      if ((data.sender === dmRecipient && data.sender !== currentUsername) ||
          (data.recipient === dmRecipient && data.sender === currentUsername)) {
        displayFileMessage(data, true);
      } else if (data.sender !== currentUsername) {
        showNotification(`New file from ${data.sender}`, "info");
      }
    } else {
      displayFileMessage(data);
    }
  });

  socket.on('message_reaction', (data) => {
    if (!messageReactions[data.messageId]) {
      messageReactions[data.messageId] = {};
    }
    if (!messageReactions[data.messageId][data.emoji]) {
      messageReactions[data.messageId][data.emoji] = [];
    }
    if (!messageReactions[data.messageId][data.emoji].includes(data.username)) {
      messageReactions[data.messageId][data.emoji].push(data.username);
      updateReactionDisplay(data.messageId);
    }
  });
}

// Continue with additional helper functions...

function updateUserStatus(username, status) {
  const userElements = document.querySelectorAll(`[data-username="${username}"]`);
  userElements.forEach(el => {
    const indicator = el.querySelector('.online-indicator, .user-status');
    if (indicator) {
      indicator.className = status === 'online' ? 'online-indicator' : 'offline-indicator';
    }
  });
}

function updateOnlineUsersList() {
  const listContainer = document.getElementById('onlineUsersList');
  if (!listContainer) {
    console.error("Online users list container not found");
    return;
  }

  listContainer.innerHTML = '';

  // Filter out the current user from the list
  const filteredUsers = onlineUsers.filter(user => user !== currentUsername);

  if (filteredUsers.length === 0) {
    const emptyState = document.createElement('div');
    emptyState.className = 'empty-state';
    emptyState.innerText = 'No other users online';
    listContainer.appendChild(emptyState);
    return;
  }

  filteredUsers.forEach(user => {
    const userItem = document.createElement('div');
    userItem.className = 'online-user-item';
    userItem.setAttribute('data-username', user);
    userItem.innerHTML = `
      <div class="user-icon">
        <i class="fas fa-user"></i>
        <span class="online-indicator"></span>
      </div>
      <div class="user-name">${user}</div>
    `;
    userItem.onclick = () => startDirectMessage(user);
    listContainer.appendChild(userItem);
  });
}

function startDirectMessage(username) {
  dmRecipient = username;

  const dmRecipientEl = document.getElementById('dm-recipient');
  const dmStatusEl = document.getElementById('dm-status');
  const chatEl = document.getElementById('chat');
  const dmEl = document.getElementById('direct-messaging');
  const dmInput = document.getElementById('dm-input');
  const dmSendBtn = document.getElementById('dm-send-btn');

  if (!dmRecipientEl || !chatEl || !dmEl || !dmInput || !dmSendBtn) {
    console.error("Required elements for DM not found");
    showNotification("Cannot start direct message - interface not ready", "error");
    return;
  }

  dmRecipientEl.innerText = username;
  if (dmStatusEl) {
    dmStatusEl.innerText = userStatuses[username] === 'online' ? '🟢 Online' : '🔴 Offline';
  }
  
  chatEl.style.display = 'none';
  dmEl.style.display = 'flex';
  dmInput.disabled = false;
  dmSendBtn.disabled = false;
  dmInput.focus();

  // Load draft
  loadDMDraft();

  // Hide mobile menu when starting DM
  if (window.innerWidth <= 768) {
    const sidebar = document.querySelector('.sidebar');
    const hamburger = document.querySelector('.hamburger');
    if (sidebar) {
      sidebar.classList.remove('open');
    }
    if (hamburger) {
      hamburger.classList.remove('active');
    }
  }

  // Fetch DM history
  if (socket) {
    socket.emit('get_dm_history', { user1: currentUsername, user2: username, page: 1, limit: MESSAGE_BATCH_SIZE });
  }
}

function sendDirectMessage() {
  const dmInput = document.getElementById('dm-input');
  const message = dmInput.value.trim();

  if (!message || !socket || !dmRecipient) return;
  
  if (!checkRateLimit()) return;

  const messageId = generateMessageId();
  
  socket.emit('direct_message', { 
    id: messageId,
    sender: currentUsername, 
    recipient: dmRecipient, 
    message: message 
  });
  
  dmInput.value = '';
  dmInput.focus();
  
  // Clear draft
  const key = `dm_${currentUsername}_${dmRecipient}`;
  delete drafts[key];
  localStorage.setItem('messageDrafts', JSON.stringify(drafts));
}

function sendMessage() {
  const messageInput = document.getElementById("messageInput");
  const message = messageInput.value.trim();
  
  if (!message || !socket || !currentRoom) return;
  
  if (!checkRateLimit()) return;

  const messageId = generateMessageId();
  
  if (replyingTo) {
    socket.emit('message', { 
      id: messageId,
      username: currentUsername, 
      room: currentRoom, 
      message: message,
      replyTo: replyingTo 
    });
    cancelReply();
  } else {
    socket.emit('message', { 
      id: messageId,
      username: currentUsername, 
      room: currentRoom, 
      message: message 
    });
  }
  
  messageInput.value = "";
  messageInput.focus();
  
  // Clear draft
  delete drafts[currentRoom];
  localStorage.setItem('messageDrafts', JSON.stringify(drafts));
  
  // Update message status
  updateMessageStatus(messageId, 'sending');
}

let typingTimer = null;

function handleTypingEvent() {
  if (socket && currentRoom) {
    socket.emit('typing', { username: currentUsername, room: currentRoom });
  }
  
  // Clear previous timer
  if (typingTimer) clearTimeout(typingTimer);
  
  // Set new timer
  typingTimer = setTimeout(() => {
    // Stop typing after timeout
  }, TYPING_TIMEOUT);
}

function handleDMTyping() {
  if (socket && dmRecipient) {
    socket.emit('dm_typing', { username: currentUsername, recipient: dmRecipient });
  }
}

function showTypingIndicator(username) {
  const typingDiv = document.getElementById("typing-indicator") || document.createElement("div");
  const messagesContainer = document.getElementById("messages");

  if (!messagesContainer) {
    console.error("Messages container not found for typing indicator");
    return;
  }

  if (!document.getElementById("typing-indicator")) {
    typingDiv.id = "typing-indicator";
    typingDiv.className = "typing-indicator";
    messagesContainer.appendChild(typingDiv);
  }

  typingUsers.add(username);
  updateTypingDisplay();

  // Clear previous timer for this user
  setTimeout(() => {
    typingUsers.delete(username);
    updateTypingDisplay();
  }, TYPING_TIMEOUT);
}

function updateTypingDisplay() {
  const typingDiv = document.getElementById("typing-indicator");
  if (!typingDiv) return;

  if (typingUsers.size === 0) {
    typingDiv.style.display = "none";
    return;
  }

  const users = Array.from(typingUsers);
  let text = '';
  
  if (users.length === 1) {
    text = `${users[0]} is typing...`;
  } else if (users.length === 2) {
    text = `${users[0]} and ${users[1]} are typing...`;
  } else {
    text = `${users.length} people are typing...`;
  }

  typingDiv.innerHTML = text;
  typingDiv.style.display = "block";
}

function addSystemMessage(text) {
  const messagesDiv = document.getElementById("messages");
  if (!messagesDiv) {
    console.log("Messages container not found for system message");
    return;
  }

  const systemMsg = document.createElement("div");
  systemMsg.className = "system-message";
  systemMsg.innerText = text;
  messagesDiv.appendChild(systemMsg);

  // Scroll to bottom
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

function showNotification(message, type = "info") {
  const notification = document.createElement("div");
  notification.className = `notification ${type}`;
  notification.innerText = message;

  document.body.appendChild(notification);

  // Animate in
  setTimeout(() => {
    notification.classList.add("show");
  }, 10);

  // Remove after 3 seconds
  setTimeout(() => {
    notification.classList.remove("show");
    setTimeout(() => {
      if (document.body.contains(notification)) {
        document.body.removeChild(notification);
      }
    }, 300);
  }, 3000);
}

function showDesktopNotification(title, message) {
  if (!notificationSettings.desktop || !('Notification' in window)) return;
  
  if (Notification.permission === 'granted') {
    new Notification(title, {
      body: message,
      icon: '/static/icons/icon-192x192.svg',
      tag: 'chatterhub-message'
    });
  }
}

function playNotificationSound() {
  if (!notificationSettings.sound) return;
  
  // Create a simple notification sound
  const audioContext = new (window.AudioContext || window.webkitAudioContext)();
  const oscillator = audioContext.createOscillator();
  const gainNode = audioContext.createGain();
  
  oscillator.connect(gainNode);
  gainNode.connect(audioContext.destination);
  
  oscillator.frequency.value = 800;
  oscillator.type = 'sine';
  
  gainNode.gain.setValueAtTime(0, audioContext.currentTime);
  gainNode.gain.linearRampToValueAtTime(0.1, audioContext.currentTime + 0.01);
  gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.1);
  
  oscillator.start(audioContext.currentTime);
  oscillator.stop(audioContext.currentTime + 0.1);
}

function displayMessage(data, isDm = false) {
  const messagesDiv = isDm ? document.getElementById('dm-messages') : document.getElementById("messages");
  if (!messagesDiv) {
    console.error(`Messages container not found for ${isDm ? 'direct' : 'room'} message`);
    return;
  }

  const messageId = data.id || generateMessageId();
  const messageDiv = document.createElement("div");
  messageDiv.className = `message-container ${data.username === currentUsername || data.sender === currentUsername ? 'me' : 'them'}`;
  messageDiv.setAttribute('data-message-id', messageId);

  const bubble = document.createElement("div");
  bubble.className = `message-bubble ${data.username === currentUsername || data.sender === currentUsername ? 'me' : 'them'}`;

  // Add reply indicator if this is a reply
  if (data.replyTo) {
    const replyIndicator = document.createElement("div");
    replyIndicator.className = "reply-indicator";
    replyIndicator.innerHTML = `<small>Replying to: ${data.replyTo.preview}</small>`;
    bubble.appendChild(replyIndicator);
  }

  const header = document.createElement("div");
  header.className = "message-header";
  header.innerText = data.username || data.sender;

  const content = document.createElement("div");
  content.className = "message-content";
  content.innerText = data.message;

  const footer = document.createElement("div");
  footer.className = "message-footer";

  const timestamp = document.createElement("div");
  timestamp.className = "message-timestamp";
  timestamp.innerText = new Date(data.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  footer.appendChild(timestamp);

  // Add message actions
  if (!isDm && data.username !== currentUsername && data.username !== 'System') {
    const actions = document.createElement("div");
    actions.className = "message-actions";
    
    const replyBtn = document.createElement("button");
    replyBtn.className = "action-btn";
    replyBtn.innerHTML = '<i class="fas fa-reply"></i>';
    replyBtn.title = "Reply";
    replyBtn.onclick = () => replyToMessage(messageId, data.message.substring(0, 50));
    
    const reactBtn = document.createElement("button");
    reactBtn.className = "action-btn";
    reactBtn.innerHTML = '<i class="fas fa-smile"></i>';
    reactBtn.title = "React";
    reactBtn.onclick = () => showReactionPicker(messageId);
    
    const stareBtn = document.createElement("button");
    stareBtn.className = "action-btn";
    stareBtn.innerHTML = '<i class="fas fa-eye"></i>';
    stareBtn.title = "Stare";
    stareBtn.onclick = () => stareAtMessage(data.username || data.sender);
    
    actions.appendChild(replyBtn);
    actions.appendChild(reactBtn);
    actions.appendChild(stareBtn);
    bubble.appendChild(actions);
  }

  bubble.appendChild(header);
  bubble.appendChild(content);
  bubble.appendChild(footer);

  messageDiv.appendChild(bubble);
  messagesDiv.appendChild(messageDiv);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;

  // Store message in cache
  allMessages.push({ id: messageId, ...data });
  if (allMessages.length > MESSAGE_CACHE_LIMIT) {
    allMessages = allMessages.slice(-MESSAGE_CACHE_LIMIT);
  }

  // Update message status to sent
  if (data.username === currentUsername || data.sender === currentUsername) {
    updateMessageStatus(messageId, 'sent');
  }
}

function replyToMessage(messageId, preview) {
  replyingTo = { id: messageId, preview };
  
  const replyIndicator = document.getElementById('reply-indicator');
  const replyPreview = document.getElementById('reply-preview');
  
  if (replyIndicator && replyPreview) {
    replyPreview.innerText = preview;
    replyIndicator.style.display = 'flex';
  }
  
  const messageInput = document.getElementById('messageInput');
  if (messageInput) {
    messageInput.focus();
  }
}

function cancelReply() {
  replyingTo = null;
  const replyIndicator = document.getElementById('reply-indicator');
  if (replyIndicator) {
    replyIndicator.style.display = 'none';
  }
}

function cancelDMReply() {
  // Similar to cancelReply but for DMs
  const replyIndicator = document.getElementById('dm-reply-indicator');
  if (replyIndicator) {
    replyIndicator.style.display = 'none';
  }
}

function showReactionPicker(messageId) {
  const picker = document.createElement('div');
  picker.className = 'reaction-picker';
  picker.innerHTML = `
    <div class="reaction-options">
      <button class="reaction-option" onclick="addReaction('${messageId}', '👍')">👍</button>
      <button class="reaction-option" onclick="addReaction('${messageId}', '❤️')">❤️</button>
      <button class="reaction-option" onclick="addReaction('${messageId}', '😂')">😂</button>
      <button class="reaction-option" onclick="addReaction('${messageId}', '😮')">😮</button>
      <button class="reaction-option" onclick="addReaction('${messageId}', '😢')">😢</button>
      <button class="reaction-option" onclick="addReaction('${messageId}', '🔥')">🔥</button>
    </div>
  `;
  
  document.body.appendChild(picker);
  
  // Position the picker
  const messageEl = document.querySelector(`[data-message-id="${messageId}"]`);
  if (messageEl) {
    const rect = messageEl.getBoundingClientRect();
    picker.style.position = 'fixed';
    picker.style.top = `${rect.top - 50}px`;
    picker.style.left = `${rect.left}px`;
  }
  
  // Remove picker after 3 seconds or when clicking elsewhere
  setTimeout(() => {
    if (document.body.contains(picker)) {
      document.body.removeChild(picker);
    }
  }, 3000);
  
  picker.addEventListener('click', () => {
    document.body.removeChild(picker);
  });
}

function stareAtMessage(username) {
  if (socket && currentRoom) {
    socket.emit('staring', { username: currentUsername, target: username, room: currentRoom });
    showNotification(`You are staring at ${username}'s message...`, "info");
  }
}

// File upload variables
let selectedFiles = [];
let isDmUpload = false;

// Emoji system variables
let emojiPicker = null;
let recentEmojis = JSON.parse(localStorage.getItem('recentEmojis') || '[]');
let isEmojiPickerOpen = false;

// Emoji data organized by categories
const emojiData = {
  'Smileys & People': [
    '😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃',
    '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '☺️', '😚',
    '😙', '😋', '😛', '😜', '🤪', '😝', '🤑', '🤗', '🤭', '🤫',
    '🤔', '🤐', '🤨', '😐', '😑', '😶', '😏', '😒', '🙄', '😬',
    '🤥', '😔', '😪', '🤤', '😴', '😷', '🤒', '🤕', '🤢', '🤮',
    '🤧', '🥵', '🥶', '🥴', '😵', '🤯', '🤠', '🥳', '😎', '🤓',
    '🧐', '😕', '😟', '🙁', '☹️', '😮', '😯', '😲', '😳', '🥺',
    '😦', '😧', '😨', '😰', '😥', '😢', '😭', '😱', '😖', '😣',
    '😞', '😓', '😩', '😫', '🥱', '😤', '😡', '😠', '🤬', '😈',
    '👿', '💀', '☠️', '💩', '🤡', '👹', '👺', '👻', '👽', '👾'
  ],
  'Animals & Nature': [
    '🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯',
    '🦁', '🐮', '🐷', '🐽', '🐸', '🐵', '🙈', '🙉', '🙊', '🐒',
    '🐔', '🐧', '🐦', '🐤', '🐣', '🐥', '🦆', '🦅', '🦉', '🦇',
    '🐺', '🐗', '🐴', '🦄', '🐝', '🐛', '🦋', '🐌', '🐞', '🐜',
    '🦟', '🦗', '🕷️', '🕸️', '🦂', '🐢', '🐍', '🦎', '🦖', '🦕',
    '🐙', '🦑', '🦐', '🦞', '🦀', '🐡', '🐠', '🐟', '🐬', '🐳',
    '🐋', '🦈', '🐊', '🐅', '🐆', '🦓', '🦍', '🦧', '🐘', '🦛',
    '🦏', '🐪', '🐫', '🦒', '🦘', '🐃', '🐂', '🐄', '🐎', '🐖'
  ],
  'Food & Drink': [
    '🍎', '🍐', '🍊', '🍋', '🍌','🍉', '🍇', '🍓', '🍈', '🍒',
    '🍑', '🥭', '🍍', '🥥', '🥝', '🍅', '🍆', '🥑', '🥦', '🥬',
    '🥒', '🌶️', '🌽', '🥕', '🧄', '🧅', '🥔', '🍠', '🥐', '🥯',
    '🍞', '🥖', '🥨', '🧀', '🥚', '🍳', '🧈', '🥞', '🧇', '🥓',
    '🥩', '🍗', '🍖', '🦴', '🌭', '🍔', '🍟', '🍕', '🥪', '🥙',
    '🧆', '🌮', '🌯', '🥗', '🥘', '🥫', '🍝', '🍜', '🍲', '🍛',
    '🍣', '🍱', '🥟', '🦪', '🍤', '🍙', '🍚', '🍘', '🍥', '🥠',
    '🥮', '🍢', '🍡', '🍧', '🍨', '🍦', '🥧', '🧁', '🍰', '🎂'
  ],
  'Activities': [
    '⚽', '🏀', '🏈', '⚾', '🥎', '🎾', '🏐', '🏉', '🥏', '🎱',
    '🪀', '🏓', '🏸', '🏒', '🏑', '🥍', '🏏', '🪃', '🥅', '⛳',
    '🪁', '🏹', '🎣', '🤿', '🥊', '🥋', '🎽', '🛹', '🛷', '⛸️',
    '🥌', '🎿', '⛷️', '🏂', '🪂', '🏋️', '🤼', '🤸', '⛹️', '🤺',
    '🏌️', '🏇', '🧘', '🏄', '🏊', '🤽', '🚣', '🧗', '🚵', '🚴',
    '🏆', '🥇', '🥈', '🥉', '🏅', '🎖️', '🏵️', '🎗️', '🎫', '🎟️',
    '🎪', '🤹', '🎭', '🩰', '🎨', '🎬', '🎤', '🎧', '🎼', '🎵',
    '🎶', '🥁', '🪘', '🎹', '🎷', '🎺', '🎸', '🪕', '🎻', '🎲'
  ],
  'Travel & Places': [
    '🚗', '🚕', '🚙', '🚌', '🚎', '🏎️', '🚓', '🚑', '🚒', '🚐',
    '🛻', '🚚', '🚛', '🚜', '🏍️', '🛵', '🚲', '🛴', '🛺', '🚨',
    '🚔', '🚍', '🚘', '🚖', '🚡', '🚠', '🚟', '🚃', '🚋', '🚞',
    '🚝', '🚄', '🚅', '🚈', '🚂', '🚆', '🚇', '🚊', '🚉', '✈️',
    '🛫', '🛬', '🛩️', '💺', '🛰️', '🚀', '🛸', '🚁', '🛶', '⛵',
    '🚤', '🛥️', '🛳️', '⛴️', '🚢', '⚓', '⛽', '🚧', '🚦', '🚥',
    '🗺️', '🗿', '🗽', '🗼', '🏰', '🏯', '🏟️', '🎡', '🎢', '🎠',
    '⛲', '⛱️', '🏖️', '🏝️', '🏜️', '🌋', '⛰️', '🏔️', '🗻', '🏕️'
  ],
  'Objects': [
    '⌚', '📱', '📲', '💻', '⌨️', '🖥️', '🖨️', '🖱️', '🖲️', '🕹️',
    '🗜️', '💽', '💾', '💿', '📀', '📼', '📷', '📸', '📹', '🎥',
    '📽️', '🎞️', '📞', '☎️', '📟', '📠', '📺', '📻', '🎙️', '🎚️',
    '🎛️', '🧭', '⏱️', '⏲️', '⏰', '🕰️', '⌛', '⏳', '📡', '🔋',
    '🔌', '💡', '🔦', '🕯️', '🪔', '🧯', '🛢️', '💸', '💵', '💴',
    '💶', '💷', '💰', '💳', '💎', '⚖️', '🧰', '🔧', '🔨', '⚒️',
    '🛠️', '⛏️', '🔩', '⚙️', '🧱', '⛓️', '🧲', '🔫', '💣', '🧨',
    '🪓', '🔪', '🗡️', '⚔️', '🛡️', '🚬', '⚰️', '⚱️', '🏺', '🔮'
  ],
  'Symbols': [
    '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔',
    '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '☮️',
    '✝️', '☪️', '🕉️', '☸️', '✡️', '🔯', '🕎', '☯️', '☦️', '🛐',
    '⛎', '♈', '♉', '♊', '♋', '♌', '♍', '♎', '♏', '♐',
    '♑', '♒', '♓', '🆔', '⚛️', '🉑', '☢️', '☣️', '📴', '📳',
    '🈶', '🈚', '🈸', '🈺', '🈷️', '✴️', '🆚', '💮', '🉐', '㊙️',
    '㊗️', '🈴', '🈵', '🈹', '🈲', '🅰️', '🅱️', '🆎', '🆑', '🅾️',
    '🆘', '❌', '⭕', '🛑', '⛔', '📛', '🚫', '💯', '💢', '♨️'
  ],
  'Flags': [
    '🏁', '🚩', '🎌', '🏴', '🏳️', '🏳️‍🌈', '🏳️‍⚧️', '🏴‍☠️', '🇦🇨', '🇦🇩',
    '🇦🇪', '🇦🇫', '🇦🇬', '🇦🇮', '🇦🇱', '🇦🇲', '🇦🇴', '🇦🇶', '🇦🇷', '🇦🇸',
    '🇦🇹', '🇦🇺', '🇦🇼', '🇦🇽', '🇦🇿', '🇧🇦', '🇧🇧', '🇧🇩', '🇧🇪', '🇧🇫',
    '🇧🇬', '🇧🇭', '🇧🇮', '🇧🇯', '🇧🇱', '🇧🇲', '🇧🇳', '🇧🇴', '🇧🇶', '🇧🇷',
    '🇧🇸', '🇧🇹', '🇧🇻', '🇧🇼', '🇧🇾', '🇧🇿', '🇨🇦', '🇨🇨', '🇨🇩', '🇨🇫',
    '🇨🇬', '🇨🇭', '🇨🇮', '🇨🇰', '🇨🇱', '🇨🇲', '🇨🇳', '🇨🇴', '🇨🇵', '🇨🇷',
    '🇨🇺', '🇨🇻', '🇨🇼', '🇨🇽', '🇨🇾', '🇨🇿', '🇩🇪', '🇩🇬', '🇩🇯', '🇩🇰',
    '🇩🇲', '🇩🇴', '🇩🇿', '🇪🇦', '🇪🇨', '🇪🇪', '🇪🇬', '🇪🇭', '🇪🇷', '🇪🇸'
  ]
};

function setupFileUpload() {
  // Main chat file upload
  const attachButton = document.getElementById('attachButton');
  const fileInput = document.getElementById('fileInput');

  if (attachButton && fileInput) {
    attachButton.addEventListener('click', () => {
      isDmUpload = false;
      fileInput.click();
    });

    fileInput.addEventListener('change', handleFileSelection);
  }

  // DM file upload
  const dmAttachButton = document.getElementById('dmAttachButton');
  const dmFileInput = document.getElementById('dmFileInput');

  if (dmAttachButton && dmFileInput) {
    dmAttachButton.addEventListener('click', () => {
      isDmUpload = true;
      dmFileInput.click();
    });

    dmFileInput.addEventListener('change', handleFileSelection);
  }

  // Modal controls
  const closePreview = document.getElementById('closePreview');
  const cancelUpload = document.getElementById('cancelUpload');
  const confirmUpload = document.getElementById('confirmUpload');

  if (closePreview) closePreview.addEventListener('click', closeFilePreview);
  if (cancelUpload) cancelUpload.addEventListener('click', closeFilePreview);
  if (confirmUpload) confirmUpload.addEventListener('click', uploadSelectedFiles);
}

function setupCameraCapture() {
  // Main chat camera
  const cameraButton = document.getElementById('cameraButton');
  const cameraInput = document.getElementById('cameraInput');

  if (cameraButton && cameraInput) {
    cameraButton.addEventListener('click', () => {
      isDmUpload = false;
      cameraInput.click();
    });

    cameraInput.addEventListener('change', handleFileSelection);
  }

  // DM camera
  const dmCameraButton = document.getElementById('dmCameraButton');
  const dmCameraInput = document.getElementById('dmCameraInput');

  if (dmCameraButton && dmCameraInput) {
    dmCameraButton.addEventListener('click', () => {
      isDmUpload = true;
      dmCameraInput.click();
    });

    dmCameraInput.addEventListener('change', handleFileSelection);
  }
}

function handleFileSelection(event) {
  const files = Array.from(event.target.files);

  if (files.length === 0) return;

  // Validate file sizes (max 10MB per file)
  const maxSize = 10 * 1024 * 1024; // 10MB
  const validFiles = [];

  for (const file of files) {
    if (file.size > maxSize) {
      showNotification(`File "${file.name}" is too large. Max size is 10MB.`, "error");
      continue;
    }
    validFiles.push(file);
  }

  if (validFiles.length === 0) {
    event.target.value = ''; // Clear the input
    return;
  }

  selectedFiles = validFiles;
  showFilePreview();
  event.target.value = ''; // Clear the input
}

function showFilePreview() {
  const modal = document.getElementById('filePreviewModal');
  const container = document.getElementById('filePreviewContainer');

  if (!modal || !container) return;

  container.innerHTML = '';

  selectedFiles.forEach((file, index) => {
    const previewItem = document.createElement('div');
    previewItem.className = 'file-preview-item';

    const removeBtn = document.createElement('button');
    removeBtn.className = 'file-remove';
    removeBtn.innerHTML = '×';
    removeBtn.onclick = () => removeFile(index);

    if (file.type.startsWith('image/')) {
      const img = document.createElement('img');
      img.src = URL.createObjectURL(file);
      img.onload = () => URL.revokeObjectURL(img.src);
      previewItem.appendChild(img);
    } else if (file.type.startsWith('video/')) {
      const video = document.createElement('video');
      video.src = URL.createObjectURL(file);
      video.controls = true;
      video.muted = true;
      previewItem.appendChild(video);
    } else {
      const fileIcon = document.createElement('div');
      fileIcon.className = 'file-icon';

      if (file.type.startsWith('audio/')) {
        fileIcon.innerHTML = '<i class="fas fa-music"></i>';
      } else if (file.type.includes('pdf')) {
        fileIcon.innerHTML = '<i class="fas fa-file-pdf"></i>';
      } else if (file.type.includes('document') || file.type.includes('word')) {
        fileIcon.innerHTML = '<i class="fas fa-file-word"></i>';
      } else if (file.type.includes('text')) {
        fileIcon.innerHTML = '<i class="fas fa-file-alt"></i>';
      } else {
        fileIcon.innerHTML = '<i class="fas fa-file"></i>';
      }

      previewItem.appendChild(fileIcon);
    }

    const fileInfo = document.createElement('div');
    fileInfo.className = 'file-info';
    fileInfo.innerHTML = `
      <div>${file.name}</div>
      <div>${formatFileSize(file.size)}</div>
    `;

    previewItem.appendChild(fileInfo);
    previewItem.appendChild(removeBtn);
    container.appendChild(previewItem);
  });

  modal.style.display = 'flex';
}

function removeFile(index) {
  selectedFiles.splice(index, 1);
  if (selectedFiles.length === 0) {
    closeFilePreview();
  } else {
    showFilePreview();
  }
}

function closeFilePreview() {
  const modal = document.getElementById('filePreviewModal');
  if (modal) {
    modal.style.display = 'none';
  }
  selectedFiles = [];
}

function uploadSelectedFiles() {
  if (selectedFiles.length === 0) return;

  selectedFiles.forEach(file => {
    uploadFile(file);
  });

  closeFilePreview();
}

function uploadFile(file) {
  const reader = new FileReader();

  reader.onload = function(e) {
    const fileData = {
      name: file.name,
      size: file.size,
      type: file.type,
      data: e.target.result
    };

    if (isDmUpload && dmRecipient) {
      // Send file via direct message
      if (socket) {
        socket.emit('file_message', {
          sender: currentUsername,
          recipient: dmRecipient,
          file: fileData,
          isDm: true
        });
      }
    } else if (currentRoom) {
      // Send file to room
      if (socket) {
        socket.emit('file_message', {
          username: currentUsername,
          room: currentRoom,
          file: fileData,
          isDm: false
        });
      }
    }
  };

  reader.readAsDataURL(file);
}

function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function displayFileMessage(data, isDm = false) {
  const messagesDiv = isDm ? document.getElementById('dm-messages') : document.getElementById("messages");
  if (!messagesDiv) return;

  const messageDiv = document.createElement("div");
  messageDiv.className = `message-container ${data.username === currentUsername || data.sender === currentUsername ? 'me' : 'them'}`;

  const bubble = document.createElement("div");
  bubble.className = `message-bubble ${data.username === currentUsername || data.sender === currentUsername ? 'me' : 'them'}`;

  const header = document.createElement("div");
  header.className = "message-header";
  header.innerText = data.username || data.sender;

  const fileContainer = document.createElement("div");
  fileContainer.className = "file-message";

  const file = data.file;
  const fileAttachment = document.createElement("div");
  fileAttachment.className = "file-attachment";

  if (file.type.startsWith('image/')) {
    const img = document.createElement('img');
    img.src = file.data;
    img.alt = file.name;
    img.style.cursor = 'pointer';
    img.onclick = () => openFileInNewTab(file.data, file.name);
    fileAttachment.appendChild(img);
  } else if (file.type.startsWith('video/')) {
    const video = document.createElement('video');
    video.src = file.data;
    video.controls = true;
    video.preload = 'metadata';
    fileAttachment.appendChild(video);
  } else {
    const fileIcon = document.createElement('div');
    fileIcon.className = 'file-type-icon';

    if (file.type.startsWith('audio/')) {
      fileIcon.innerHTML = '<i class="fas fa-music"></i>';
    } else if (file.type.includes('pdf')) {
      fileIcon.innerHTML = '<i class="fas fa-file-pdf"></i>';
    } else if (file.type.includes('document') || file.type.includes('word')) {
      fileIcon.innerHTML = '<i class="fas fa-file-word"></i>';
    } else if (file.type.includes('text')) {
      fileIcon.innerHTML = '<i class="fas fa-file-alt"></i>';
    } else {
      fileIcon.innerHTML = '<i class="fas fa-file"></i>';
    }

    const fileDetails = document.createElement('div');
    fileDetails.className = 'file-details';
    fileDetails.innerHTML = `
      <div class="file-name">${file.name}</div>
      <div class="file-size">${formatFileSize(file.size)}</div>
    `;

    fileAttachment.appendChild(fileIcon);
    fileAttachment.appendChild(fileDetails);
    fileAttachment.style.cursor = 'pointer';
    fileAttachment.onclick = () => downloadFile(file.data, file.name);
  }

  const timestamp = document.createElement("div");
  timestamp.className = "message-timestamp";
  timestamp.innerText = new Date(data.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  fileContainer.appendChild(fileAttachment);
  bubble.appendChild(header);
  bubble.appendChild(fileContainer);
  bubble.appendChild(timestamp);

  messageDiv.appendChild(bubble);
  messagesDiv.appendChild(messageDiv);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

function openFileInNewTab(dataUrl, filename) {
  // For images, show in modal viewer instead of opening in new tab
  if (filename.match(/\.(jpg|jpeg|png|gif|webp|svg)$/i)) {
    showImageViewer(dataUrl, filename);
  } else {
    const link = document.createElement('a');
    link.href = dataUrl;
    link.target = '_blank';
    link.download = filename;
    link.click();
  }
}

function showImageViewer(imageSrc, filename) {
  // Create image viewer modal
  const modal = document.createElement('div');
  modal.className = 'image-viewer-modal';
  modal.innerHTML = `
    <div class="image-viewer-content">
      <div class="image-viewer-header">
        <span class="image-filename">${filename}</span>
        <button class="image-viewer-close">&times;</button>
      </div>
      <div class="image-viewer-body">
        <img src="${imageSrc}" alt="${filename}" class="image-viewer-img">
      </div>
      <div class="image-viewer-actions">
        <button class="btn secondary" onclick="downloadFile('${imageSrc}', '${filename}')">
          <i class="fas fa-download"></i> Download
        </button>
      </div>
    </div>
  `;

  // Close modal functionality
  const closeModal = () => {
    document.body.removeChild(modal);
  };

  modal.addEventListener('click', (e) => {
    if (e.target === modal || e.target.classList.contains('image-viewer-close')) {
      closeModal();
    }
  });

  // ESC key to close
  const handleEsc = (e) => {
    if (e.key === 'Escape') {
      closeModal();
      document.removeEventListener('keydown', handleEsc);
    }
  };
  document.addEventListener('keydown', handleEsc);

  document.body.appendChild(modal);
}

function downloadFile(dataUrl, filename) {
  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = filename;
  link.click();
}

// Emoji picker functionality
function setupEmojiPicker() {
  const emojiButton = document.getElementById('emojiButton');
  const dmEmojiButton = document.getElementById('dmEmojiButton');

  if (emojiButton) {
    emojiButton.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleEmojiPicker(false); // false for main chat
    });
  }

  if (dmEmojiButton) {
    dmEmojiButton.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleEmojiPicker(true); // true for DM
    });
  }

  // Close emoji picker when clicking outside
  document.addEventListener('click', (e) => {
    if (isEmojiPickerOpen && emojiPicker && !emojiPicker.contains(e.target)) {
      const emojiButtons = document.querySelectorAll('#emojiButton, #dmEmojiButton');
      let clickedEmojiButton = false;
      emojiButtons.forEach(btn => {
        if (btn && btn.contains(e.target)) {
          clickedEmojiButton = true;
        }
      });

      if (!clickedEmojiButton) {
        hideEmojiPicker();
      }
    }
  });
}

function toggleEmojiPicker(isDm = false) {
  if (isEmojiPickerOpen) {
    hideEmojiPicker();
  } else {
    showEmojiPicker(isDm);
  }
}

function showEmojiPicker(isDm = false) {
  if (emojiPicker) {
    emojiPicker.remove();
  }

  emojiPicker = createEmojiPicker(isDm);
  document.body.appendChild(emojiPicker);

  // Position the picker
  const targetButton = isDm ? document.getElementById('dmEmojiButton') : document.getElementById('emojiButton');
  if (targetButton) {
    const rect = targetButton.getBoundingClientRect();
    const pickerHeight = 320;
    const pickerWidth = 300;

    // Position above the button if there's not enough space below
    if (rect.bottom + pickerHeight > window.innerHeight) {
      emojiPicker.style.bottom = `${window.innerHeight - rect.top + 5}px`;
    } else {
      emojiPicker.style.top = `${rect.bottom + 5}px`;
    }

    // Center horizontally relative to button, but keep within viewport
    let left = rect.left + (rect.width / 2) - (pickerWidth / 2);
    left = Math.max(10, Math.min(left, window.innerWidth - pickerWidth - 10));
    emojiPicker.style.left = `${left}px`;
  }

  isEmojiPickerOpen = true;
}

function hideEmojiPicker() {
  if (emojiPicker) {
    emojiPicker.remove();
    emojiPicker = null;
  }
  isEmojiPickerOpen = false;
}

function createEmojiPicker(isDm = false) {
  const picker = document.createElement('div');
  picker.className = 'emoji-picker';

  // Search input
  const searchContainer = document.createElement('div');
  searchContainer.className = 'emoji-search-container';

  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Search emojis...';
  searchInput.className = 'emoji-search';
  searchInput.addEventListener('input', (e) => filterEmojis(e.target.value));

  searchContainer.appendChild(searchInput);
  picker.appendChild(searchContainer);

  // Category tabs
  const tabsContainer = document.createElement('div');
  tabsContainer.className = 'emoji-tabs';

  const categories = Object.keys(emojiData);
  categories.unshift('Recent'); // Add recent category at the beginning

  categories.forEach((category, index) => {
    const tab = document.createElement('button');
    tab.className = `emoji-tab ${index === 0 ? 'active' : ''}`;
    tab.textContent = getCategoryIcon(category);
    tab.title = category;
    tab.addEventListener('click', () => switchEmojiCategory(category, tab));
    tabsContainer.appendChild(tab);
  });

  picker.appendChild(tabsContainer);

  // Emoji grid container
  const gridContainer = document.createElement('div');
  gridContainer.className = 'emoji-grid-container';
  gridContainer.id = 'emojiGridContainer';

  picker.appendChild(gridContainer);

  // Show recent emojis by default
  showEmojiCategory('Recent', isDm);

  return picker;
}

function getCategoryIcon(category) {
  const icons = {
    'Recent': '🕒',
    'Smileys & People': '😀',
    'Animals & Nature': '🐶',
    'Food & Drink': '🍎',
    'Activities': '⚽',
    'Travel & Places': '🚗',
    'Objects': '💡',
    'Symbols': '❤️',
    'Flags': '🏁'
  };
  return icons[category] || '😀';
}

function switchEmojiCategory(category, activeTab) {
  // Update active tab
  document.querySelectorAll('.emoji-tab').forEach(tab => tab.classList.remove('active'));
  activeTab.classList.add('active');

  // Show category emojis
  const isDm = emojiPicker.closest('.direct-messaging') !== null;
  showEmojiCategory(category, isDm);
}

function showEmojiCategory(category, isDm = false) {
  const container = document.getElementById('emojiGridContainer');
  if (!container) return;

  container.innerHTML = '';

  let emojis = [];
  if (category === 'Recent') {
    emojis = recentEmojis;
    if (emojis.length === 0) {
      container.innerHTML = '<div class="emoji-empty">No recent emojis</div>';
      return;
    }
  } else {
    emojis = emojiData[category] || [];
  }

  const grid = document.createElement('div');
  grid.className = 'emoji-grid';

  emojis.forEach(emoji => {
    const emojiBtn = document.createElement('button');
    emojiBtn.className = 'emoji-btn';
    emojiBtn.textContent = emoji;
    emojiBtn.title = emoji;
    emojiBtn.addEventListener('click', () => insertEmoji(emoji, isDm));
    grid.appendChild(emojiBtn);
  });

  container.appendChild(grid);
}

function filterEmojis(searchTerm) {
  if (!searchTerm.trim()) {
    showEmojiCategory('Recent');
    return;
  }

  const container = document.getElementById('emojiGridContainer');
  if (!container) return;

  container.innerHTML = '';

  // Search through all categories
  const allEmojis = [];
  Object.values(emojiData).forEach(categoryEmojis => {
    allEmojis.push(...categoryEmojis);
  });

  // Simple search - could be enhanced with emoji names/keywords
  const filteredEmojis = allEmojis.filter(emoji => 
    emoji.includes(searchTerm.toLowerCase()) || 
    getEmojiKeywords(emoji).some(keyword => 
      keyword.toLowerCase().includes(searchTerm.toLowerCase())
    )
  );

  if (filteredEmojis.length === 0) {
    container.innerHTML = '<div class="emoji-empty">No emojis found</div>';
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'emoji-grid';

  filteredEmojis.slice(0, 50).forEach(emoji => { // Limit results
    const emojiBtn = document.createElement('button');
    emojiBtn.className = 'emoji-btn';
    emojiBtn.textContent = emoji;
    emojiBtn.title = emoji;
    emojiBtn.addEventListener('click', () => insertEmoji(emoji));
    grid.appendChild(emojiBtn);
  });

  container.appendChild(grid);
}

function getEmojiKeywords(emoji) {
  // Basic keyword mapping - could be expanded
  const keywordMap = {
    '😀': ['happy', 'smile', 'joy'],
    '😂': ['laugh', 'crying', 'funny'],
    '❤️': ['love', 'heart', 'red'],
    '👍': ['thumbs', 'up', 'good', 'like'],
    '👎': ['thumbs', 'down', 'bad', 'dislike'],
    '🔥': ['fire', 'hot', 'lit'],
    '💯': ['hundred', 'perfect', 'score'],
    '🎉': ['party', 'celebration', 'confetti'],
    '🍕': ['pizza', 'food', 'italian'],
    '🚀': ['rocket', 'space', 'launch']
  };
  return keywordMap[emoji] || [];
}

function insertEmoji(emoji, isDm = false) {
  const input = isDm ? document.getElementById('dm-input') : document.getElementById('messageInput');
  if (!input) return;

  const cursorPos = input.selectionStart;
  const textBefore = input.value.substring(0, cursorPos);
  const textAfter = input.value.substring(input.selectionEnd);

  input.value = textBefore + emoji + textAfter;
  input.focus();

  // Set cursor position after the emoji
  const newCursorPos = cursorPos + emoji.length;
  input.setSelectionRange(newCursorPos, newCursorPos);

  // Add to recent emojis
  addToRecentEmojis(emoji);

  // Hide picker
  hideEmojiPicker();
}

function addToRecentEmojis(emoji) {
  // Remove if already exists
  recentEmojis = recentEmojis.filter(e => e !== emoji);

  // Add to beginning
  recentEmojis.unshift(emoji);

  // Keep only last 24 emojis
  recentEmojis = recentEmojis.slice(0, 24);

  // Save to localStorage
  localStorage.setItem('recentEmojis', JSON.stringify(recentEmojis));
}

// DM Search functionality
function toggleDMSearch() {
  // Implementation for DM search
  const searchContainer = document.querySelector('.dm-header .search-container');
  if (!searchContainer) {
    addDMSearchToHeader();
  } else {
    searchContainer.style.display = searchContainer.style.display === 'none' ? 'flex' : 'none';
  }
}

function addDMSearchToHeader() {
  const dmActions = document.querySelector('.dm-header .dm-actions');
  if (!dmActions) return;

  const searchContainer = document.createElement('div');
  searchContainer.className = 'search-container';
  searchContainer.innerHTML = `
    <input type="text" class="search-input" placeholder="Search DMs..." id="dmMessageSearch">
    <button class="search-btn" onclick="searchDMMessages()">
      <i class="fas fa-search"></i>
    </button>
  `;

  dmActions.insertBefore(searchContainer, dmActions.firstChild);

  const searchInput = document.getElementById('dmMessageSearch');
  if (searchInput) {
    searchInput.addEventListener('input', debounce(performDMSearch, 300));
    searchInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        performDMSearch();
      }
    });
  }
}

function performDMSearch() {
  const searchInput = document.getElementById('dmMessageSearch');
  if (!searchInput) return;

  const query = searchInput.value.trim().toLowerCase();
  const messages = document.querySelectorAll('#dm-messages .message-container');

  messages.forEach(msg => {
    const content = msg.querySelector('.message-content');
    if (content) {
      const text = content.textContent.toLowerCase();
      if (query && text.includes(query)) {
        msg.classList.add('search-highlight');
        msg.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else {
        msg.classList.remove('search-highlight');
      }
    }
  });
}
