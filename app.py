from flask import Flask, render_template, request
from flask_socketio import SocketIO, emit, join_room, leave_room
import os

app = Flask(__name__)
app.config['SECRET_KEY'] = 'videochat_secret_key_2026'

# Initialize SocketIO with support for async WebSocket framing
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='gevent' if 'gevent' in globals() else 'threading')

# In-memory storage for active room participants
# Format: { socket_id: { 'username': str, 'room': str, 'avatarColor': str, 'audio': bool, 'video': bool, 'handRaised': bool } }
users = {}

@app.route('/')
def index():
    return render_template('index.html')

@socketio.on('connect')
def handle_connect():
    print(f"Client connected: {request.sid}")

@socketio.on('join-room')
def handle_join_room(data):
    room = data.get('room', 'lounge').strip().lower()
    if not room:
        room = 'lounge'
        
    username = data.get('username', 'Anonymous').strip() or 'Anonymous'
    avatar_color = data.get('avatarColor', '#3b82f6')
    
    # Register user state
    users[request.sid] = {
        'username': username,
        'room': room,
        'avatarColor': avatar_color,
        'audio': True,
        'video': True,
        'handRaised': False
    }
    
    join_room(room)
    print(f"User '{username}' ({request.sid}) joined room '{room}'")
    
    # Collect existing users in this room (excluding current user)
    existing_peers = [
        {
            'sid': sid,
            'username': user_info['username'],
            'avatarColor': user_info['avatarColor'],
            'audio': user_info['audio'],
            'video': user_info['video'],
            'handRaised': user_info['handRaised']
        }
        for sid, user_info in users.items()
        if user_info['room'] == room and sid != request.sid
    ]
    
    # Send existing peers list to the newly connected user
    emit('existing-users', {
        'peers': existing_peers,
        'selfSid': request.sid,
        'room': room
    })
    
    # Notify other members in the room that a new user joined
    emit('user-joined', {
        'sid': request.sid,
        'username': username,
        'avatarColor': avatar_color,
        'audio': True,
        'video': True,
        'handRaised': False
    }, to=room, include_self=False)

@socketio.on('signal')
def handle_signal(data):
    target_sid = data.get('target')
    signal_data = data.get('signal')
    
    if target_sid and signal_data:
        sender_info = users.get(request.sid, {})
        emit('signal', {
            'sender': request.sid,
            'signal': signal_data,
            'username': sender_info.get('username', 'Peer'),
            'avatarColor': sender_info.get('avatarColor', '#3b82f6')
        }, to=target_sid)

@socketio.on('user-action')
def handle_user_action(data):
    user_info = users.get(request.sid)
    if not user_info:
        return
        
    action_type = data.get('type')
    action_value = data.get('value')
    room = user_info['room']
    
    if action_type == 'audio':
        user_info['audio'] = bool(action_value)
    elif action_type == 'video':
        user_info['video'] = bool(action_value)
    elif action_type == 'hand':
        user_info['handRaised'] = bool(action_value)
        
    # Broadcast action update to all peers in the room
    emit('peer-action', {
        'sid': request.sid,
        'type': action_type,
        'value': action_value,
        'username': user_info['username']
    }, to=room, include_self=False)

@socketio.on('chat-message')
def handle_chat_message(data):
    user_info = users.get(request.sid)
    if not user_info:
        return
        
    room = user_info['room']
    message_text = data.get('message', '').strip()
    
    if message_text:
        emit('chat-message', {
            'senderSid': request.sid,
            'username': user_info['username'],
            'avatarColor': user_info['avatarColor'],
            'message': message_text,
            'timestamp': data.get('timestamp')
        }, to=room)

@socketio.on('disconnect')
def handle_disconnect():
    user_info = users.pop(request.sid, None)
    if user_info:
        room = user_info['room']
        username = user_info['username']
        leave_room(room)
        print(f"User '{username}' ({request.sid}) disconnected from room '{room}'")
        
        # Notify room members that user left
        emit('user-left', {
            'sid': request.sid,
            'username': username
        }, to=room)

if __name__ == '__main__':
    print("Starting Group Video Call Server on http://127.0.0.1:5000")
    socketio.run(app, host='0.0.0.0', port=5000, debug=True, allow_unsafe_werkzeug=True)

