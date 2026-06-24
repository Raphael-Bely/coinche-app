import React, { useState, useEffect, useCallback } from 'react';
import socket from './socket';
import Lobby from './components/Lobby';
import GameBoard from './components/GameBoard';

export default function App() {
  const [screen,  setScreen]  = useState('lobby');
  const [myInfo,  setMyInfo]  = useState(null);   // { code, playerIdx }
  const [gs,      setGs]      = useState(null);   // full game state
  const [toasts,  setToasts]  = useState([]);
  const [error,   setError]   = useState('');

  const toast = useCallback((msg) => {
    const id = Date.now() + Math.random();
    setToasts(t => [...t, { id, msg }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 4500);
  }, []);

  const leaveGame = useCallback(() => {
    socket.disconnect();
    setScreen('lobby');
    setMyInfo(null);
    setGs(null);
    setTimeout(() => socket.connect(), 100);
  }, []);

  useEffect(() => {
    socket.connect();
    socket.on('joined',  ({ code, playerIdx }) => { setMyInfo({ code, playerIdx }); setScreen('game'); });
    socket.on('state',   (s)   => setGs(s));
    socket.on('notify',  (msg) => toast(msg));
    socket.on('err',     (msg) => { setError(msg); setTimeout(() => setError(''), 3000); });
    return () => socket.disconnect();
  }, [toast]);

  return (
    <div className="app">
      {error && <div className="error-toast">{error}</div>}
      <div className="toasts">
        {toasts.map(t => <div key={t.id} className="notify-toast">{t.msg}</div>)}
      </div>
      {screen === 'lobby' && <Lobby />}
      {screen === 'game'  && gs && myInfo && <GameBoard gs={gs} myInfo={myInfo} onLeave={leaveGame} />}
    </div>
  );
}
