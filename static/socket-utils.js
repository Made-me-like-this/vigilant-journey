// Socket.io connection
let socket;
let currentRoom = '';
let currentUsername = '';

// Reconnection variables
let reconnectAttempts = 0;
const maxReconnectAttempts = 5;

// Reconnection with exponential backoff
let reconnectTimer = null;

function reconnectWithBackoff() {
  if (socket && socket.connected) return;

  const baseDelay = 1000;
  const maxDelay = 5000;
  const currentDelay = Math.min(baseDelay * Math.pow(2, reconnectAttempts), maxDelay);

  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    if (reconnectAttempts < maxReconnectAttempts) {
      console.log(`Attempting to reconnect (${reconnectAttempts + 1}/${maxReconnectAttempts})...`);
      socket.connect();
      reconnectAttempts++;
    } else {
      showNotification("Unable to reconnect. Please refresh the page.", "error");
    }
  }, currentDelay);
}

function initializeSocket() {
  socket = io();
  setupSocketListeners();
  console.log("Socket.IO initialized");
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

function sendMessage() {
  const messageInput = document.getElementById("messageInput");
  const message = messageInput.value.trim();
  if (message && socket && currentRoom) {
    socket.emit('message', { username: currentUsername, room: currentRoom, message: message });
    messageInput.value = "";
    messageInput.focus();
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

let typingTimer = null;

function handleTypingEvent() {
  if (socket && currentRoom) {
    socket.emit('typing', { username: currentUsername, room: currentRoom });
  }
}

function stareAtMessage(username) {
  if (socket && currentRoom) {
    socket.emit('staring', { username: currentUsername, target: username, room: currentRoom });
    showNotification(`You are staring at ${username}'s message...`, "info");
  }
}
