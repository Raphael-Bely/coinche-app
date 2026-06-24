import React, { useState, useEffect, useRef } from 'react';
import socket from '../socket';

const STUN = { iceServers: [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]};

export default function VoiceChat({ myInfo }) {
  const [joined,     setJoined]     = useState(false);
  const [voiceUsers, setVoiceUsers] = useState([]);
  const [muted,      setMuted]      = useState(false);
  const [error,      setError]      = useState('');

  const localStream = useRef(null);
  const pcs         = useRef({});   // peerSocketId → RTCPeerConnection
  const audioEls    = useRef({});   // peerSocketId → Audio

  // Cleanup on unmount
  useEffect(() => () => { doCleanup(); }, []);

  function doCleanup() {
    Object.values(pcs.current).forEach(pc => pc.close());
    pcs.current = {};
    Object.values(audioEls.current).forEach(a => { a.srcObject = null; });
    audioEls.current = {};
    localStream.current?.getTracks().forEach(t => t.stop());
    localStream.current = null;
  }

  // Wire socket events once
  useEffect(() => {
    function makePc(peerSocketId) {
      const pc = new RTCPeerConnection(STUN);
      pcs.current[peerSocketId] = pc;

      localStream.current?.getTracks().forEach(t =>
        pc.addTrack(t, localStream.current)
      );

      pc.onicecandidate = ({ candidate }) => {
        if (candidate) socket.emit('voice_signal', {
          to: peerSocketId, signal: { type: 'candidate', candidate }
        });
      };

      pc.ontrack = ({ streams: [s] }) => {
        if (!audioEls.current[peerSocketId]) {
          audioEls.current[peerSocketId] = new Audio();
          audioEls.current[peerSocketId].autoplay = true;
        }
        audioEls.current[peerSocketId].srcObject = s;
        audioEls.current[peerSocketId].play().catch(() => {});
      };

      pc.onconnectionstatechange = () => {
        if (['failed','closed'].includes(pc.connectionState)) {
          pc.close();
          delete pcs.current[peerSocketId];
        }
      };
      return pc;
    }

    function onVoiceUsers(users) { setVoiceUsers(users); }

    async function onVoicePeers(peers) {
      // We just joined — initiate to every existing peer
      for (const p of peers) {
        const pc    = makePc(p.socketId);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('voice_signal', { to: p.socketId, signal: { type: 'offer', sdp: offer.sdp } });
      }
    }

    function onVoicePeerJoined({ socketId }) {
      // New peer will send us an offer — prepare the PC now
      if (!pcs.current[socketId]) makePc(socketId);
    }

    function onVoicePeerLeft({ socketId }) {
      pcs.current[socketId]?.close();
      delete pcs.current[socketId];
      if (audioEls.current[socketId]) {
        audioEls.current[socketId].srcObject = null;
        delete audioEls.current[socketId];
      }
    }

    async function onVoiceSignal({ from, signal }) {
      let pc = pcs.current[from] ?? makePc(from);
      if (signal.type === 'offer') {
        await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('voice_signal', { to: from, signal: { type: 'answer', sdp: answer.sdp } });
      } else if (signal.type === 'answer') {
        await pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
      } else if (signal.type === 'candidate') {
        try { await pc.addIceCandidate(signal.candidate); } catch {}
      }
    }

    socket.on('voice_users',       onVoiceUsers);
    socket.on('voice_peers',       onVoicePeers);
    socket.on('voice_peer_joined', onVoicePeerJoined);
    socket.on('voice_peer_left',   onVoicePeerLeft);
    socket.on('voice_signal',      onVoiceSignal);

    return () => {
      socket.off('voice_users',       onVoiceUsers);
      socket.off('voice_peers',       onVoicePeers);
      socket.off('voice_peer_joined', onVoicePeerJoined);
      socket.off('voice_peer_left',   onVoicePeerLeft);
      socket.off('voice_signal',      onVoiceSignal);
    };
  }, []);

  async function joinVoice() {
    setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      localStream.current = stream;
      setJoined(true);
      socket.emit('voice_join');
    } catch {
      setError('Micro inaccessible');
    }
  }

  function leaveVoice() {
    socket.emit('voice_leave');
    doCleanup();
    setJoined(false);
    setMuted(false);
  }

  function toggleMute() {
    localStream.current?.getAudioTracks().forEach(t => { t.enabled = muted; });
    setMuted(m => !m);
  }

  return (
    <div className="voice-chat">
      <div className="vc-header">
        <span className="vc-icon">🎤</span>
        <span className="vc-title">Vocal</span>
        {voiceUsers.length > 0 && <span className="vc-count">{voiceUsers.length}</span>}
      </div>

      <div className="vc-users">
        {voiceUsers.length === 0
          ? <span className="vc-empty">Personne</span>
          : voiceUsers.map(u => (
            <div key={u.playerIdx} className={`vc-user ${u.playerIdx === myInfo.playerIdx ? 'vc-me' : ''}`}>
              <span className="vc-dot" />
              <span className="vc-uname">
                {u.name}{u.playerIdx === myInfo.playerIdx ? ' (moi)' : ''}
              </span>
            </div>
          ))
        }
      </div>

      {error && <div className="vc-error">{error}</div>}

      <div className="vc-actions">
        {!joined ? (
          <button className="btn-vc vc-join" onClick={joinVoice}>Rejoindre</button>
        ) : (
          <>
            <button className={`btn-vc vc-mute ${muted ? 'is-muted' : ''}`} onClick={toggleMute}>
              {muted ? '🔇 Muet' : '🎙 Actif'}
            </button>
            <button className="btn-vc vc-leave" onClick={leaveVoice}>Partir</button>
          </>
        )}
      </div>
    </div>
  );
}
