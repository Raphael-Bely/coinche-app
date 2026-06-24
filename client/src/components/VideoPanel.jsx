import React, { useState, useEffect, useRef } from 'react';
import socket from '../socket';

const STUN = { iceServers: [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]};

export default function VideoPanel({ myInfo }) {
  const [on,         setOn]         = useState(false);
  const [videoUsers, setVideoUsers] = useState([]); // {playerIdx, name, socketId}

  const localStream    = useRef(null);
  const localVideoRef  = useRef(null);
  const pcs            = useRef({});            // peerSocketId → RTCPeerConnection
  const remoteStreams  = useRef({});            // peerSocketId → MediaStream
  const remoteVidRefs  = useRef({});            // peerSocketId → <video> element

  useEffect(() => () => cleanup(), []);

  function cleanup() {
    Object.values(pcs.current).forEach(pc => pc.close());
    pcs.current = {};
    remoteStreams.current = {};
    localStream.current?.getTracks().forEach(t => t.stop());
    localStream.current = null;
  }

  useEffect(() => {
    function makePc(peerId) {
      const pc = new RTCPeerConnection(STUN);
      pcs.current[peerId] = pc;

      localStream.current?.getTracks().forEach(t =>
        pc.addTrack(t, localStream.current)
      );

      pc.onicecandidate = ({ candidate }) => {
        if (candidate) socket.emit('video_signal', { to: peerId, signal: { type: 'candidate', candidate } });
      };

      pc.ontrack = ({ streams: [s] }) => {
        remoteStreams.current[peerId] = s;
        if (remoteVidRefs.current[peerId]) remoteVidRefs.current[peerId].srcObject = s;
      };

      return pc;
    }

    function onVideoUsers(u) { setVideoUsers(u); }

    async function onVideoPeers(peers) {
      for (const p of peers) {
        const pc    = makePc(p.socketId);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('video_signal', { to: p.socketId, signal: { type: 'offer', sdp: offer.sdp } });
      }
    }

    function onVideoPeerJoined({ socketId }) {
      if (!pcs.current[socketId]) makePc(socketId);
    }

    function onVideoPeerLeft({ socketId }) {
      pcs.current[socketId]?.close();
      delete pcs.current[socketId];
      delete remoteStreams.current[socketId];
    }

    async function onVideoSignal({ from, signal }) {
      const pc = pcs.current[from] ?? makePc(from);
      if (signal.type === 'offer') {
        await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        socket.emit('video_signal', { to: from, signal: { type: 'answer', sdp: ans.sdp } });
      } else if (signal.type === 'answer') {
        await pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
      } else if (signal.type === 'candidate') {
        try { await pc.addIceCandidate(signal.candidate); } catch {}
      }
    }

    socket.on('video_users',       onVideoUsers);
    socket.on('video_peers',       onVideoPeers);
    socket.on('video_peer_joined', onVideoPeerJoined);
    socket.on('video_peer_left',   onVideoPeerLeft);
    socket.on('video_signal',      onVideoSignal);
    return () => {
      socket.off('video_users',       onVideoUsers);
      socket.off('video_peers',       onVideoPeers);
      socket.off('video_peer_joined', onVideoPeerJoined);
      socket.off('video_peer_left',   onVideoPeerLeft);
      socket.off('video_signal',      onVideoSignal);
    };
  }, []);

  async function toggleCamera() {
    if (!on) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        localStream.current = stream;
        if (localVideoRef.current) localVideoRef.current.srcObject = stream;
        setOn(true);
        socket.emit('video_join');
      } catch { /* caméra refusée */ }
    } else {
      socket.emit('video_leave');
      cleanup();
      setOn(false);
    }
  }

  // Sync local video element when it mounts after setOn(true)
  useEffect(() => {
    if (on && localVideoRef.current && localStream.current)
      localVideoRef.current.srcObject = localStream.current;
  }, [on]);

  const remotesWithCam = videoUsers.filter(u => u.playerIdx !== myInfo.playerIdx);

  return (
    <div className="video-panel">
      {/* Tiles: my cam + remote cams */}
      {(on || remotesWithCam.length > 0) && (
        <div className="vp-tiles">
          {on && (
            <div className="vp-tile vp-local">
              <video ref={localVideoRef} autoPlay muted playsInline className="vp-vid" />
              <span className="vp-label">Moi</span>
            </div>
          )}
          {remotesWithCam.map(u => (
            <div key={u.socketId} className="vp-tile">
              <video
                autoPlay playsInline className="vp-vid"
                ref={el => {
                  if (el) {
                    remoteVidRefs.current[u.socketId] = el;
                    if (remoteStreams.current[u.socketId])
                      el.srcObject = remoteStreams.current[u.socketId];
                  }
                }}
              />
              <span className="vp-label">{u.name}</span>
            </div>
          ))}
        </div>
      )}

      <button className={`btn-cam ${on ? 'cam-on' : ''}`} onClick={toggleCamera}>
        {on ? '📷 ON' : '📷'}
      </button>
    </div>
  );
}
