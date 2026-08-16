/**
 * OmniCall – Cross-Device WebRTC Video Calling Engine
 *
 * Signaling: Public MQTT over WebSockets (Zero-Config, Zero-Auth, Instant)
 * Media: Native browser RTCPeerConnection with STUN + TURN relays
 */

'use strict';

// ─── Configuration ────────────────────────────────────────────────
const MQTT_BROKERS = [
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://broker.emqx.io:8084/mqtt'
];

const RTC_CONFIG = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
        { urls: 'stun:global.stun.twilio.com:3478' },
        { urls: 'stun:stun.cloudflare.com:3478' },
        {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443?transport=tcp',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        }
    ]
};

// ─── DOM Helpers ──────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ─── State ────────────────────────────────────────────────────────
let mqttClient   = null;
let localStream  = null;
let screenStream = null;

let myPeerId     = '';
let myName       = '';
let myColor      = '#3b82f6';
let roomKey      = '';

let micOn        = true;
let camOn        = true;
let handUp       = false;
let screenOn     = false;
let unread       = 0;
let timerStart   = null;
let heartbeatId  = null;

// Map: peerId -> { pc: RTCPeerConnection, name: string, color: string, micOn: boolean, camOn: boolean, handUp: boolean, lastSeen: number }
const peers = {};

// ─── URL Parameters ───────────────────────────────────────────────
const urlParams = new URLSearchParams(window.location.search);
const roomParam = urlParams.get('room');
if (roomParam) $('inp-room').value = roomParam;

// ─── Color Swatches ───────────────────────────────────────────────
document.querySelectorAll('.cswatch').forEach(el => {
    el.addEventListener('click', () => {
        document.querySelectorAll('.cswatch').forEach(e => e.classList.remove('active'));
        el.classList.add('active');
        myColor = el.dataset.c;
    });
});

// ─── Camera Preview on Login ──────────────────────────────────────
(async () => {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
            audio: true
        });
        $('preview-video').srcObject = localStream;
    } catch (e) {
        console.warn('Camera preview notice:', e);
        $('preview-avatar').classList.remove('hidden');
    }
})();

$('btn-pre-mic').addEventListener('click', () => {
    micOn = !micOn;
    localStream?.getAudioTracks().forEach(t => t.enabled = micOn);
    $('btn-pre-mic').classList.toggle('off', !micOn);
    $('btn-pre-mic').innerHTML = `<i class="fa-solid ${micOn ? 'fa-microphone' : 'fa-microphone-slash'}"></i>`;
});

$('btn-pre-cam').addEventListener('click', () => {
    camOn = !camOn;
    localStream?.getVideoTracks().forEach(t => t.enabled = camOn);
    $('btn-pre-cam').classList.toggle('off', !camOn);
    $('btn-pre-cam').innerHTML = `<i class="fa-solid ${camOn ? 'fa-video' : 'fa-video-slash'}"></i>`;
    $('preview-avatar').classList.toggle('hidden', camOn);
});

// ─── Join Form Submit ─────────────────────────────────────────────
$('join-form').addEventListener('submit', async e => {
    e.preventDefault();
    myName = $('inp-name').value.trim() || 'User_' + Math.floor(Math.random() * 1000);
    roomKey = ($('inp-room').value.trim() || 'common-lounge')
                .toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!roomKey) roomKey = 'commonlounge';

    if (!localStream) {
        try {
            localStream = await navigator.mediaDevices.getUserMedia({
                video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
                audio: true
            });
        } catch {
            try {
                localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                toast('Camera unavailable — audio only', 'warn');
            } catch {
                localStream = new MediaStream();
                toast('Camera/Mic permission denied', 'warn');
            }
        }
    }

    // Switch UI to call screen
    $('login-screen').classList.replace('active', 'hidden');
    $('call-screen').classList.replace('hidden', 'active');
    $('room-label').textContent = $('inp-room').value.trim() || 'common-lounge';

    // Generate unique ID for this device session
    myPeerId = 'peer_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);

    addLocalCard();
    initSignaling();
    startTimer();
});

// ─── MQTT Signaling Client ────────────────────────────────────────
function initSignaling(brokerIndex = 0) {
    if (brokerIndex >= MQTT_BROKERS.length) brokerIndex = 0;
    const brokerUrl = MQTT_BROKERS[brokerIndex];
    const clientId = 'omnicall_' + myPeerId;

    console.log(`Connecting to signaling broker: ${brokerUrl}`);
    
    try {
        mqttClient = mqtt.connect(brokerUrl, {
            clientId: clientId,
            clean: true,
            connectTimeout: 5000,
            reconnectPeriod: 3000
        });

        mqttClient.on('connect', () => {
            console.log('✅ Connected to MQTT signaling server!');
            const topicPattern = `omnicall_v3/${roomKey}/#`;
            mqttClient.subscribe(topicPattern, { qos: 0 }, err => {
                if (!err) {
                    console.log(`Subscribed to room topic: ${topicPattern}`);
                    announcePresence();
                    
                    // Periodic heartbeat announcement
                    if (heartbeatId) clearInterval(heartbeatId);
                    heartbeatId = setInterval(announcePresence, 4000);
                }
            });
        });

        mqttClient.on('message', (topic, message) => {
            try {
                const payload = JSON.parse(message.toString());
                handleSignalingMessage(topic, payload);
            } catch (err) {
                console.warn('Signaling parse error:', err);
            }
        });

        mqttClient.on('error', err => {
            console.warn('MQTT broker error:', err);
        });

    } catch (err) {
        console.error('MQTT connection failure, trying alternate broker...', err);
        setTimeout(() => initSignaling(brokerIndex + 1), 2000);
    }
}

// ─── Publish Helper ───────────────────────────────────────────────
function sendSignal(subTopic, payload) {
    if (!mqttClient || !mqttClient.connected) return;
    const topic = `omnicall_v3/${roomKey}/${subTopic}`;
    payload.senderId = myPeerId;
    payload.room = roomKey;
    mqttClient.publish(topic, JSON.stringify(payload), { qos: 0 });
}

function announcePresence() {
    sendSignal('presence', {
        type: 'presence',
        name: myName,
        color: myColor,
        micOn: micOn,
        camOn: camOn,
        handUp: handUp
    });
}

// ─── Handle Incoming Signaling Messages ───────────────────────────
async function handleSignalingMessage(topic, data) {
    if (!data || data.senderId === myPeerId) return;

    const fromId = data.senderId;

    // 1. Presence Notification (A peer announced themselves in room)
    if (data.type === 'presence') {
        if (!peers[fromId]) {
            console.log(`Discovered peer: ${data.name} (${fromId})`);
            peers[fromId] = {
                pc: null,
                name: data.name,
                color: data.color,
                micOn: data.micOn !== false,
                camOn: data.camOn !== false,
                handUp: data.handUp || false,
                lastSeen: Date.now()
            };
            updatePeopleList();

            // Deterministic initiation: peer with alphabetically smaller ID creates Offer
            if (myPeerId < fromId) {
                console.log(`Initiating WebRTC offer to: ${data.name}`);
                createPeerConnection(fromId, true);
            }
        } else {
            peers[fromId].lastSeen = Date.now();
            if (peers[fromId].micOn !== data.micOn) {
                peers[fromId].micOn = data.micOn;
                updateMicTag(fromId, data.micOn);
            }
            if (peers[fromId].camOn !== data.camOn) {
                peers[fromId].camOn = data.camOn;
                toggleAvatarCover(fromId, data.camOn);
            }
            if (peers[fromId].handUp !== data.handUp) {
                peers[fromId].handUp = data.handUp;
                toggleHandBadge(fromId, data.handUp);
            }
        }
    }

    // 2. WebRTC SDP Offer
    else if (data.type === 'offer' && data.targetId === myPeerId) {
        console.log(`Received SDP Offer from: ${data.name} (${fromId})`);
        const pc = createPeerConnection(fromId, false);
        try {
            await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            
            sendSignal(`signal_${fromId}`, {
                type: 'answer',
                targetId: fromId,
                name: myName,
                color: myColor,
                sdp: pc.localDescription
            });
        } catch (err) {
            console.error('Error handling offer:', err);
        }
    }

    // 3. WebRTC SDP Answer
    else if (data.type === 'answer' && data.targetId === myPeerId) {
        console.log(`Received SDP Answer from: ${fromId}`);
        const peerRecord = peers[fromId];
        if (peerRecord && peerRecord.pc) {
            try {
                await peerRecord.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
            } catch (err) {
                console.error('Error setting remote answer description:', err);
            }
        }
    }

    // 4. WebRTC ICE Candidate
    else if (data.type === 'candidate' && data.targetId === myPeerId) {
        const peerRecord = peers[fromId];
        if (peerRecord && peerRecord.pc && data.candidate) {
            try {
                await peerRecord.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
            } catch (err) {
                console.warn('Error adding ICE candidate:', err);
            }
        }
    }

    // 5. In-Call Chat Message
    else if (data.type === 'chat') {
        appendBubble(data.name, data.color, data.text, data.time, false);
        const sidebarHidden = $('sidebar').classList.contains('hidden');
        const chatActive = $('chat-panel').classList.contains('active');
        if (sidebarHidden || !chatActive) {
            unread++;
            $('chat-badge').textContent = unread;
            $('chat-badge').classList.remove('hidden');
        }
    }

    // 6. User Leave Event
    else if (data.type === 'leave') {
        removePeer(fromId);
    }
}

// ─── Native WebRTC Connection Factory ─────────────────────────────
function createPeerConnection(peerId, isInitiator) {
    if (peers[peerId]?.pc) return peers[peerId].pc;

    console.log(`Creating RTCPeerConnection for: ${peerId}`);
    const pc = new RTCPeerConnection(RTC_CONFIG);

    if (!peers[peerId]) {
        peers[peerId] = {
            pc: pc,
            name: 'Participant',
            color: '#8b5cf6',
            micOn: true,
            camOn: true,
            handUp: false,
            lastSeen: Date.now()
        };
    } else {
        peers[peerId].pc = pc;
    }

    // Attach local media tracks to connection
    if (localStream) {
        localStream.getTracks().forEach(track => {
            pc.addTrack(track, localStream);
        });
    }

    // Send ICE candidates to remote peer via MQTT
    pc.onicecandidate = event => {
        if (event.candidate) {
            sendSignal(`signal_${peerId}`, {
                type: 'candidate',
                targetId: peerId,
                candidate: event.candidate
            });
        }
    };

    // Receive Remote Track
    pc.ontrack = event => {
        console.log(`🎥 Received remote stream track from: ${peers[peerId].name} (${peerId})`);
        const remoteStream = event.streams[0];
        addRemoteCard(peerId, remoteStream, peers[peerId].name, peers[peerId].color);
        updatePeopleList();
    };

    // Connection state changes
    pc.onconnectionstatechange = () => {
        console.log(`Peer ${peerId} state: ${pc.connectionState}`);
        if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
            removePeer(peerId);
        } else if (pc.connectionState === 'connected') {
            toast(`${peers[peerId].name} connected ✓`, 'success');
        }
    };

    // If initiator, create and dispatch SDP Offer
    if (isInitiator) {
        pc.onnegotiationneeded = async () => {
            try {
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                sendSignal(`signal_${peerId}`, {
                    type: 'offer',
                    targetId: peerId,
                    name: myName,
                    color: myColor,
                    sdp: pc.localDescription
                });
            } catch (err) {
                console.error('Error creating offer:', err);
            }
        };
    }

    return pc;
}

// ─── Video Grid & Cards ───────────────────────────────────────────
function addLocalCard() {
    if ($('local-card')) return;
    const card = buildCard('local-card', localStream, myName + ' (You)', myColor, true);
    $('video-grid').appendChild(card);
    updateGrid();
    updatePeopleList();
}

function addRemoteCard(pid, stream, name, color) {
    let card = $('rc-' + CSS.escape(pid));
    if (card) {
        const v = card.querySelector('video');
        if (v && v.srcObject !== stream) {
            v.srcObject = stream;
            v.play().catch(() => {});
        }
        return;
    }
    card = buildCard('rc-' + pid, stream, name, color, false);
    $('video-grid').appendChild(card);
    updateGrid();
}

function buildCard(id, stream, name, color, isLocal) {
    const card = document.createElement('div');
    card.id = id;
    card.className = 'vid-card' + (isLocal ? ' local' : '');

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    if (isLocal) video.muted = true;
    video.srcObject = stream;
    video.play().catch(() => {});

    const avCover = document.createElement('div');
    avCover.className = 'av-cover';
    avCover.style.display = 'none';
    const avCircle = document.createElement('div');
    avCircle.className = 'av-circle';
    avCircle.style.background = color;
    avCircle.textContent = name.charAt(0).toUpperCase();
    avCover.appendChild(avCircle);

    const nameTag = document.createElement('div');
    nameTag.className = 'name-tag';
    nameTag.innerHTML = `<i class="fa-solid fa-microphone mic-icon"></i><span>${esc(name)}</span>`;

    card.appendChild(video);
    card.appendChild(avCover);
    card.appendChild(nameTag);
    return card;
}

function removePeer(pid) {
    const p = peers[pid];
    if (p) {
        const name = p.name;
        if (p.pc) p.pc.close();
        delete peers[pid];

        const card = document.querySelector(`[id="rc-${pid}"]`);
        if (card) card.remove();

        updateGrid();
        updatePeopleList();
        toast(`${name} left the call`, 'info');
    }
}

function updateGrid() {
    const count = $('video-grid').children.length;
    $('video-grid').setAttribute('data-count', Math.min(count, 9));
    $('peer-pill').innerHTML = `<i class="fa-solid fa-user"></i> ${count}`;
}

// ─── Remote Card Helpers ──────────────────────────────────────────
function updateMicTag(pid, on) {
    const card = document.querySelector(`[id="rc-${pid}"]`);
    if (!card) return;
    const icon = card.querySelector('.mic-icon');
    if (icon) icon.className = `fa-solid ${on ? 'fa-microphone' : 'fa-microphone-slash'} mic-icon${on ? '' : ' muted'}`;
}

function toggleAvatarCover(pid, camEnabled) {
    const card = document.querySelector(`[id="rc-${pid}"]`);
    if (!card) return;
    card.querySelector('.av-cover').style.display = camEnabled ? 'none' : 'flex';
}

function toggleHandBadge(pid, show) {
    const card = document.querySelector(`[id="rc-${pid}"]`);
    if (!card) return;
    let b = card.querySelector('.hand-badge');
    if (show && !b) {
        b = document.createElement('div');
        b.className = 'hand-badge';
        b.innerHTML = '<i class="fa-solid fa-hand"></i>';
        card.appendChild(b);
    } else if (!show && b) {
        b.remove();
    }
}

// ─── People List ──────────────────────────────────────────────────
function updatePeopleList() {
    const ul = $('people-list');
    ul.innerHTML = '';
    const add = (n, c, m, v, h) => {
        const li = document.createElement('li');
        li.className = 'person-item';
        li.innerHTML = `
            <div class="p-left">
                <div class="p-av" style="background:${c}">${n.charAt(0).toUpperCase()}</div>
                <span>${esc(n)}</span>
            </div>
            <div class="p-icons">
                ${h ? `<i class="fa-solid fa-hand" style="color:var(--warn)"></i>` : ''}
                <i class="fa-solid ${m ? 'fa-microphone' : 'fa-microphone-slash'}" style="color:${m ? 'var(--t3)' : 'var(--danger)'}"></i>
                <i class="fa-solid ${v ? 'fa-video' : 'fa-video-slash'}" style="color:${v ? 'var(--t3)' : 'var(--danger)'}"></i>
            </div>`;
        ul.appendChild(li);
    };

    add(myName + ' (You)', myColor, micOn, camOn, handUp);
    Object.keys(peers).forEach(pid => {
        const p = peers[pid];
        add(p.name, p.color, p.micOn, p.camOn, p.handUp);
    });
}

// ─── Call Toolbar Controls ────────────────────────────────────────
$('btn-mic').addEventListener('click', () => {
    micOn = !micOn;
    localStream?.getAudioTracks().forEach(t => t.enabled = micOn);
    syncCtrl('btn-mic', micOn, 'fa-microphone', 'fa-microphone-slash', 'Mic');
    
    const lc = $('local-card');
    if (lc) {
        const icon = lc.querySelector('.mic-icon');
        if (icon) icon.className = `fa-solid ${micOn ? 'fa-microphone' : 'fa-microphone-slash'} mic-icon${micOn ? '' : ' muted'}`;
    }
    announcePresence();
    updatePeopleList();
});

$('btn-cam').addEventListener('click', () => {
    camOn = !camOn;
    localStream?.getVideoTracks().forEach(t => t.enabled = camOn);
    syncCtrl('btn-cam', camOn, 'fa-video', 'fa-video-slash', 'Camera');
    
    const lc = $('local-card');
    if (lc) lc.querySelector('.av-cover').style.display = camOn ? 'none' : 'flex';
    announcePresence();
    updatePeopleList();
});

// Screen Sharing
$('btn-screen').addEventListener('click', async () => {
    if (!screenOn) {
        try {
            screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
            const screenTrack = screenStream.getVideoTracks()[0];
            
            // Replace video track in all active RTCPeerConnections
            Object.values(peers).forEach(p => {
                if (p.pc) {
                    const sender = p.pc.getSenders().find(s => s.track && s.track.kind === 'video');
                    if (sender) sender.replaceTrack(screenTrack);
                }
            });

            const lv = $('local-card')?.querySelector('video');
            if (lv) lv.srcObject = screenStream;

            screenOn = true;
            $('btn-screen').classList.add('on');
            screenTrack.onended = stopScreen;
        } catch (e) {
            console.warn('Screen share canceled:', e);
        }
    } else {
        stopScreen();
    }
});

function stopScreen() {
    screenStream?.getTracks().forEach(t => t.stop());
    screenStream = null;
    const camTrack = localStream?.getVideoTracks()[0];
    
    Object.values(peers).forEach(p => {
        if (p.pc && camTrack) {
            const sender = p.pc.getSenders().find(s => s.track && s.track.kind === 'video');
            if (sender) sender.replaceTrack(camTrack);
        }
    });

    const lv = $('local-card')?.querySelector('video');
    if (lv) lv.srcObject = localStream;
    screenOn = false;
    $('btn-screen').classList.remove('on');
}

// Hand Raise
$('btn-hand').addEventListener('click', () => {
    handUp = !handUp;
    $('btn-hand').classList.toggle('on', handUp);
    toggleHandBadge('local', handUp);
    announcePresence();
    updatePeopleList();
});

// Chat Drawer Toggle
$('btn-chat').addEventListener('click', () => {
    toggleSidebar('chat-panel');
    unread = 0;
    $('chat-badge').textContent = 0;
    $('chat-badge').classList.add('hidden');
});

// People Drawer Toggle
$('btn-people').addEventListener('click', () => {
    toggleSidebar('people-panel');
    updatePeopleList();
});

$('btn-close-sb').addEventListener('click', () => $('sidebar').classList.add('hidden'));

// Leave Call
$('btn-leave').addEventListener('click', () => {
    if (!confirm('Leave the video call?')) return;
    leaveAndReload();
});

window.addEventListener('beforeunload', () => {
    if (mqttClient && mqttClient.connected) {
        sendSignal('presence', { type: 'leave' });
    }
});

function leaveAndReload() {
    if (heartbeatId) clearInterval(heartbeatId);
    if (mqttClient && mqttClient.connected) {
        sendSignal('presence', { type: 'leave' });
        mqttClient.end();
    }
    Object.values(peers).forEach(p => p.pc?.close());
    localStream?.getTracks().forEach(t => t.stop());
    location.reload();
}

// Copy Invitation Link
$('btn-invite').addEventListener('click', () => {
    const url = `${location.origin}${location.pathname}?room=${encodeURIComponent(roomKey)}`;
    navigator.clipboard.writeText(url).then(() => toast('Invite link copied to clipboard!', 'success'));
});

// ─── Sidebar Tabs ─────────────────────────────────────────────────
document.querySelectorAll('.stab').forEach(btn => {
    btn.addEventListener('click', () => {
        const pid = btn.dataset.panel;
        document.querySelectorAll('.stab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.querySelectorAll('.panel').forEach(p => {
            p.classList.toggle('hidden',  p.id !== pid);
            p.classList.toggle('active', p.id === pid);
        });
    });
});

function toggleSidebar(panel) {
    const hidden = $('sidebar').classList.contains('hidden');
    $('sidebar').classList.toggle('hidden', !hidden);
    if (hidden && panel) {
        document.querySelectorAll('.stab').forEach(b => b.classList.toggle('active', b.dataset.panel === panel));
        document.querySelectorAll('.panel').forEach(p => {
            p.classList.toggle('hidden',  p.id !== panel);
            p.classList.toggle('active', p.id === panel);
        });
    }
}

// ─── In-Call Text Chat ────────────────────────────────────────────
$('chat-form').addEventListener('submit', e => {
    e.preventDefault();
    const text = $('chat-inp').value.trim();
    if (!text) return;
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    appendBubble(myName, myColor, text, time, true);
    sendSignal('chat', {
        type: 'chat',
        name: myName,
        color: myColor,
        text: text,
        time: time
    });

    $('chat-inp').value = '';
});

function appendBubble(name, color, text, time, isSelf) {
    const div = document.createElement('div');
    div.className = 'bubble ' + (isSelf ? 'me' : 'them');
    div.innerHTML = `
        <div class="meta"><span style="color:${color}">${esc(name)}</span><span>${time}</span></div>
        <div class="text">${esc(text)}</div>`;
    $('chat-log').appendChild(div);
    $('chat-log').scrollTop = $('chat-log').scrollHeight;
}

// ─── Call Timer ───────────────────────────────────────────────────
function startTimer() {
    timerStart = Date.now();
    setInterval(() => {
        const s = Math.floor((Date.now() - timerStart) / 1000);
        $('call-timer').textContent = `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
    }, 1000);
}

// ─── Utility Helpers ──────────────────────────────────────────────
const pad = n => String(n).padStart(2, '0');

function esc(t) {
    const d = document.createElement('div');
    d.textContent = t;
    return d.innerHTML;
}

function syncCtrl(id, on, iconOn, iconOff, label) {
    const b = $(id);
    b.classList.toggle('off', !on);
    b.innerHTML = `<i class="fa-solid ${on ? iconOn : iconOff}"></i><span>${label}</span>`;
}

function toast(msg, type = 'info') {
    const el = document.createElement('div');
    el.className = 'toast';
    const icon = type === 'success' ? 'fa-circle-check' : type === 'warn' ? 'fa-triangle-exclamation' : 'fa-circle-info';
    el.innerHTML = `<i class="fa-solid ${icon}"></i> ${msg}`;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), 4000);
}
