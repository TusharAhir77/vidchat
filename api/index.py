from flask import Flask, render_template, request, jsonify
import os
import time

template_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'templates'))
static_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'static'))

app = Flask(__name__, template_folder=template_dir, static_folder=static_dir)
app.config['SECRET_KEY'] = 'videochat_secret_key_2026'

# In-memory peer registry for Vercel Serverless Function instances
rooms = {}

def cleanup_stale_peers(room_name):
    if room_name not in rooms:
        return
    now = time.time()
    # Remove peers inactive for more than 25 seconds
    stale_ids = [pid for pid, info in rooms[room_name].items() if now - info['last_seen'] > 25]
    for pid in stale_ids:
        del rooms[room_name][pid]

@app.after_request
def add_cors_headers(response):
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    return response

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/room', methods=['GET', 'POST', 'OPTIONS'])
def room_api():
    if request.method == 'OPTIONS':
        return jsonify({'status': 'ok'}), 200

    if request.method == 'POST':
        data = request.get_json(silent=True) or {}
        action = data.get('action')
        room = data.get('room', 'commonlounge').strip().lower()
        peer_id = data.get('peerId')

        if action == 'leave' and room in rooms and peer_id in rooms[room]:
            del rooms[room][peer_id]
            return jsonify({'status': 'left'})

    room = request.args.get('room', 'commonlounge').strip().lower()
    peer_id = request.args.get('peerId')
    username = request.args.get('username', 'Guest').strip()
    avatar_color = request.args.get('avatarColor', '#3b82f6')

    if room not in rooms:
        rooms[room] = {}

    cleanup_stale_peers(room)

    if peer_id:
        rooms[room][peer_id] = {
            'username': username,
            'avatarColor': avatar_color,
            'last_seen': time.time()
        }

    # Return active peers in the room except the requesting peer
    active_peers = [
        {
            'peerId': pid,
            'username': info['username'],
            'avatarColor': info['avatarColor']
        }
        for pid, info in rooms[room].items()
        if pid != peer_id
    ]

    return jsonify({
        'room': room,
        'peers': active_peers
    })

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
