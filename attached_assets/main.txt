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
  document.querySelector('.hamburger').addEventListener('click', toggleMenu);

  // Disable message input and send button initially
  updateChatInputState(false);

  // Initialize Socket.IO connection
  initializeSocket();

  // Add direct messaging UI if not already added
  setupDirectMessagingUI();

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

  // Setup DM message input event listeners
  const dmInput = document.getElementById('dm-input');
  if (dmInput) {
    dmInput.addEventListener('keypress', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        sendDirectMessage();
      }
    });
  }
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

  // Check if room exists and if it's private
  fetch(`/check_room/${room}`)
  .then(res => res.json())
  .then(data => {
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
        displayMessage({
            username: msg.sender,
            message: msg.message,
            timestamp: msg.timestamp
          }, true);
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
