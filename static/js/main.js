// OmniCall - Multi-User Group Video Calling Engine (Vercel Serverless & Local WebRTC)

document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements - Login Screen
    const loginScreen = document.getElementById('login-screen');
    const callScreen = document.getElementById('call-screen');
    const joinForm = document.getElementById('join-form');
    const usernameInput = document.getElementById('username');
    const roomNameInput = document.getElementById('room-name');
    const loginVideoPreview = document.getElementById('login-video-preview');
    const previewPlaceholder = document.getElementById('preview-placeholder');
    const previewToggleAudio = document.getElementById('preview-toggle-audio');
    const previewToggleVideo = document.getElementById('preview-toggle-video');
    const colorDots = document.querySelectorAll('.color-dot');

    // DOM Elements - Call Screen Header
    const displayRoomName = document.getElementById('display-room-name');
    const participantCountBadge = document.getElementById('participant-count-badge');
    const sidebarPeerCount = document.getElementById('sidebar-peer-count');
    const callTimer = document.getElementById('call-timer');
    const btnCopyLink = document.getElementById('btn-copy-link');
    const videoGrid = document.getElementById('video-grid');
    
    // Call Controls
    const btnAudio = document.getElementById('btn-audio');
    const btnVideo = document.getElementById('btn-video');
    const btnScreen = document.getElementById('btn-screen');
    const btnHand = document.getElementById('btn-hand');
    const btnChatToggle = document.getElementById('btn-chat-toggle');
    const btnPeopleToggle = document.getElementById('btn-people-toggle');
    const btnLeave = document.getElementById('btn-leave');

    // Sidebar & Chat Elements
    const callSidebar = document.getElementById('call-sidebar');
    const btnCloseSidebar = document.getElementById('btn-close-sidebar');
    const tabChat = document.getElementById('tab-chat');
    const tabPeople = document.getElementById('tab-people');
    const panelChat = document.getElementById('panel-chat');
    const panelPeople = document.getElementById('panel-people');
    const chatMessages = document.getElementById('chat-messages');
    const chatForm = document.getElementById('chat-form');
    const chatInput = document.getElementById('chat-input');
    const unreadChatBadge = document.getElementById('unread-chat-badge');
    const participantsList = document.getElementById('participants-list');
    const toastContainer = document.getElementById('toast-container');

    // WebRTC STUN Configuration
    const rtcConfig = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ]
    };

    // State Variables
    let peerJsInstance = null;
    let localStream = null;
    let screenStream = null;
    let selfSid = null;
    let username = '';
    let roomName = 'common lounge';
    let avatarColor = '#3b82f6';
    let isAudioEnabled = true;
    let isVideoEnabled = true;
    let isScreenSharing = false;
    let isHandRaised = false;
    let isLocalCardCreated = false;
    let unreadChatCount = 0;
    let callStartTime = null;
    let heartbeatTimer = null;

    // Active Remote Peers Storage: { [peerId]: { call, dataConn, username, avatarColor, audio, video, handRaised } }
    const peers = {};

    // Check URL parameters for direct room joining (?room=xyz)
    const urlParams = new URLSearchParams(window.location.search);
    const roomParam = urlParams.get('room');
    if (roomParam) {
        roomNameInput.value = roomParam;
    }

    // Avatar Color Selection
    colorDots.forEach(dot => {
        dot.addEventListener('click', () => {
            colorDots.forEach(d => d.classList.remove('active'));
            dot.classList.add('active');
            avatarColor = dot.getAttribute('data-color');
        });
    });

    // Initialize Camera / Microphone Media Preview
    async function initPreviewMedia() {
        try {
            localStream = await navigator.mediaDevices.getUserMedia({
                video: { width: { ideal: 1280 }, height: { ideal: 720 } },
                audio: true
            });
            loginVideoPreview.srcObject = localStream;
            previewPlaceholder.style.display = 'none';
        } catch (err) {
            console.warn('Could not acquire camera/microphone:', err);
            previewPlaceholder.style.display = 'flex';
            previewPlaceholder.innerHTML = '<i class="fa-solid fa-video-slash"></i>';
            showToast('Camera/Mic permission needed for video call.', 'warning');
        }
    }
    initPreviewMedia();

    // Login Preview Controls
    previewToggleAudio.addEventListener('click', () => {
        if (localStream && localStream.getAudioTracks().length > 0) {
            isAudioEnabled = !isAudioEnabled;
            localStream.getAudioTracks()[0].enabled = isAudioEnabled;
            previewToggleAudio.classList.toggle('off', !isAudioEnabled);
            previewToggleAudio.innerHTML = isAudioEnabled ? 
                '<i class="fa-solid fa-microphone"></i>' : 
                '<i class="fa-solid fa-microphone-slash"></i>';
        }
    });

    previewToggleVideo.addEventListener('click', () => {
        if (localStream && localStream.getVideoTracks().length > 0) {
            isVideoEnabled = !isVideoEnabled;
            localStream.getVideoTracks()[0].enabled = isVideoEnabled;
            previewToggleVideo.classList.toggle('off', !isVideoEnabled);
            previewToggleVideo.innerHTML = isVideoEnabled ? 
                '<i class="fa-solid fa-video"></i>' : 
                '<i class="fa-solid fa-video-slash"></i>';
            previewPlaceholder.style.display = isVideoEnabled ? 'none' : 'flex';
        }
    });

    // JOIN FORM SUBMIT
    joinForm.addEventListener('submit', (e) => {
        e.preventDefault();
        username = usernameInput.value.trim();
        roomName = roomNameInput.value.trim().toLowerCase() || 'common lounge';

        if (!username) return;

        // Switch to Main Call UI
        loginScreen.classList.remove('active');
        loginScreen.classList.add('hidden');
        callScreen.classList.remove('hidden');
        callScreen.classList.add('active');

        displayRoomName.textContent = roomName === 'common lounge' ? 'Common Lounge' : roomName;
        
        updateControlButtonState(btnAudio, isAudioEnabled, 'fa-microphone', 'fa-microphone-slash');
        updateControlButtonState(btnVideo, isVideoEnabled, 'fa-video', 'fa-video-slash');

        // Initialize PeerJS Multi-User Group Calling Engine
        initPeerEngine();
        startCallTimer();
    });

    // PEERJS MULTI-USER CALLING ENGINE
    function initPeerEngine() {
        const cleanRoom = roomName.replace(/[^a-zA-Z0-9]/g, '');
        const randomId = Math.random().toString(36).substring(2, 7);
        const myPeerId = `omnicall_${cleanRoom}_${randomId}`;

        peerJsInstance = new Peer(myPeerId, { config: rtcConfig });

        peerJsInstance.on('open', (id) => {
            console.log('PeerJS connected with ID:', id);
            selfSid = id;
            
            // Create Local Video Card exactly once
            createLocalVideoCard();

            // Register with Room API & start Heartbeat Polling
            pollRoomPeers();
            heartbeatTimer = setInterval(pollRoomPeers, 4000);
        });

        // Handle Incoming Call from another user
        peerJsInstance.on('call', (call) => {
            const peerUsername = (call.metadata && call.metadata.username) ? call.metadata.username : 'Participant';
            const peerAvatarColor = (call.metadata && call.metadata.avatarColor) ? call.metadata.avatarColor : '#8b5cf6';

            console.log(`Incoming call from: ${peerUsername} (${call.peer})`);
            call.answer(localStream);

            call.on('stream', (remoteStream) => {
                addOrUpdatePeer(call.peer, peerUsername, peerAvatarColor, call, null, remoteStream);
            });

            call.on('close', () => removePeer(call.peer));
            call.on('error', () => removePeer(call.peer));
        });

        // Handle Incoming Data Connection for Chat & Actions
        peerJsInstance.on('connection', (dataConn) => {
            dataConn.on('data', (data) => handleIncomingPeerData(data, dataConn.peer));
        });

        peerJsInstance.on('error', (err) => {
            console.warn('PeerJS engine error:', err);
        });
    }

    // POLL ROOM API FOR OTHER ACTIVE PARTICIPANTS
    async function pollRoomPeers() {
        if (!selfSid) return;
        try {
            const res = await fetch(`/api/room?room=${encodeURIComponent(roomName)}&peerId=${encodeURIComponent(selfSid)}&username=${encodeURIComponent(username)}&avatarColor=${encodeURIComponent(avatarColor)}`);
            if (!res.ok) return;

            const data = await res.json();
            const activePeers = data.peers || [];

            activePeers.forEach(peerInfo => {
                const targetPeerId = peerInfo.peerId;
                if (!peers[targetPeerId]) {
                    console.log(`Discovered new room peer: ${peerInfo.username} (${targetPeerId}), connecting...`);
                    
                    // Call remote peer with local stream
                    const call = peerJsInstance.call(targetPeerId, localStream, {
                        metadata: { username: username, avatarColor: avatarColor }
                    });

                    // Establish Data Connection for chat/hand signals
                    const dataConn = peerJsInstance.connect(targetPeerId);

                    if (call) {
                        call.on('stream', (remoteStream) => {
                            addOrUpdatePeer(targetPeerId, peerInfo.username, peerInfo.avatarColor, call, dataConn, remoteStream);
                        });
                        call.on('close', () => removePeer(targetPeerId));
                        call.on('error', () => removePeer(targetPeerId));
                    }

                    if (dataConn) {
                        dataConn.on('data', (data) => handleIncomingPeerData(data, targetPeerId));
                    }
                }
            });

            // Clean up any peers who stopped heartbeating
            const activePeerIdSet = new Set(activePeers.map(p => p.peerId));
            Object.keys(peers).forEach(pid => {
                if (!activePeerIdSet.has(pid)) {
                    removePeer(pid);
                }
            });

        } catch (err) {
            console.warn('Room peer polling error:', err);
        }
    }

    // ADD OR UPDATE PEER RECORD & VIDEO CARD
    function addOrUpdatePeer(peerId, peerUsername, peerAvatarColor, call, dataConn, stream) {
        if (!peers[peerId]) {
            showToast(`${peerUsername} joined the call`, 'info');
        }

        peers[peerId] = {
            call: call,
            dataConn: dataConn || (peers[peerId] ? peers[peerId].dataConn : null),
            username: peerUsername,
            avatarColor: peerAvatarColor,
            audio: true,
            video: true,
            handRaised: false
        };

        createRemoteVideoCard(peerId, stream, peerUsername, peerAvatarColor);
        updateParticipantCount();
        updateParticipantsList();
    }

    // HANDLE INCOMING CHAT / ACTION SIGNAL FROM PEER
    function handleIncomingPeerData(data, senderPeerId) {
        if (data.type === 'chat') {
            appendChatMessage(data);
            if (callSidebar.classList.contains('hidden') || panelChat.classList.contains('hidden')) {
                unreadChatCount++;
                unreadChatBadge.textContent = unreadChatCount;
                unreadChatBadge.classList.remove('hidden');
            }
        } else if (data.type === 'action') {
            const peer = peers[senderPeerId];
            if (peer) {
                if (data.action === 'audio') {
                    peer.audio = data.value;
                    updatePeerAudioUI(senderPeerId, data.value);
                } else if (data.action === 'video') {
                    peer.video = data.value;
                    updatePeerVideoUI(senderPeerId, data.value);
                } else if (data.action === 'hand') {
                    peer.handRaised = data.value;
                    updatePeerHandUI(senderPeerId, data.value);
                }
                updateParticipantsList();
            }
        }
    }

    // BROADCAST SIGNAL TO ALL PEERS DATA CHANNELS
    function broadcastData(data) {
        Object.keys(peers).forEach(pid => {
            const peer = peers[pid];
            if (peer.dataConn && peer.dataConn.open) {
                peer.dataConn.send(data);
            }
        });
    }

    // CREATE LOCAL USER VIDEO CARD (GUARDED AGAINST DUPLICATES)
    function createLocalVideoCard() {
        if (isLocalCardCreated) return;
        isLocalCardCreated = true;

        const card = document.createElement('div');
        card.id = `video-card-${selfSid}`;
        card.className = 'video-card mirror';

        const video = document.createElement('video');
        video.autoplay = true;
        video.muted = true;
        video.playsInline = true;
        if (localStream) video.srcObject = localStream;

        const avatarOverlay = document.createElement('div');
        avatarOverlay.className = 'video-avatar-overlay';
        avatarOverlay.style.display = isVideoEnabled ? 'none' : 'flex';
        avatarOverlay.innerHTML = `
            <div class="video-avatar-circle" style="background: ${avatarColor}">
                ${username.charAt(0).toUpperCase()}
            </div>
        `;

        const userInfo = document.createElement('div');
        userInfo.className = 'card-user-info';
        userInfo.innerHTML = `
            <i class="fa-solid ${isAudioEnabled ? 'fa-microphone' : 'fa-microphone-slash muted'} audio-status-icon"></i>
            <span>${username} (You)</span>
        `;

        card.appendChild(video);
        card.appendChild(avatarOverlay);
        card.appendChild(userInfo);
        videoGrid.appendChild(card);

        updateGridColumns();
        updateParticipantsList();
    }

    // CREATE REMOTE PEER VIDEO CARD
    function createRemoteVideoCard(peerId, stream, peerUsername, peerAvatarColor) {
        let card = document.getElementById(`video-card-${peerId}`);
        if (!card) {
            card = document.createElement('div');
            card.id = `video-card-${peerId}`;
            card.className = 'video-card';

            const video = document.createElement('video');
            video.autoplay = true;
            video.playsInline = true;
            video.srcObject = stream;

            const avatarOverlay = document.createElement('div');
            avatarOverlay.className = 'video-avatar-overlay';
            avatarOverlay.style.display = 'none';
            avatarOverlay.innerHTML = `
                <div class="video-avatar-circle" style="background: ${peerAvatarColor}">
                    ${peerUsername.charAt(0).toUpperCase()}
                </div>
            `;

            const userInfo = document.createElement('div');
            userInfo.className = 'card-user-info';
            userInfo.innerHTML = `
                <i class="fa-solid fa-microphone audio-status-icon"></i>
                <span>${peerUsername}</span>
            `;

            card.appendChild(video);
            card.appendChild(avatarOverlay);
            card.appendChild(userInfo);
            videoGrid.appendChild(card);

            updateGridColumns();
        } else {
            const video = card.querySelector('video');
            if (video && video.srcObject !== stream) {
                video.srcObject = stream;
            }
        }
    }

    // REMOVE PEER
    function removePeer(peerId) {
        if (peers[peerId]) {
            const peerUsername = peers[peerId].username;
            if (peers[peerId].call) peers[peerId].call.close();
            if (peers[peerId].dataConn) peers[peerId].dataConn.close();

            const card = document.getElementById(`video-card-${peerId}`);
            if (card) card.remove();

            delete peers[peerId];
            showToast(`${peerUsername} left the call`, 'info');
            updateGridColumns();
            updateParticipantCount();
            updateParticipantsList();
        }
    }

    // DYNAMIC GRID COLUMNS
    function updateGridColumns() {
        const totalCards = videoGrid.children.length;
        videoGrid.setAttribute('data-peer-count', totalCards);
    }

    // PARTICIPANT COUNT & LIST
    function updateParticipantCount() {
        const total = Object.keys(peers).length + 1;
        participantCountBadge.innerHTML = `<i class="fa-solid fa-user"></i> ${total}`;
        sidebarPeerCount.textContent = total;
    }

    function updateParticipantsList() {
        participantsList.innerHTML = '';

        // Self
        const selfItem = document.createElement('div');
        selfItem.className = 'participant-item';
        selfItem.innerHTML = `
            <div class="participant-info">
                <div class="participant-avatar" style="background: ${avatarColor}">
                    ${username.charAt(0).toUpperCase()}
                </div>
                <span>${username} (You)</span>
            </div>
            <div class="participant-icons">
                ${isHandRaised ? '<i class="fa-solid fa-hand" style="color: var(--warning-color)"></i>' : ''}
                <i class="fa-solid ${isAudioEnabled ? 'fa-microphone' : 'fa-microphone-slash'}" style="color: ${isAudioEnabled ? 'var(--text-muted)' : 'var(--danger-color)'}"></i>
                <i class="fa-solid ${isVideoEnabled ? 'fa-video' : 'fa-video-slash'}" style="color: ${isVideoEnabled ? 'var(--text-muted)' : 'var(--danger-color)'}"></i>
            </div>
        `;
        participantsList.appendChild(selfItem);

        // Peers
        Object.keys(peers).forEach(pid => {
            const peer = peers[pid];
            const item = document.createElement('div');
            item.className = 'participant-item';
            item.innerHTML = `
                <div class="participant-info">
                    <div class="participant-avatar" style="background: ${peer.avatarColor}">
                        ${peer.username.charAt(0).toUpperCase()}
                    </div>
                    <span>${peer.username}</span>
                </div>
                <div class="participant-icons">
                    ${peer.handRaised ? '<i class="fa-solid fa-hand" style="color: var(--warning-color)"></i>' : ''}
                    <i class="fa-solid ${peer.audio ? 'fa-microphone' : 'fa-microphone-slash'}" style="color: ${peer.audio ? 'var(--text-muted)' : 'var(--danger-color)'}"></i>
                    <i class="fa-solid ${peer.video ? 'fa-video' : 'fa-video-slash'}" style="color: ${peer.video ? 'var(--text-muted)' : 'var(--danger-color)'}"></i>
                </div>
            `;
            participantsList.appendChild(item);
        });
    }

    // PEER UI UPDATERS
    function updatePeerAudioUI(peerId, enabled) {
        const card = document.getElementById(`video-card-${peerId}`);
        if (!card) return;
        const icon = card.querySelector('.audio-status-icon');
        if (icon) icon.className = `fa-solid ${enabled ? 'fa-microphone' : 'fa-microphone-slash muted'} audio-status-icon`;
    }

    function updatePeerVideoUI(peerId, enabled) {
        const card = document.getElementById(`video-card-${peerId}`);
        if (!card) return;
        const avatarOverlay = card.querySelector('.video-avatar-overlay');
        if (avatarOverlay) avatarOverlay.style.display = enabled ? 'none' : 'flex';
    }

    function updatePeerHandUI(peerId, raised) {
        const card = document.getElementById(`video-card-${peerId}`);
        if (!card) return;
        let handBadge = card.querySelector('.hand-raised-badge');
        if (raised) {
            if (!handBadge) {
                handBadge = document.createElement('div');
                handBadge.className = 'hand-raised-badge';
                handBadge.innerHTML = '<i class="fa-solid fa-hand"></i>';
                card.appendChild(handBadge);
            }
        } else if (handBadge) {
            handBadge.remove();
        }
    }

    // CALL TOOLBAR CONTROLS
    btnAudio.addEventListener('click', () => {
        if (!localStream) return;
        const audioTrack = localStream.getAudioTracks()[0];
        if (audioTrack) {
            isAudioEnabled = !isAudioEnabled;
            audioTrack.enabled = isAudioEnabled;
            updateControlButtonState(btnAudio, isAudioEnabled, 'fa-microphone', 'fa-microphone-slash');
            
            const localCard = document.getElementById(`video-card-${selfSid}`);
            if (localCard) {
                const icon = localCard.querySelector('.audio-status-icon');
                if (icon) icon.className = `fa-solid ${isAudioEnabled ? 'fa-microphone' : 'fa-microphone-slash muted'} audio-status-icon`;
            }

            broadcastData({ type: 'action', action: 'audio', value: isAudioEnabled });
            updateParticipantsList();
        }
    });

    btnVideo.addEventListener('click', () => {
        if (!localStream) return;
        const videoTrack = localStream.getVideoTracks()[0];
        if (videoTrack) {
            isVideoEnabled = !isVideoEnabled;
            videoTrack.enabled = isVideoEnabled;
            updateControlButtonState(btnVideo, isVideoEnabled, 'fa-video', 'fa-video-slash');
            
            const localCard = document.getElementById(`video-card-${selfSid}`);
            if (localCard) {
                const overlay = localCard.querySelector('.video-avatar-overlay');
                if (overlay) overlay.style.display = isVideoEnabled ? 'none' : 'flex';
            }

            broadcastData({ type: 'action', action: 'video', value: isVideoEnabled });
            updateParticipantsList();
        }
    });

    // SCREEN SHARING
    btnScreen.addEventListener('click', async () => {
        if (!isScreenSharing) {
            try {
                screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
                const screenTrack = screenStream.getVideoTracks()[0];

                // Replace video track for all remote peer calls
                Object.keys(peers).forEach(pid => {
                    const peer = peers[pid];
                    if (peer.call && peer.call.peerConnection) {
                        const senders = peer.call.peerConnection.getSenders();
                        const sender = senders.find(s => s.track && s.track.kind === 'video');
                        if (sender) sender.replaceTrack(screenTrack);
                    }
                });

                const localVideo = document.querySelector(`#video-card-${selfSid} video`);
                if (localVideo) localVideo.srcObject = screenStream;

                isScreenSharing = true;
                btnScreen.classList.add('active');

                screenTrack.onended = () => stopScreenSharing();
            } catch (err) {
                console.warn('Screen share canceled:', err);
            }
        } else {
            stopScreenSharing();
        }
    });

    function stopScreenSharing() {
        if (screenStream) {
            screenStream.getTracks().forEach(t => t.stop());
            screenStream = null;
        }

        const videoTrack = localStream.getVideoTracks()[0];
        Object.keys(peers).forEach(pid => {
            const peer = peers[pid];
            if (peer.call && peer.call.peerConnection && videoTrack) {
                const senders = peer.call.peerConnection.getSenders();
                const sender = senders.find(s => s.track && s.track.kind === 'video');
                if (sender) sender.replaceTrack(videoTrack);
            }
        });

        const localVideo = document.querySelector(`#video-card-${selfSid} video`);
        if (localVideo) localVideo.srcObject = localStream;

        isScreenSharing = false;
        btnScreen.classList.remove('active');
    }

    // HAND RAISE
    btnHand.addEventListener('click', () => {
        isHandRaised = !isHandRaised;
        btnHand.classList.toggle('active', isHandRaised);
        
        const localCard = document.getElementById(`video-card-${selfSid}`);
        if (localCard) {
            let handBadge = localCard.querySelector('.hand-raised-badge');
            if (isHandRaised) {
                if (!handBadge) {
                    handBadge = document.createElement('div');
                    handBadge.className = 'hand-raised-badge';
                    handBadge.innerHTML = '<i class="fa-solid fa-hand"></i>';
                    localCard.appendChild(handBadge);
                }
            } else if (handBadge) {
                handBadge.remove();
            }
        }

        broadcastData({ type: 'action', action: 'hand', value: isHandRaised });
        updateParticipantsList();
    });

    // CHAT & SIDEBAR TOGGLES
    btnChatToggle.addEventListener('click', () => {
        toggleSidebar();
        switchSidebarTab(tabChat, panelChat);
        unreadChatCount = 0;
        unreadChatBadge.classList.add('hidden');
    });

    btnPeopleToggle.addEventListener('click', () => {
        toggleSidebar();
        switchSidebarTab(tabPeople, panelPeople);
    });

    btnCloseSidebar.addEventListener('click', () => {
        callSidebar.classList.add('hidden');
    });

    tabChat.addEventListener('click', () => switchSidebarTab(tabChat, panelChat));
    tabPeople.addEventListener('click', () => switchSidebarTab(tabPeople, panelPeople));

    function toggleSidebar() {
        callSidebar.classList.toggle('hidden');
    }

    function switchSidebarTab(tabBtn, panel) {
        document.querySelectorAll('.tab-btn').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.sidebar-panel').forEach(p => p.classList.remove('active'));
        tabBtn.classList.add('active');
        panel.classList.add('active');
    }

    // CHAT FORM SUBMIT
    chatForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const msg = chatInput.value.trim();
        if (!msg) return;

        const chatPayload = {
            type: 'chat',
            senderSid: selfSid,
            username: username,
            avatarColor: avatarColor,
            message: msg,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };

        appendChatMessage(chatPayload);
        broadcastData(chatPayload);

        chatInput.value = '';
    });

    function appendChatMessage(data) {
        const isSelf = data.senderSid === selfSid;
        const bubble = document.createElement('div');
        bubble.className = `chat-bubble ${isSelf ? 'self' : 'peer'}`;

        bubble.innerHTML = `
            <div class="chat-author">
                <span style="color: ${data.avatarColor}">${data.username}</span>
                <span>${data.timestamp || ''}</span>
            </div>
            <div class="chat-text">${escapeHtml(data.message)}</div>
        `;

        chatMessages.appendChild(bubble);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    // LEAVE CALL & UNLOAD
    btnLeave.addEventListener('click', () => {
        if (confirm('Are you sure you want to leave the call?')) {
            leaveCall();
            window.location.reload();
        }
    });

    window.addEventListener('beforeunload', leaveCall);

    function leaveCall() {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (selfSid) {
            fetch('/api/room', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'leave', room: roomName, peerId: selfSid }),
                keepalive: true
            }).catch(() => {});
        }
    }

    // COPY INVITATION LINK
    btnCopyLink.addEventListener('click', () => {
        const inviteUrl = `${window.location.origin}/?room=${encodeURIComponent(roomName)}`;
        navigator.clipboard.writeText(inviteUrl).then(() => {
            showToast('Room link copied to clipboard!', 'success');
        });
    });

    // CALL TIMER
    function startCallTimer() {
        callStartTime = Date.now();
        setInterval(() => {
            const elapsedSeconds = Math.floor((Date.now() - callStartTime) / 1000);
            const mins = String(Math.floor(elapsedSeconds / 60)).padStart(2, '0');
            const secs = String(elapsedSeconds % 60).padStart(2, '0');
            callTimer.textContent = `${mins}:${secs}`;
        }, 1000);
    }

    // UTILITY FUNCTIONS
    function updateControlButtonState(btn, enabled, activeIcon, inactiveIcon) {
        btn.classList.toggle('off', !enabled);
        const icon = btn.querySelector('i');
        if (icon) icon.className = `fa-solid ${enabled ? activeIcon : inactiveIcon}`;
    }

    function showToast(message, type = 'info') {
        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.innerHTML = `
            <i class="fa-solid ${type === 'success' ? 'fa-circle-check' : 'fa-circle-info'}"></i>
            <span>${message}</span>
        `;
        toastContainer.appendChild(toast);
        setTimeout(() => toast.remove(), 4000);
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
});
