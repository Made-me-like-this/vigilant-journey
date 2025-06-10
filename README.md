
# ChatterHub - Real-time Chat Application

A modern, responsive chat application with public and private rooms, direct messaging, and profile customization.

## Features

- 💬 Public and private chat rooms
- 📱 Responsive design for all devices
- 🔒 Private messaging system
- 👤 Customizable user profiles
- 👀 Interactive "staring" feature
- 🎨 Modern, clean interface

## Quick Start

1. Install dependencies:
```bash
pip install -r requirements.txt
```

2. Run with Python (Development):
```bash
python main.py
```

3. Run with Gunicorn (Production):
```bash
gunicorn --worker-class=gevent --workers=1 --bind 0.0.0.0:5000 --timeout 120 main:app
```

The application will be available at `http://0.0.0.0:5000`

## Using ChatterHub

1. **Set Your Profile**
   - Enter your username
   - Click the avatar icon to upload a profile picture

2. **Join a Room**
   - Join existing public rooms like "general" or "tech_talk"
   - Create your own room (public or private)
   - Private rooms require a secret key to join

3. **Chatting**
   - Send messages in rooms
   - Use direct messaging by clicking on usernames
   - Try the "stare" feature by clicking the eye icon on messages

4. **Room Management**
   - Create new rooms from the sidebar
   - Set rooms as private with custom access keys
   - Leave rooms using the exit button

## Default Rooms

- `general` - Public room for general discussion
- `tech_talk` - Public room for technical discussions
- `dev_group` - Private room (default key: "1234")

## Contributing

Feel free to submit issues and enhancement requests!
