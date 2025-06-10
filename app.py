from flask import Flask, render_template, request, jsonify, send_from_directory
from flask_socketio import SocketIO, join_room, leave_room, emit
from flask_sqlalchemy import SQLAlchemy
import secrets
import os
import time
import json
from datetime import datetime
import logging

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Initialize Flask app
app = Flask(__name__)
app.config['SECRET_KEY'] = os.environ.get("SESSION_SECRET", secrets.token_hex(16))
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///chat.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

# Initialize database
db = SQLAlchemy(app)

# Define models
class ChatRoom(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), unique=True, nullable=False)
    private = db.Column(db.Boolean, default=False)
    key = db.Column(db.String(100), nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

class Message(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    room_name = db.Column(db.String(100), nullable=True)
    sender = db.Column(db.String(100), nullable=False)
    recipient = db.Column(db.String(100), nullable=True)
    message = db.Column(db.Text, nullable=False)
    is_dm = db.Column(db.Boolean, default=False)
    system = db.Column(db.Boolean, default=False)
    timestamp = db.Column(db.Float, default=time.time)

# Initialize SocketIO
socketio = SocketIO(app, cors_allowed_origins="*")

# In-memory data structures
rooms = {}
user_sessions = {}
online_users = set()
dm_history = {}
MAX_ROOM_SIZE = 50

# Setup database
with app.app_context():
    db.create_all()
    
    # Initialize default rooms if they don't exist
    if not ChatRoom.query.filter_by(name="general").first():
        general = ChatRoom(name="general", private=False)
        tech_talk = ChatRoom(name="tech_talk", private=False)
        dev_group = ChatRoom(name="dev_group", private=True, key="1234")
        
        db.session.add_all([general, tech_talk, dev_group])
        db.session.commit()
    
    # Load rooms from database to memory
    for room in ChatRoom.query.all():
        rooms[room.name] = {
            "private": room.private,
            "users": set(),
            "created_at": room.created_at.isoformat()
        }
        
        if room.private and room.key:
            rooms[room.name]["key"] = room.key

# Routes
@app.route('/')
def index():
    return render_template('index.html')

@app.route('/static/<path:filename>')
def serve_static(filename):
    return send_from_directory('static', filename)

@app.route('/create_room', methods=['POST'])
def create_room():
    try:
        data = request.json
        name = data.get('name')
        is_private = data.get('isPrivate', False)
        key = data.get('key', '')
        
        if not name:
            return jsonify({'success': False, 'message': 'Room name is required'})
        
        if name in rooms:
            return jsonify({'success': False, 'message': 'Room already exists'})
        
        # Create in database
        new_room = ChatRoom(
            name=name,
            private=is_private,
            key=key if is_private and key else None
        )
        db.session.add(new_room)
        db.session.commit()
        
        # Add to in-memory structure
        rooms[name] = {
            'private': is_private,
            'users': set(),
            'created_at': datetime.now().isoformat()
        }
        
        if is_private and key:
            rooms[name]['key'] = key
        
        return jsonify({'success': True, 'message': 'Room created successfully'})
    except Exception as e:
        logger.error(f"Error creating room: {str(e)}")
        return jsonify({'success': False, 'message': str(e)})

@app.route('/rooms', methods=['GET'])
def get_rooms():
    try:
        # Return only public rooms
        public_rooms = [
            {'name': room_name, 'private': room_data['private']} 
            for room_name, room_data in rooms.items() 
            if not room_data['private']
        ]
        return jsonify(public_rooms)
    except Exception as e:
        logger.error(f"Error getting rooms: {str(e)}")
        return jsonify([])

@app.route('/join_private', methods=['POST'])
def join_private():
    try:
        data = request.json
        room = data.get('room')
        key = data.get('key')
        
        if not room or room not in rooms:
            return jsonify({'success': False, 'message': 'Room not found'})
        
        if not rooms[room]['private']:
            return jsonify({'success': True, 'message': 'Room is public'})
        
        # Check key
        if rooms[room].get('key') != key:
            return jsonify({'success': False, 'message': 'Invalid key'})
        
        return jsonify({'success': True, 'message': 'Key accepted'})
    except Exception as e:
        logger.error(f"Error joining private room: {str(e)}")
        return jsonify({'success': False, 'message': str(e)})

@app.route('/check_room/<room>', methods=['GET'])
def check_room(room):
    try:
        if room not in rooms:
            return jsonify({'exists': False})
        
        return jsonify({
            'exists': True,
            'private': rooms[room]['private'],
            'user_count': len(rooms[room]['users'])
        })
    except Exception as e:
        logger.error(f"Error checking room: {str(e)}")
        return jsonify({'exists': False, 'error': str(e)})

# Socket.IO event handlers
@socketio.on('connect')
def handle_connect():
    emit('connection_established', {'status': 'connected'})

@socketio.on('disconnect')
def handle_disconnect():
    for username, session_id in list(user_sessions.items()):
        if session_id == request.sid:
            online_users.discard(username)
            user_sessions.pop(username, None)
            emit('user_offline', {'username': username}, broadcast=True)
            break

@socketio.on('join')
def on_join(data):
    try:
        username = data.get('username')
        room = data.get('room')

        if not username or not room or room not in rooms:
            return

        if len(rooms[room]['users']) >= MAX_ROOM_SIZE:
            emit('room_full', {'room': room})
            return

        join_room(room)
        rooms[room]['users'].add(username)
        user_sessions[username] = request.sid
        online_users.add(username)

        # Send current users list
        emit('users_list', {
            'users': list(rooms[room]['users']),
            'room': room
        })

        # Notify room
        emit('user_joined', {
            'username': username,
            'count': len(rooms[room]['users']),
            'timestamp': time.time()
        }, to=room)

        # Welcome message
        welcome_msg = {
            'username': 'System',
            'message': f'Welcome to {room}, {username}!',
            'timestamp': time.time(),
            'system': True
        }
        emit('message', welcome_msg, to=room)
        
        # Save system message to database
        system_msg = Message(
            room_name=room,
            sender='System',
            message=f'Welcome to {room}, {username}!',
            is_dm=False,
            system=True,
            timestamp=time.time()
        )
        db.session.add(system_msg)
        db.session.commit()

    except Exception as e:
        logger.error(f"Error in on_join: {str(e)}")
        emit('error', {'message': 'Failed to join room'})

@socketio.on('message')
def handle_message(data):
    try:
        username = data.get('username')
        room = data.get('room')
        message = data.get('message')

        if not all([username, room, message]) or room not in rooms:
            return
        
        # Validate message length and content
        message = message.strip()
        if len(message) > 1000:
            emit('error', {'message': 'Message too long (max 1000 characters)'})
            return
        
        if not message:
            return

        data['timestamp'] = time.time()
        
        # Save message to database
        new_message = Message(
            room_name=room,
            sender=username,
            message=message,
            is_dm=False,
            timestamp=data['timestamp']
        )
        db.session.add(new_message)
        db.session.commit()
        
        # Send message to all users in the room
        emit('message', data, to=room)
        
        # Add helpful system responses occasionally
        if "hello" in message.lower() or "hi" in message.lower() or "hey" in message.lower():
            # Send a system greeting after a short delay
            greeting_msg = {
                'username': 'System',
                'message': f"Hello {username}! Welcome to the {room} chat room. Feel free to ask if you need help!",
                'timestamp': time.time(),
                'system': True
            }
            
            # Add small delay to make it feel more natural
            time.sleep(1)
            emit('message', greeting_msg, to=room)
            
            # Save system response to database
            system_response = Message(
                room_name=room,
                sender='System',
                message=greeting_msg['message'],
                is_dm=False,
                system=True,
                timestamp=greeting_msg['timestamp']
            )
            db.session.add(system_response)
            db.session.commit()

    except Exception as e:
        logger.error(f"Error in handle_message: {str(e)}")
        emit('error', {'message': 'Failed to send message'})

@socketio.on('leave')
def on_leave(data):
    try:
        username = data.get('username')
        room = data.get('room')

        if not username or not room or room not in rooms:
            return

        leave_room(room)
        rooms[room]['users'].discard(username)

        emit('user_left', {
            'username': username,
            'count': len(rooms[room]['users']),
            'timestamp': time.time()
        }, to=room)

        if len(rooms[room]['users']) == 0 and rooms[room]['private']:
            del rooms[room]
            emit('room_deleted', {'room': room}, broadcast=True)

    except Exception as e:
        logger.error(f"Error in on_leave: {str(e)}")

@socketio.on('register_user')
def on_register_user(data):
    try:
        username = data.get('username')
        if not username:
            return
        
        user_sessions[username] = request.sid
        online_users.add(username)
        
        # Broadcast to all clients that this user is online
        emit('user_online', {'username': username}, broadcast=True)
    except Exception as e:
        logger.error(f"Error registering user: {str(e)}")

@socketio.on('get_online_users')
def on_get_online_users():
    try:
        emit('online_users', {'users': list(online_users)})
    except Exception as e:
        logger.error(f"Error sending online users: {str(e)}")

@socketio.on('direct_message')
def on_direct_message(data):
    try:
        sender = data.get('sender')
        recipient = data.get('recipient')
        message = data.get('message')
        
        if not all([sender, recipient, message]):
            return
        
        # Add timestamp
        data['timestamp'] = time.time()
        
        # Store in database
        new_dm = Message(
            sender=sender,
            recipient=recipient,
            message=message,
            is_dm=True,
            timestamp=data['timestamp']
        )
        db.session.add(new_dm)
        db.session.commit()
        
        # Store in memory for quick access
        dm_key = tuple(sorted([sender, recipient]))
        if dm_key not in dm_history:
            dm_history[dm_key] = []
        
        dm_history[dm_key].append({
            'sender': sender,
            'message': message,
            'timestamp': data['timestamp']
        })
        
        # Send to recipient if online
        if recipient in user_sessions:
            recipient_sid = user_sessions[recipient]
            emit('direct_message', data, to=recipient_sid)
            
            # Add system response for help message
            if "help" in message.lower():
                system_reply = {
                    'sender': 'System',
                    'recipient': sender,
                    'message': f'Hello {sender}! I see you\'re asking {recipient} for help. You can also find general help in the "general" room.',
                    'timestamp': time.time(),
                    'system': True
                }
                # Small delay for natural feel
                time.sleep(1)
                emit('direct_message', system_reply, to=user_sessions[sender])
                
                # Store system response
                system_dm = Message(
                    sender='System',
                    recipient=sender,
                    message=system_reply['message'],
                    is_dm=True,
                    system=True,
                    timestamp=system_reply['timestamp']
                )
                db.session.add(system_dm)
                db.session.commit()
        
        # Send confirmation to sender
        emit('direct_message', data)
        
    except Exception as e:
        logger.error(f"Error sending direct message: {str(e)}")

@socketio.on('get_dm_history')
def on_get_dm_history(data):
    try:
        user1 = data.get('user1')
        user2 = data.get('user2')
        
        if not user1 or not user2:
            return
        
        # Get history from database
        query = Message.query.filter(
            Message.is_dm == True,
            db.or_(
                db.and_(Message.sender == user1, Message.recipient == user2),
                db.and_(Message.sender == user2, Message.recipient == user1)
            )
        ).order_by(Message.timestamp).all()
        
        # Convert to list of dictionaries
        history = []
        for msg in query:
            try:
                # Try to parse as JSON (file message)
                json.loads(msg.message)
                history.append({
                    'sender': msg.sender,
                    'message': msg.message,
                    'timestamp': msg.timestamp,
                    'system': msg.system,
                    'file': True
                })
            except (json.JSONDecodeError, TypeError):
                # Regular text message
                history.append({
                    'sender': msg.sender,
                    'message': msg.message,
                    'timestamp': msg.timestamp,
                    'system': msg.system,
                    'file': False
                })
        
        # If no messages in database, check in-memory cache
        if not history:
            dm_key = tuple(sorted([user1, user2]))
            history = dm_history.get(dm_key, [])
        
        emit('dm_history', {'history': history})
        
        # Add a helpful system message if this is their first conversation
        if len(history) == 0:
            system_msg = {
                'sender': 'System',
                'recipient': user1,
                'message': f"This is the start of your direct message history with {user2}. Your messages are private and secure.",
                'timestamp': time.time(),
                'system': True
            }
            emit('direct_message', system_msg)
            
            # Save to database
            system_welcome = Message(
                sender='System',
                recipient=user1,
                message=system_msg['message'],
                is_dm=True,
                system=True,
                timestamp=system_msg['timestamp']
            )
            db.session.add(system_welcome)
            db.session.commit()
            
    except Exception as e:
        logger.error(f"Error getting DM history: {str(e)}")

@socketio.on('typing')
def handle_typing(data):
    try:
        username = data.get('username')
        room = data.get('room')
        
        if not username or not room:
            return
            
        emit('user_typing', {'username': username}, to=room)
    except Exception as e:
        logger.error(f"Error in handle_typing: {str(e)}")

@socketio.on('staring')
def on_staring(data):
    try:
        username = data.get('username')
        target = data.get('target') 
        room = data.get('room')
        
        if not all([username, target, room]):
            return
        
        # Find target user's session
        if target in user_sessions:
            target_sid = user_sessions[target]
            emit('staring_alert', {
                'username': username,
                'target': target,
                'timestamp': time.time()
            }, to=target_sid)
    except Exception as e:
        logger.error(f"Error in staring: {str(e)}")

@socketio.on('file_message')
def on_file_message(data):
    try:
        file_data = data.get('file')
        is_dm = data.get('isDm', False)
        
        if not file_data:
            return
        
        # Add timestamp
        data['timestamp'] = time.time()
        
        if is_dm:
            sender = data.get('sender')
            recipient = data.get('recipient')
            
            if not all([sender, recipient]):
                return
            
            # Store file message in database as JSON
            file_message = Message(
                sender=sender,
                recipient=recipient,
                message=json.dumps(file_data),
                is_dm=True,
                timestamp=data['timestamp']
            )
            db.session.add(file_message)
            db.session.commit()
            
            # Send to recipient if online
            if recipient in user_sessions:
                recipient_sid = user_sessions[recipient]
                emit('file_message', data, to=recipient_sid)
            
            # Send confirmation to sender
            emit('file_message', data)
            
        else:
            username = data.get('username')
            room = data.get('room')
            
            if not all([username, room]) or room not in rooms:
                return
            
            # Store file message in database as JSON
            file_message = Message(
                room_name=room,
                sender=username,
                message=json.dumps(file_data),
                is_dm=False,
                timestamp=data['timestamp']
            )
            db.session.add(file_message)
            db.session.commit()
            
            # Send to all users in the room
            emit('file_message', data, to=room)
            
    except Exception as e:
        logger.error(f"Error handling file message: {str(e)}")
        emit('error', {'message': 'Failed to send file'})

if __name__ == '__main__':
    socketio.run(app, host='0.0.0.0', port=5000, debug=False)
