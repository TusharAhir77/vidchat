// OmniCall - Group Video Call JavaScript Application Logic (Vercel & Local Serverless Ready)

document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements - Login
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

    // DOM Elements - Call
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

    // Sidebar
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

    // WebRTC Configuration
    const rtcConfig = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ]
    };

    // State Variables
    let socket = null;
    let peerJsInstance = null;
    let localStream = null;
    let screenStream = null;
    let selfSid = null;
    let username = '';
    let roomName = '';
    let avatarColor = '#3b82f6';
    let isAudioEnabled = true;
    let isVideoEnabled = true;
    let isScreenSharing = false;
    let isHandRaised = false;
    let unreadChatCount = 0;
    let callStartTime = null;
    let timerInterval = null;

    // Peer Storage: { [sid]: { pc, call, dataConn, username, avatarColor, videoCard, audio, video, handRaised } }
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

    // Initialize Local Preview Video on Login Screen
    async function initPreviewMedia() {
        try {
            localStream = await navigator.mediaDevices.getUserMedia({
                video: { width: { ideal: 1280 }, height: { ideal: 720 } },
                audio: true
            });
            loginVideoPreview.srcObject = localStream;
            previewPlaceholder.style.display = 'none';
        } catch (err) {
            console.warn('Could not acquire audio/video stream for preview:', err);
            previewPlaceholder.style.display = 'flex';
            previewPlaceholder.innerHTML = '<i class="fa-solid fa-video-slash"></i>';
            showToast('Camera/Mic permission needed for video calling.', 'warning');
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

    // JOIN FORM SUBMISSION
    joinForm.addEventListener('submit', (e) => {
        e.preventDefault();
        username = usernameInput.value.trim();
        roomName = roomNameInput.value.trim().toLowerCase() || 'common lounge';

        if (!username) return;

        // Switch to Call Screen UI
        loginScreen.classList.remove('active');
        loginScreen.classList.add('hidden');
        callScreen.classList.remove('hidden');
        callScreen.classList.add('active');

        displayRoomName.textContent = roomName === 'common lounge' ? 'Common Lounge' : roomName;
        
        // Update control button states
        updateControlButtonState(btnAudio, isAudioEnabled, 'fa-microphone', 'fa-microphone-slash');
        updateControlButtonState(btnVideo, isVideoEnabled, 'fa-video', 'fa-video-slash');

        // Connect to Socket.IO or PeerJS
        initializeSignaling();
        startCallTimer();
    });

    // INITIALIZE SIGNALING (Dual-Mode: Socket.IO + PeerJS Fallback for Vercel)
    function initializeSignaling() {
        if (typeof io !== 'undefined') {
            socket = io();

            socket.on('connect', () => {
                console.log('Connected to Socket.IO signaling server:', socket.id);
                selfSid = socket.id;

                socket.emit('join-room', {
                    room: roomName,
                    username: username,
                    avatarColor: avatarColor
                });

                createLocalVideoCard();
            });

            socket.on('connect_error', () => {
                console.warn('Socket.IO connection failed, switching to PeerJS serverless mode...');
                initPeerJsSignaling();
            });

            socket.on('existing-users', (data) => {
                const existingPeers = data.peers;
                existingPeers.forEach(peer => {
                    createPeerConnection(peer.sid, peer.username, peer.avatarColor, true);
                });
                updateParticipantCount();
            });

            socket.on('user-joined', (data) => {
                showToast(`${data.username} joined the call`, 'info');
                createPeerConnection(data.sid, data.username, data.avatarColor, false);
                updateParticipantCount();
            });

            socket.on('signal', async (data) => {
                const senderSid = data.sender;
                const signal = data.signal;
                
                if (!peers[senderSid]) {
                    createPeerConnection(senderSid, data.username, data.avatarColor, false);
                }

                const pc = peers[senderSid].pc;
                try {
                    if (signal.sdp) {
                        await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
                        if (signal.sdp.type === 'offer') {
                            const answer = await pc.createAnswer();
                            await pc.setLocalDescription(answer);
                            socket.emit('signal', {
                                target: senderSid,
                                signal: { sdp: pc.localDescription }
                            });
                        }
                    } else if (signal.candidate) {
                        await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
                    }
                } catch (err) {
                    console.error('Error handling WebRTC signal:', err);
                }
            });

            socket.on('peer-action', (data) => {
                const peer = peers[data.sid];
                if (!peer) return;

                if (data.type === 'audio') {
                    peer.audio = data.value;
                    updatePeerAudioUI(data.sid, data.value);
                } else if (data.type === 'video') {
                    peer.video = data.value;
                    updatePeerVideoUI(data.sid, data.value);
                } else if (data.type === 'hand') {
                    peer.handRaised = data.value;
                    updatePeerHandUI(data.sid, data.value);
                }
                updateParticipantsList();
            });

            socket.on('chat-message', (data) => {
                appendChatMessage(data);
                if (data.senderSid !== selfSid && (callSidebar.classList.contains('hidden') || panelChat.classList.contains('hidden'))) {
                    unreadChatCount++;
                    unreadChatBadge.textContent = unreadChatCount;
                    unreadChatBadge.classList.remove('hidden');
                }
            });

            socket.on('user-left', (data) => {
                showToast(`${data.username} left the call`, 'info');
                removePeer(data.sid);
            });
        } else {
            initPeerJsSignaling();
        }
    }

    // PEERJS SIGNALING (For Vercel Serverless Deployment)
    function initPeerJsSignaling() {
        if (typeof Peer === 'undefined') return;

        const cleanRoom = roomName.replace(/[^a-zA-Z0-9]/g, '');
        const randomId = Math.random().toString(36).substring(2, 7);
        const myPeerId = `omnicall_${cleanRoom}_${randomId}`;

        peerJsInstance = new Peer(myPeerId, { config: rtcConfig });

        peerJsInstance.on('open', (id) => {
            console.log('PeerJS serverless signaling connected:', id);
            selfSid = id;
            createLocalVideoCard();
        });

        // Incoming Call
        peerJsInstance.on('call', (call) => {
            const peerUsername = call.metadata ? call.metadata.username : 'Participant';
            const peerAvatarColor = call.metadata ? call.metadata.avatarColor : '#8b5cf6';
            
            call.answer(localStream);
            
            peers[call.peer] = {
                pc: call.peerConnection,
                call: call,
                username: peerUsername,
                avatarColor: peerAvatarColor,
                videoCard: null,
                audio: true,
                video: true,
                handRaised: false
            };

            call.on('stream', (remoteStream) => {
                createRemoteVideoCard(call.peer, remoteStream);
                updateParticipantCount();
                updateParticipantsList();
            });

            call.on('close', () => removePeer(call.peer));
        });

        // Incoming Data Connection for Chat & Actions
        peerJsInstance.on('connection', (conn) => {
            conn.on('data', (data) => handleIncomingData(data, conn.peer));
        });
    }

    function handleIncomingData(data, senderPeerId) {
        if (data.type === 'chat') {
            appendChatMessage(data);
        } else if (data.type === 'action') {
            const peer = peers[senderPeerId];
            if (peer) {
                if (data.action === 'audio') updatePeerAudioUI(senderPeerId, data.value);
                if (data.action === 'video') updatePeerVideoUI(senderPeerId, data.value);
                if (data.action === 'hand') updatePeerHandUI(senderPeerId, data.value);
            }
        }
    }

    // WEBRTC PEER CONNECTION CREATOR (Local Socket.IO mode)
    function createPeerConnection(peerSid, peerUsername, peerAvatarColor, isInitiator) {
        if (peers[peerSid]) return;

        const pc = new RTCPeerConnection(rtcConfig);

        peers[peerSid] = {
            pc: pc,
            username: peerUsername,
            avatarColor: peerAvatarColor,
            videoCard: null,
            audio: true,
            video: true,
            handRaised: false
        };

        if (localStream) {
            localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
        }

        pc.onicecandidate = (event) => {
            if (event.candidate && socket) {
                socket.emit('signal', {
                    target: peerSid,
                    signal: { candidate: event.candidate }
                });
            }
        };

        pc.ontrack = (event) => {
            createRemoteVideoCard(peerSid, event.streams[0]);
        };

        if (isInitiator) {
            pc.onnegotiationneeded = async () => {
                try {
                    const offer = await pc.createOffer();
                    await pc.setLocalDescription(offer);
                    if (socket) {
                        socket.emit('signal', {
                            target: peerSid,
                            signal: { sdp: pc.localDescription }
                        });
                    }
                } catch (err) {
                    console.error('Error creating SDP offer:', err);
                }
            };
        }

        updateParticipantsList();
    }

    // LOCAL USER VIDEO CARD
    function createLocalVideoCard() {
        const existingCard = document.getElementById(`video-card-${selfSid}`);
        if (existingCard) return;

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

    // REMOTE PEER VIDEO CARD
    function createRemoteVideoCard(peerSid, stream) {
        const peer = peers[peerSid];
        if (!peer) return;

        let card = document.getElementById(`video-card-${peerSid}`);
        if (!card) {
            card = document.createElement('div');
            card.id = `video-card-${peerSid}`;
            card.className = 'video-card';

            const video = document.createElement('video');
            video.autoplay = true;
            video.playsInline = true;
            video.srcObject = stream;

            const avatarOverlay = document.createElement('div');
            avatarOverlay.className = 'video-avatar-overlay';
            avatarOverlay.style.display = peer.video ? 'none' : 'flex';
            avatarOverlay.innerHTML = `
                <div class="video-avatar-circle" style="background: ${peer.avatarColor}">
                    ${peer.username.charAt(0).toUpperCase()}
                </div>
            `;

            const userInfo = document.createElement('div');
            userInfo.className = 'card-user-info';
            userInfo.innerHTML = `
                <i class="fa-solid ${peer.audio ? 'fa-microphone' : 'fa-microphone-slash muted'} audio-status-icon"></i>
                <span>${peer.username}</span>
            `;

            card.appendChild(video);
            card.appendChild(avatarOverlay);
            card.appendChild(userInfo);
            videoGrid.appendChild(card);

            peer.videoCard = card;
            updateGridColumns();
        } else {
            const video = card.querySelector('video');
            if (video) video.srcObject = stream;
        }
    }

    // REMOVE PEER
    function removePeer(peerSid) {
        if (peers[peerSid]) {
            if (peers[peerSid].pc) peers[peerSid].pc.close();
            const card = document.getElementById(`video-card-${peerSid}`);
            if (card) card.remove();
            delete peers[peerSid];
            updateGridColumns();
            updateParticipantCount();
            updateParticipantsList();
        }
    }

    // GRID COLUMNS
    function updateGridColumns() {
        const totalCards = videoGrid.children.length;
        videoGrid.setAttribute('data-peer-count', totalCards);
    }

    // PARTICIPANT LIST
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
        Object.keys(peers).forEach(sid => {
            const peer = peers[sid];
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
    function updatePeerAudioUI(peerSid, enabled) {
        const card = document.getElementById(`video-card-${peerSid}`);
        if (!card) return;
        const icon = card.querySelector('.audio-status-icon');
        if (icon) icon.className = `fa-solid ${enabled ? 'fa-microphone' : 'fa-microphone-slash muted'} audio-status-icon`;
    }

    function updatePeerVideoUI(peerSid, enabled) {
        const card = document.getElementById(`video-card-${peerSid}`);
        if (!card) return;
        const avatarOverlay = card.querySelector('.video-avatar-overlay');
        if (avatarOverlay) avatarOverlay.style.display = enabled ? 'none' : 'flex';
    }

    function updatePeerHandUI(peerSid, raised) {
        const card = document.getElementById(`video-card-${peerSid}`);
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

    // CONTROL BAR LISTENERS
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

            if (socket) socket.emit('user-action', { type: 'audio', value: isAudioEnabled });
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

            if (socket) socket.emit('user-action', { type: 'video', value: isVideoEnabled });
            updateParticipantsList();
        }
    });

    // SCREEN SHARE
    btnScreen.addEventListener('click', async () => {
        if (!isScreenSharing) {
            try {
                screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
                const screenTrack = screenStream.getVideoTracks()[0];

                Object.keys(peers).forEach(sid => {
                    if (peers[sid].pc) {
                        const senders = peers[sid].pc.getSenders();
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
        Object.keys(peers).forEach(sid => {
            if (peers[sid].pc) {
                const senders = peers[sid].pc.getSenders();
                const sender = senders.find(s => s.track && s.track.kind === 'video');
                if (sender && videoTrack) sender.replaceTrack(videoTrack);
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

        if (socket) socket.emit('user-action', { type: 'hand', value: isHandRaised });
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

    // CHAT SUBMISSION
    chatForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const msg = chatInput.value.trim();
        if (!msg) return;

        const chatPayload = {
            senderSid: selfSid,
            username: username,
            avatarColor: avatarColor,
            message: msg,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };

        if (socket) {
            socket.emit('chat-message', chatPayload);
        } else {
            appendChatMessage(chatPayload);
        }

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

    // LEAVE CALL
    btnLeave.addEventListener('click', () => {
        if (confirm('Are you sure you want to leave the call?')) {
            window.location.reload();
        }
    });

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
        timerInterval = setInterval(() => {
            const elapsedSeconds = Math.floor((Date.now() - callStartTime) / 1000);
            const mins = String(Math.floor(elapsedSeconds / 60)).padStart(2, '0');
            const secs = String(elapsedSeconds % 60).padStart(2, '0');
            callTimer.textContent = `${mins}:${secs}`;
        }, 1000);
    }

    // HELPERS
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
