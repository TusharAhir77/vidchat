/**
 * OmniCall – Cross-Device Group Video Call Engine
 *
 * HOW IT WORKS (no backend needed):
 *  - PeerJS Cloud Server handles WebRTC signaling for free
 *  - Each room has 8 named slots: <room>_slot_0 … <room>_slot_7
 *  - First device claims slot_0, second claims slot_1, etc.
 *  - On joining, every device dials ALL other slots — whoever
 *    is there answers → live P2P video/audio across any device/network
 *  - Free TURN relays ensure it works through mobile NAT/firewalls
 */

'use strict';

// ── Constants ─────────────────────────────────────────────────────
const MAX_SLOTS = 8;
const POLL_INTERVAL_MS = 4000;

// Free TURN relays (metered.ca OpenRelay — works on mobile 4G/5G)
const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'turn:openrelay.metered.ca:80',           username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443',          username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:80?transport=tcp',  username: 'openrelayproject', credential: 'openrelayproject' },
];

// ── State ──────────────────────────────────────────────────────────
let peer        = null;   // PeerJS instance
let localStream = null;   // camera + mic stream
let screenStream= null;
let mySlotId    = null;   // e.g. "myroom_slot_2"
let mySlotIdx   = null;
let roomKey     = '';     // cleaned room name
let myName      = '';
let myColor     = '#3b82f6';
let micOn       = true;
let camOn       = true;
let handUp      = false;
let screenSharing = false;
let timerStart  = null;
let pollTimer   = null;
let unread      = 0;

// peerId → { call, name, color, micOn, camOn, handUp }
const remotePeers = {};

// ── DOM ────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const loginScreen  = $('login-screen');
const callScreen   = $('call-screen');
const previewVideo = $('preview-video');
const previewAv    = $('preview-avatar');
const btnPreMic    = $('btn-pre-mic');
const btnPreCam    = $('btn-pre-cam');
const joinForm     = $('join-form');
const inpName      = $('inp-name');
const inpRoom      = $('inp-room');
const roomLabel    = $('room-label');
const peerCount    = $('peer-count-pill');
const callTimerEl  = $('call-timer');
const videoGrid    = $('video-grid');
const sidebar      = $('sidebar');
const chatLog      = $('chat-log');
const chatForm     = $('chat-form');
const chatInp      = $('chat-inp');
const chatBadge    = $('chat-badge');
const peopleList   = $('people-list');
const toastStack   = $('toasts');

// ── Avatar color picker ────────────────────────────────────────────
document.querySelectorAll('.color-swatch').forEach(el => {
    el.addEventListener('click', () => {
        document.querySelectorAll('.color-swatch').forEach(e => e.classList.remove('active'));
        el.classList.add('active');
        myColor = el.dataset.color;
    });
});

// URL param pre-fill room
const urlRoom = new URLSearchParams(location.search).get('room');
if (urlRoom) inpRoom.value = urlRoom;

// ── Preview media ──────────────────────────────────────────────────
(async () => {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        previewVideo.srcObject = localStream;
    } catch {
        previewAv.classList.remove('hidden');
        toast('Allow camera & mic permission to make video calls', 'warn');
    }
})();

btnPreMic.addEventListener('click', () => {
    micOn = !micOn;
    localStream?.getAudioTracks().forEach(t => t.enabled = micOn);
    btnPreMic.classList.toggle('off', !micOn);
    btnPreMic.innerHTML = micOn
        ? '<i class="fa-solid fa-microphone"></i>'
        : '<i class="fa-solid fa-microphone-slash"></i>';
});

btnPreCam.addEventListener('click', () => {
    camOn = !camOn;
    localStream?.getVideoTracks().forEach(t => t.enabled = camOn);
    btnPreCam.classList.toggle('off', !camOn);
    btnPreCam.innerHTML = camOn
        ? '<i class="fa-solid fa-video"></i>'
        : '<i class="fa-solid fa-video-slash"></i>';
    previewAv.classList.toggle('hidden', camOn);
});

// ── Join form ──────────────────────────────────────────────────────
joinForm.addEventListener('submit', async e => {
    e.preventDefault();
    myName   = inpName.value.trim() || 'Guest';
    roomKey  = (inpRoom.value.trim() || 'common-lounge')
                 .toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!roomKey) roomKey = 'commonlounge';

    if (!localStream) {
        try {
            localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        } catch {
            toast('Could not access camera/mic. Audio-only mode.', 'warn');
            // create silent audio-only stream so PeerJS calls still work
            localStream = new MediaStream();
        }
    }

    switchToCall();
    claimSlot(0);
});

// ── Switch screens ─────────────────────────────────────────────────
function switchToCall() {
    loginScreen.classList.remove('active'); loginScreen.classList.add('hidden');
    callScreen.classList.remove('hidden');  callScreen.classList.add('active');
    roomLabel.textContent = inpRoom.value.trim() || 'common-lounge';
    addLocalCard();
    startTimer();
}

// ── Slot claim ─────────────────────────────────────────────────────
function claimSlot(idx) {
    if (idx >= MAX_SLOTS) {
        // All slots full — use random id
        const rnd = Math.random().toString(36).slice(2, 7);
        initPeer(`${roomKey}_rnd_${rnd}`, true);
        return;
    }
    const slotId = `${roomKey}_slot_${idx}`;
    console.log(`Trying slot: ${slotId}`);
    initPeer(slotId, false, idx);
}

// ── Init PeerJS ────────────────────────────────────────────────────
function initPeer(peerId, isFallback, slotIdx = 0) {
    peer = new Peer(peerId, {
        // Use PeerJS public cloud server (handles signaling globally)
        config: { iceServers: ICE_SERVERS },
        debug: 0,
    });

    peer.on('open', id => {
        console.log('✅ Peer connected to cloud signaling server:', id);
        mySlotId  = id;
        mySlotIdx = slotIdx;
        // Dial all other slots immediately
        dialAllSlots();
        // Keep polling to catch latecomers
        pollTimer = setInterval(dialAllSlots, POLL_INTERVAL_MS);
    });

    peer.on('error', err => {
        if (err.type === 'unavailable-id') {
            console.log(`Slot ${slotIdx} taken, trying ${slotIdx + 1}…`);
            peer.destroy();
            peer = null;
            claimSlot(slotIdx + 1);
        } else {
            console.warn('PeerJS:', err.type, err.message);
        }
    });

    // ── Incoming CALL (their device dials us) ──────────────────────
    peer.on('call', incomingCall => {
        const meta = incomingCall.metadata || {};
        console.log(`📞 Incoming call from: ${meta.name} (${incomingCall.peer})`);
        incomingCall.answer(localStream);
        handleCall(incomingCall, meta.name || 'Participant', meta.color || '#8b5cf6');
    });

    // ── Incoming DATA (chat / status) ─────────────────────────────
    peer.on('connection', conn => {
        conn.on('data', data => handleData(data, conn.peer));
    });
}

// ── Dial all room slots ────────────────────────────────────────────
function dialAllSlots() {
    for (let i = 0; i < MAX_SLOTS; i++) {
        const slotId = `${roomKey}_slot_${i}`;
        if (slotId !== mySlotId && !remotePeers[slotId]) {
            dialPeer(slotId);
        }
    }
}

// ── Dial a specific peer ───────────────────────────────────────────
function dialPeer(targetId) {
    if (!peer || remotePeers[targetId]) return;

    console.log(`📡 Dialing: ${targetId}`);
    const call = peer.call(targetId, localStream, {
        metadata: { name: myName, color: myColor }
    });

    if (!call) return;

    // Mark as pending so we don't double-dial
    remotePeers[targetId] = { pending: true };

    call.on('stream', remoteStream => {
        const peerName  = (call.metadata && call.metadata.name)  || 'Participant';
        const peerColor = (call.metadata && call.metadata.color) || '#8b5cf6';
        console.log(`🎥 Got stream from: ${peerName} (${targetId})`);
        addRemoteCard(targetId, remoteStream, peerName, peerColor, call);
        // Open data channel for chat/status
        openDataConn(targetId);
    });

    call.on('close', () => removeRemote(targetId));
    call.on('error', () => { delete remotePeers[targetId]; });
}

// ── Handle incoming call stream ────────────────────────────────────
function handleCall(call, name, color) {
    const pid = call.peer;

    call.on('stream', remoteStream => {
        console.log(`🎥 Received stream from ${name} (${pid})`);
        addRemoteCard(pid, remoteStream, name, color, call);
        openDataConn(pid);
    });

    call.on('close', () => removeRemote(pid));
    call.on('error', () => removeRemote(pid));
}

// ── Open data connection for chat/status ──────────────────────────
function openDataConn(targetId) {
    if (!peer) return;
    if (remotePeers[targetId] && remotePeers[targetId].dataConn) return;

    const conn = peer.connect(targetId);
    conn.on('open', () => {
        if (remotePeers[targetId]) remotePeers[targetId].dataConn = conn;
    });
    conn.on('data', data => handleData(data, targetId));
}

// ── Handle incoming data ───────────────────────────────────────────
function handleData(data, fromId) {
    if (!data || !data.type) return;
    if (data.type === 'chat') {
        appendBubble(data.name, data.color, data.text, data.time, false, fromId);
        if (sidebar.classList.contains('hidden') || !$('chat-panel').classList.contains('active')) {
            unread++;
            chatBadge.textContent = unread;
            chatBadge.classList.remove('hidden');
        }
    } else if (data.type === 'status') {
        const p = remotePeers[fromId];
        if (!p) return;
        if (data.action === 'mic')  { p.micOn = data.value; updateRemoteNameTag(fromId); updatePeopleList(); }
        if (data.action === 'cam')  { p.camOn = data.value; toggleRemoteAvatar(fromId, data.value); updatePeopleList(); }
        if (data.action === 'hand') { p.handUp = data.value; toggleHandBadge(fromId, data.value); updatePeopleList(); }
    }
}

// ── Broadcast data to all peers ───────────────────────────────────
function broadcast(data) {
    Object.values(remotePeers).forEach(p => {
        if (p.dataConn && p.dataConn.open) p.dataConn.send(data);
    });
}

// ── Video cards ────────────────────────────────────────────────────
function addLocalCard() {
    if ($('local-card')) return;
    const card = makeCard('local-card', localStream, myName + ' (You)', myColor, true);
    videoGrid.appendChild(card);
    updateGrid();
    updatePeopleList();
}

function addRemoteCard(pid, stream, name, color, call) {
    let existing = $('card-' + pid);
    if (existing) {
        // Update stream if reconnecting
        existing.querySelector('video').srcObject = stream;
        return;
    }

    remotePeers[pid] = { ...(remotePeers[pid] || {}), call, name, color, micOn: true, camOn: true, handUp: false };

    const card = makeCard('card-' + pid, stream, name, color, false);
    videoGrid.appendChild(card);
    updateGrid();
    updatePeopleList();
    toast(`${name} joined`, 'info');
}

function makeCard(id, stream, name, color, isLocal) {
    const card = document.createElement('div');
    card.id = id;
    card.className = 'vid-card' + (isLocal ? ' local' : '');

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsinline = true;
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
    nameTag.innerHTML = `<i class="fa-solid fa-microphone mic-icon"></i><span>${name}</span>`;

    card.appendChild(video);
    card.appendChild(avCover);
    card.appendChild(nameTag);
    return card;
}

function removeRemote(pid) {
    const info = remotePeers[pid];
    const name = info ? info.name : pid;
    delete remotePeers[pid];
    const card = $('card-' + pid);
    if (card) card.remove();
    updateGrid();
    updatePeopleList();
    toast(`${name} left`, 'info');
}

function updateGrid() {
    const count = videoGrid.children.length;
    videoGrid.setAttribute('data-count', Math.min(count, 9));
    peerCount.innerHTML = `<i class="fa-solid fa-user"></i> ${count}`;
}

// ── Remote card UI helpers ─────────────────────────────────────────
function updateRemoteNameTag(pid) {
    const card = $('card-' + pid);
    if (!card) return;
    const p = remotePeers[pid];
    const icon = card.querySelector('.mic-icon');
    if (icon) icon.className = `fa-solid ${p.micOn ? 'fa-microphone' : 'fa-microphone-slash'} mic-icon${p.micOn ? '' : ' muted'}`;
}

function toggleRemoteAvatar(pid, camEnabled) {
    const card = $('card-' + pid);
    if (!card) return;
    card.querySelector('.av-cover').style.display = camEnabled ? 'none' : 'flex';
}

function toggleHandBadge(pid, show) {
    const card = $('card-' + pid);
    if (!card) return;
    let badge = card.querySelector('.hand-badge');
    if (show) {
        if (!badge) {
            badge = document.createElement('div');
            badge.className = 'hand-badge';
            badge.innerHTML = '<i class="fa-solid fa-hand"></i>';
            card.appendChild(badge);
        }
    } else if (badge) badge.remove();
}

// ── People list ────────────────────────────────────────────────────
function updatePeopleList() {
    peopleList.innerHTML = '';

    const addItem = (name, color, micState, camState, handState) => {
        const li = document.createElement('li');
        li.className = 'person-item';
        li.innerHTML = `
            <div class="person-left">
                <div class="person-av" style="background:${color}">${name.charAt(0).toUpperCase()}</div>
                <span class="person-name">${name}</span>
            </div>
            <div class="person-icons">
                ${handState ? `<i class="fa-solid fa-hand" style="color:var(--warn)"></i>` : ''}
                <i class="fa-solid ${micState ? 'fa-microphone' : 'fa-microphone-slash'}" style="color:${micState ? 'var(--text-3)' : 'var(--danger)'}"></i>
                <i class="fa-solid ${camState ? 'fa-video' : 'fa-video-slash'}" style="color:${camState ? 'var(--text-3)' : 'var(--danger)'}"></i>
            </div>`;
        peopleList.appendChild(li);
    };

    addItem(myName + ' (You)', myColor, micOn, camOn, handUp);
    Object.values(remotePeers).forEach(p => {
        if (!p.pending && p.name) addItem(p.name, p.color, p.micOn, p.camOn, p.handUp);
    });
}

// ── Controls ───────────────────────────────────────────────────────
$('btn-mic').addEventListener('click', () => {
    micOn = !micOn;
    localStream?.getAudioTracks().forEach(t => t.enabled = micOn);
    const btn = $('btn-mic');
    btn.classList.toggle('off', !micOn);
    btn.innerHTML = micOn
        ? '<i class="fa-solid fa-microphone"></i><span>Mic</span>'
        : '<i class="fa-solid fa-microphone-slash"></i><span>Mic</span>';
    // Update local card tag
    const localCard = $('local-card');
    if (localCard) {
        const icon = localCard.querySelector('.mic-icon');
        if (icon) icon.className = `fa-solid ${micOn ? 'fa-microphone' : 'fa-microphone-slash'} mic-icon${micOn ? '' : ' muted'}`;
    }
    broadcast({ type: 'status', action: 'mic', value: micOn });
    updatePeopleList();
});

$('btn-cam').addEventListener('click', () => {
    camOn = !camOn;
    localStream?.getVideoTracks().forEach(t => t.enabled = camOn);
    const btn = $('btn-cam');
    btn.classList.toggle('off', !camOn);
    btn.innerHTML = camOn
        ? '<i class="fa-solid fa-video"></i><span>Camera</span>'
        : '<i class="fa-solid fa-video-slash"></i><span>Camera</span>';
    const localCard = $('local-card');
    if (localCard) localCard.querySelector('.av-cover').style.display = camOn ? 'none' : 'flex';
    broadcast({ type: 'status', action: 'cam', value: camOn });
    updatePeopleList();
});

$('btn-screen').addEventListener('click', async () => {
    if (!screenSharing) {
        try {
            screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
            const track = screenStream.getVideoTracks()[0];
            // Replace video track in all active peer calls
            Object.values(remotePeers).forEach(p => {
                if (p.call && p.call.peerConnection) {
                    const sender = p.call.peerConnection.getSenders().find(s => s.track?.kind === 'video');
                    if (sender) sender.replaceTrack(track);
                }
            });
            const localCard = $('local-card');
            if (localCard) localCard.querySelector('video').srcObject = screenStream;
            screenSharing = true;
            $('btn-screen').classList.add('on');
            track.onended = stopScreen;
        } catch { /* cancelled */ }
    } else {
        stopScreen();
    }
});

function stopScreen() {
    screenStream?.getTracks().forEach(t => t.stop());
    screenStream = null;
    const camTrack = localStream?.getVideoTracks()[0];
    Object.values(remotePeers).forEach(p => {
        if (p.call && p.call.peerConnection && camTrack) {
            const sender = p.call.peerConnection.getSenders().find(s => s.track?.kind === 'video');
            if (sender) sender.replaceTrack(camTrack);
        }
    });
    const localCard = $('local-card');
    if (localCard) localCard.querySelector('video').srcObject = localStream;
    screenSharing = false;
    $('btn-screen').classList.remove('on');
}

$('btn-hand').addEventListener('click', () => {
    handUp = !handUp;
    const btn = $('btn-hand');
    btn.classList.toggle('on', handUp);
    const localCard = $('local-card');
    if (localCard) toggleHandBadge('local', handUp);
    broadcast({ type: 'status', action: 'hand', value: handUp });
    updatePeopleList();
});

$('btn-chat').addEventListener('click', () => {
    toggleSidebar('chat-panel');
    unread = 0; chatBadge.textContent = 0; chatBadge.classList.add('hidden');
});

$('btn-people').addEventListener('click', () => {
    toggleSidebar('people-panel');
});

$('btn-close-sidebar').addEventListener('click', () => {
    sidebar.classList.add('hidden');
});

$('btn-leave').addEventListener('click', () => {
    if (confirm('Leave the call?')) {
        clearInterval(pollTimer);
        peer?.destroy();
        localStream?.getTracks().forEach(t => t.stop());
        location.reload();
    }
});

$('btn-invite').addEventListener('click', () => {
    const url = `${location.origin}${location.pathname}?room=${encodeURIComponent(inpRoom.value.trim() || 'common-lounge')}`;
    navigator.clipboard.writeText(url).then(() => toast('Invite link copied!', 'success'));
});

// ── Sidebar tabs ───────────────────────────────────────────────────
document.querySelectorAll('.stab').forEach(btn => {
    btn.addEventListener('click', () => {
        const panelId = btn.dataset.panel;
        document.querySelectorAll('.stab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.querySelectorAll('.panel').forEach(p => {
            p.classList.toggle('hidden', p.id !== panelId);
            p.classList.toggle('active', p.id === panelId);
        });
    });
});

function toggleSidebar(panelId) {
    const isHidden = sidebar.classList.contains('hidden');
    sidebar.classList.toggle('hidden', !isHidden);
    if (isHidden && panelId) {
        document.querySelectorAll('.stab').forEach(b => b.classList.toggle('active', b.dataset.panel === panelId));
        document.querySelectorAll('.panel').forEach(p => {
            p.classList.toggle('hidden', p.id !== panelId);
            p.classList.toggle('active', p.id === panelId);
        });
    }
}

// ── Chat ───────────────────────────────────────────────────────────
chatForm.addEventListener('submit', e => {
    e.preventDefault();
    const text = chatInp.value.trim();
    if (!text) return;
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    appendBubble(myName, myColor, text, time, true, 'me');
    broadcast({ type: 'chat', name: myName, color: myColor, text, time });
    chatInp.value = '';
});

function appendBubble(name, color, text, time, isSelf, _fromId) {
    const div = document.createElement('div');
    div.className = 'bubble ' + (isSelf ? 'me' : 'them');
    div.innerHTML = `
        <div class="meta">
            <span style="color:${color}">${name}</span>
            <span>${time || ''}</span>
        </div>
        <div class="text">${esc(text)}</div>`;
    chatLog.appendChild(div);
    chatLog.scrollTop = chatLog.scrollHeight;
}

// ── Timer ──────────────────────────────────────────────────────────
function startTimer() {
    timerStart = Date.now();
    setInterval(() => {
        const s = Math.floor((Date.now() - timerStart) / 1000);
        callTimerEl.textContent = `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
    }, 1000);
}
const pad = n => String(n).padStart(2, '0');

// ── Helpers ────────────────────────────────────────────────────────
function toast(msg, type = 'info') {
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `<i class="fa-solid ${type === 'success' ? 'fa-circle-check' : type === 'warn' ? 'fa-triangle-exclamation' : 'fa-circle-info'}"></i> ${msg}`;
    toastStack.appendChild(el);
    setTimeout(() => el.remove(), 4000);
}

function esc(t) {
    const d = document.createElement('div');
    d.textContent = t;
    return d.innerHTML;
}
