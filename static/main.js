// Socket.io connection
let socket;
let currentRoom = '';
let currentUsername = '';

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

// Reconnection with exponential backoff
let reconnectTimer = null;
let dmRecipient = '';
let onlineUsers = [];

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
      </div>
    </header>
    <div class="dm-messages" id="dm-messages"></div>
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
  }
}

function closeDM() {
  const dmEl = document.getElementById('direct-messaging');
  const chatEl = document.getElementById('chat');
  if (dmEl && chatEl) {
    dmEl.style.display = 'none';
    chatEl.style.display = 'flex';
    dmRecipient = '';
  }
}

function reconnectWithBackoff() {
  if (socket && socket.connected) return;

  const baseDelay = 1000;  // Start with 1 second
  const maxDelay = 5000;   // Max 5 seconds between attempts
  const currentDelay = Math.min(baseDelay * Math.pow(2, reconnectAttempts), maxDelay);

  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    if (reconnectAttempts < maxReconnectAttempts) {
      console.log(`Attempting to reconnect (<span class="math-inline">\{reconnectAttempts \+ 1\}/</span>{maxReconnectAttempts})...`);
      socket.connect();
      reconnectAttempts++;
    } else {
      showNotification("Unable to reconnect. Please refresh the page.", "error");
    }
  }, currentDelay);
}

// Menu functionality
function toggleMenu() {
  const sidebar = document.querySelector('.sidebar');
  sidebar.classList.toggle('open');
  // Change hamburger icon to close icon
  const hamburger = document.querySelector('.hamburger');
  hamburger.classList.toggle('active');
}

// Initialize the app
document.addEventListener('DOMContentLoaded', () => {
  // Add direct messaging UI first
  setupDirectMessagingUI();
  
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

  // Setup file upload functionality
  setupFileUpload();
  setupCameraCapture();
  
  // Setup emoji functionality
  setupEmojiPicker();
});

// Initialize Socket.IO
function initializeSocket() {
  socket = io();
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
    updateChatInputState(false);
    showNotification("Left the room", "info");
  }
}

function setupSocketListeners() {
  // Using global reconnect variables defined earlier

  socket.on('connect', () => {
    console.log('Connected to Socket.IO server');
    reconnectAttempts = 0;
    updateChatInputState(true);

    // Rejoin room if we were in one
    if (currentRoom && currentUsername) {
      socket.emit('join', { username: currentUsername, room: currentRoom });
    } else {
      showNotification("Welcome to ChatterHub!", "info"); // Initial welcome
    }
  });

  socket.on('connect_error', (error) => {
    console.error('Connection error:', error);
    updateChatInputState(false);
    showNotification("Connection error. Retrying...", "warning");
  });

  socket.on('disconnect', (reason) => {
    console.log('Disconnected:', reason);
    updateChatInputState(false);

    if (reason === 'io server disconnect') {
      // Server initiated disconnect, don't reconnect automatically
      showNotification("Disconnected by server. Please refresh.", "error");
    } else {
      // Attempt to reconnect
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
  });

  socket.on('user_joined', (data) => {
    addSystemMessage(`${data.username} joined the room`);
    updateUsersList();
  });

  socket.on('user_left', (data) => {
    addSystemMessage(`${data.username} left the room`);
    updateUsersList();
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

  socket.on('room_not_found', (data) => {
    showNotification(`Room ${data.room} not found`, "error");
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

      // Add visual effect to indicate someone is staring
      const staringIndicator = document.createElement("div");
      staringIndicator.className = "staring-indicator";
      staringIndicator.innerHTML = '<i class="fas fa-eye"></i>';
      document.body.appendChild(staringIndicator);

      // Remove indicator after 3 seconds
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
    // Show typing indicator
    showTypingIndicator(data.username);
  });

  // Direct Messaging Socket Listeners
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
    }
  });

  socket.on('dm_history', (data) => {
    const dmMessages = document.getElementById('dm-messages');
    if (dmMessages) {
      dmMessages.innerHTML = '';
      if (data.history && data.history.length > 0) {
        data.history.forEach(msg => {
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
  chatEl.style.display = 'none';
  dmEl.style.display = 'flex';
  dmInput.disabled = false;
  dmSendBtn.disabled = false;
  dmInput.focus();

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
    socket.emit('get_dm_history', { user1: currentUsername, user2: username });
  }
}

function sendDirectMessage() {
  const dmInput = document.getElementById('dm-input');
  const message = dmInput.value.trim();

  if (message && socket && dmRecipient) {
    socket.emit('direct_message', { sender: currentUsername, recipient: dmRecipient, message: message });
    dmInput.value = '';
    dmInput.focus();
  }
}

function sendMessage() {
  const messageInput = document.getElementById("messageInput");
  const message = messageInput.value.trim();
  if (message && socket && currentRoom) {
    socket.emit('message', { username: currentUsername, room: currentRoom, message: message });
    messageInput.value = "";
    messageInput.focus();
  }
}

let typingTimer = null;

function handleTypingEvent() {
  if (socket && currentRoom) {
    socket.emit('typing', { username: currentUsername, room: currentRoom });
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

  typingDiv.innerHTML = `${username} is typing...`;
  typingDiv.style.display = "block";

  // Clear previous timer
  if (typingTimer) clearTimeout(typingTimer);

  // Hide indicator after 2 seconds
  typingTimer = setTimeout(() => {
    typingDiv.style.display = "none";
  }, 2000);
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

function displayMessage(data, isDm = false) {
  const messagesDiv = isDm ? document.getElementById('dm-messages') : document.getElementById("messages");
  if (!messagesDiv) {
    console.error(`Messages container not found for ${isDm ? 'direct' : 'room'} message`);
    return;
  }

  const messageDiv = document.createElement("div");
  messageDiv.className = `message-container ${data.username === currentUsername ? 'me' : 'them'}`;

  const bubble = document.createElement("div");
  bubble.className = `message-bubble ${data.username === currentUsername ? 'me' : 'them'}`;

  const header = document.createElement("div");
  header.className = "message-header";
  header.innerText = data.username;

  const content = document.createElement("div");
  content.className = "message-content";
  content.innerText = data.message;

  const timestamp = document.createElement("div");
  timestamp.className = "message-timestamp";
  timestamp.innerText = new Date(data.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  bubble.appendChild(header);
  bubble.appendChild(content);
  bubble.appendChild(timestamp);

  if (data.username !== currentUsername && data.username !== 'System' && !isDm) {
    const stareBtn = document.createElement("button");
    stareBtn.className = "stare-btn";
    stareBtn.innerHTML = '<i class="fas fa-eye"></i>';
    stareBtn.title = "Stare at this message";
    stareBtn.addEventListener('click', () => stareAtMessage(data.username));
    bubble.appendChild(stareBtn);
  }

  messageDiv.appendChild(bubble);
  messagesDiv.appendChild(messageDiv);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
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
    '🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🍈', '🍒',
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
