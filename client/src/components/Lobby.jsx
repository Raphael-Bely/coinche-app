import React, { useState, useContext, useEffect } from 'react';
import socket from '../socket';
import { SkinContext, SKINS } from '../skin';
import Badge, { getTier } from './Badge';
import AccountModal from './AccountModal';

const SCORING_MODES = [
  { value: 'net',          label: 'Contrat net',           desc: 'Marque la valeur du contrat ; si chute, l\'adversaire prend 160' },
  { value: 'reel',         label: 'Points réels',          desc: 'Chaque équipe marque ses vrais points de plis ; si chute l\'adversaire prend tout' },
  { value: 'reel_contrat', label: 'Points réels + contrat', desc: 'Points réels + valeur du contrat en bonus si réussi' },
];

export default function Lobby() {
  const [skin, setSkin] = useContext(SkinContext);
  const [view,    setView]    = useState('main');
  const [name,    setName]    = useState(() => localStorage.getItem('coincheName') || '');
  const [code,    setCode]    = useState('');
  const [settings, setSettings] = useState({
    maxPoints:      1000,
    scoringMode:    'net',
    beloteFrom:     80,
    countAnnounces: false,
    public:         false,
  });
  const [publicRooms,  setPublicRooms]  = useState([]);
  const [myStats,      setMyStats]      = useState(null);
  const [accountInfo,  setAccountInfo]  = useState(() => {
    try { return JSON.parse(localStorage.getItem('coincheAccount') || 'null'); } catch { return null; }
  });
  const [showAccount, setShowAccount] = useState(false);
  const [leaderboard, setLeaderboard] = useState(null);

  const [myUuid] = useState(() => {
    let uuid = localStorage.getItem('coincheUUID');
    if (!uuid) { uuid = crypto.randomUUID(); localStorage.setItem('coincheUUID', uuid); }
    return uuid;
  });

  const set = (k, v) => setSettings(s => ({ ...s, [k]: v }));

  useEffect(() => {
    socket.emit('my_stats', { uuid: myUuid });
    socket.on('rooms_list',   setPublicRooms);
    socket.on('stats_update', s => {
      setMyStats(s);
      if (accountInfo) {
        const newTier = getTier(s.pointsScored);
        if (newTier !== accountInfo.tier) {
          const updated = { ...accountInfo, tier: newTier };
          setAccountInfo(updated);
          localStorage.setItem('coincheAccount', JSON.stringify(updated));
        }
      }
    });
    return () => {
      socket.off('rooms_list',   setPublicRooms);
      socket.off('stats_update');
    };
  }, [myUuid]);

  function handleLogin(info) {
    setAccountInfo(info);
    localStorage.setItem('coincheAccount', JSON.stringify(info));
    // Switch UUID to account's canonical UUID so stats carry over
    localStorage.setItem('coincheUUID', info.uuid);
    socket.emit('my_stats', { uuid: info.uuid });
    // Auto-fill name
    if (info.name) saveName(info.name);
  }

  function handleLogout() {
    setAccountInfo(null);
    localStorage.removeItem('coincheAccount');
  }

  function loadPublicRooms() {
    socket.emit('list_rooms');
    setView('public');
  }

  async function loadLeaderboard() {
    try {
      const r = await fetch('/api/leaderboard');
      const data = await r.json();
      setLeaderboard(data);
      setView('leaderboard');
    } catch {
      setLeaderboard([]);
      setView('leaderboard');
    }
  }

  function saveName(n) {
    setName(n);
    if (n.trim()) localStorage.setItem('coincheName', n.trim());
  }

  function doCreate() {
    if (!name.trim()) return;
    localStorage.setItem('coincheName', name.trim());
    socket.emit('create_room', { name: name.trim(), settings, uuid: myUuid });
  }

  function doJoin() {
    if (!name.trim() || !code.trim()) return;
    localStorage.setItem('coincheName', name.trim());
    socket.emit('join_room', { name: name.trim(), code: code.trim().toUpperCase(), uuid: myUuid });
  }

  function joinPublic(roomCode) {
    if (!name.trim()) return;
    localStorage.setItem('coincheName', name.trim());
    socket.emit('join_room', { name: name.trim(), code: roomCode, uuid: myUuid });
  }

  return (
    <div className="lobby">
      {/* Account corner */}
      <div className="account-corner">
        {accountInfo ? (
          <div className="acc-info" onClick={() => setShowAccount(true)} title="Mon compte">
            <Badge tier={accountInfo.tier ?? 0} size="md" />
            <span className="acc-corner-name">{accountInfo.name}</span>
          </div>
        ) : (
          <button className="btn-account" onClick={() => setShowAccount(true)}>
            Se connecter
          </button>
        )}
      </div>

      {showAccount && (
        <AccountModal
          myUuid={myUuid}
          onClose={() => setShowAccount(false)}
          onLogin={handleLogin}
        />
      )}

      <div className="lobby-hero">
        <div className="lobby-suits">♠ ♥ ♦ ♣</div>
        <h1>Coinche</h1>
        <p className="lobby-sub">Belote avec enchères &amp; contrat</p>
      </div>

      {view === 'main' && (
        <div className="lobby-card">
          <div className="field">
            <label>Ton prénom</label>
            <input value={name} onChange={e => saveName(e.target.value)}
              placeholder="Ex : Thomas" maxLength={20}
              onKeyDown={e => e.key === 'Enter' && name.trim() && setView('create')} />
          </div>
          <div className="lobby-actions">
            <button className="btn-primary" onClick={() => name.trim() && setView('create')}>
              Créer une partie
            </button>
            <button className="btn-secondary" onClick={() => name.trim() && setView('join')}>
              Rejoindre (code)
            </button>
            <button className="btn-secondary" onClick={() => { if (name.trim()) loadPublicRooms(); }}>
              🌐 Parties publiques
            </button>
            <button className="btn-secondary" onClick={loadLeaderboard}>
              🏆 Classement
            </button>
          </div>
          {!name.trim() && <p className="hint">Entre ton prénom pour continuer</p>}

          {myStats && (myStats.roundsPlayed > 0 || myStats.gamesPlayed > 0) && (
            <div className="my-stats-bar">
              <Badge tier={accountInfo?.tier ?? getTier(myStats.pointsScored)} size="sm" />
              <span title="Manches gagnées / jouées">🏆 {myStats.roundsWon}/{myStats.roundsPlayed} manches</span>
              <span className="stats-sep">·</span>
              <span title="Parties gagnées / jouées">🎮 {myStats.gamesWon}/{myStats.gamesPlayed} parties</span>
              <span className="stats-sep">·</span>
              <span title="Points marqués">{myStats.pointsScored.toLocaleString()} pts</span>
            </div>
          )}

          <div className="skin-picker">
            <div className="skin-picker-lbl">Apparence des cartes</div>
            <div className="skin-opts">
              {SKINS.map(s => (
                <button key={s.id}
                  className={`skin-opt skin-opt-${s.id} ${skin === s.id ? 'active' : ''}`}
                  onClick={() => setSkin(s.id)}>
                  <div className="sp-card">
                    <img src="/cards/KH.png" className="sp-preview-img" draggable={false} alt={s.label} />
                  </div>
                  <span className="skin-opt-lbl">{s.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {view === 'create' && (
        <div className="lobby-card lobby-wide">
          <button className="btn-back" onClick={() => setView('main')}>← Retour</button>
          <h2>Nouvelle partie</h2>

          <div className="field">
            <label>Ton prénom</label>
            <input value={name} onChange={e => saveName(e.target.value)} maxLength={20} />
          </div>

          <div className="settings-grid">
            <div className="setting-group">
              <label>Score maximum</label>
              <div className="btn-group">
                {[500, 1000, 2000, 5000].map(v => (
                  <button key={v}
                    className={`btn-opt ${settings.maxPoints === v ? 'active' : ''}`}
                    onClick={() => set('maxPoints', v)}>{v}</button>
                ))}
              </div>
            </div>

            <div className="setting-group full">
              <label>Mode de score</label>
              <div className="scoring-modes">
                {SCORING_MODES.map(m => (
                  <label key={m.value} className={`mode-opt ${settings.scoringMode === m.value ? 'active' : ''}`}>
                    <input type="radio" name="mode" value={m.value}
                      checked={settings.scoringMode === m.value}
                      onChange={() => set('scoringMode', m.value)} />
                    <span className="mode-label">{m.label}</span>
                    <span className="mode-desc">{m.desc}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="setting-group">
              <label>Belote</label>
              <div className="btn-group">
                {[{ v: 80, label: '80+' }, { v: 100, label: '100+' }, { v: 'off', label: 'Désactivée' }].map(({ v, label }) => (
                  <button key={v}
                    className={`btn-opt ${settings.beloteFrom === v ? 'active' : ''}`}
                    onClick={() => set('beloteFrom', v)}>
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="setting-group">
              <label>Annonces de jeu</label>
              <div className="btn-group">
                <button className={`btn-opt ${settings.countAnnounces ? 'active' : ''}`}
                  onClick={() => set('countAnnounces', true)}>Activées</button>
                <button className={`btn-opt ${!settings.countAnnounces ? 'active' : ''}`}
                  onClick={() => set('countAnnounces', false)}>Désactivées</button>
              </div>
            </div>

            <div className="setting-group">
              <label>Visibilité</label>
              <div className="btn-group">
                <button className={`btn-opt ${!settings.public ? 'active' : ''}`}
                  onClick={() => set('public', false)}>🔒 Privée</button>
                <button className={`btn-opt ${settings.public ? 'active' : ''}`}
                  onClick={() => set('public', true)}>🌐 Publique</button>
              </div>
            </div>
          </div>

          <button className="btn-primary large" onClick={doCreate} disabled={!name.trim()}>
            Créer la partie
          </button>
        </div>
      )}

      {view === 'join' && (
        <div className="lobby-card">
          <button className="btn-back" onClick={() => setView('main')}>← Retour</button>
          <h2>Rejoindre</h2>
          <div className="field">
            <label>Ton prénom</label>
            <input value={name} onChange={e => saveName(e.target.value)} maxLength={20} />
          </div>
          <div className="field">
            <label>Code de la salle</label>
            <input
              className="code-input"
              value={code}
              onChange={e => setCode(e.target.value.toUpperCase())}
              placeholder="XXXXX" maxLength={5}
              onKeyDown={e => e.key === 'Enter' && doJoin()}
            />
          </div>
          <button className="btn-primary large" onClick={doJoin}
            disabled={!name.trim() || code.trim().length < 4}>
            Rejoindre
          </button>
        </div>
      )}

      {view === 'public' && (
        <div className="lobby-card">
          <button className="btn-back" onClick={() => setView('main')}>← Retour</button>
          <h2>🌐 Parties publiques</h2>
          {!name.trim() && <p className="hint">Entre ton prénom en revenant en arrière</p>}
          <button className="btn-secondary" onClick={() => socket.emit('list_rooms')} style={{alignSelf:'flex-start',fontSize:'12px'}}>
            ↻ Actualiser
          </button>
          {publicRooms.length === 0 ? (
            <p className="hint">Aucune partie publique disponible pour l'instant.</p>
          ) : (
            <div className="public-rooms-list">
              {publicRooms.map(r => (
                <div key={r.code} className="public-room-row">
                  <div className="pr-info">
                    <span className="pr-code">{r.hostName}</span>
                    <span className="pr-detail">{r.players}/4 joueurs · {r.maxPoints} pts</span>
                  </div>
                  <button className="btn-primary" disabled={!name.trim()}
                    onClick={() => joinPublic(r.code)}>
                    Rejoindre
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {view === 'leaderboard' && (
        <div className="lobby-card leaderboard-card">
          <button className="btn-back" onClick={() => setView('main')}>← Retour</button>
          <h2>🏆 Classement</h2>
          {!leaderboard ? (
            <p className="hint">Chargement…</p>
          ) : leaderboard.length === 0 ? (
            <p className="hint">Aucun compte enregistré pour le moment.</p>
          ) : (
            <div className="lb-table">
              <div className="lb-header">
                <span className="lb-rank">#</span>
                <span className="lb-badge-col"></span>
                <span className="lb-name">Joueur</span>
                <span className="lb-pts">Points</span>
                <span className="lb-games">Parties</span>
              </div>
              {leaderboard.map((row, i) => (
                <div key={row.name} className={`lb-row ${row.name === accountInfo?.name ? 'lb-me' : ''}`}>
                  <span className="lb-rank">{i + 1}</span>
                  <span className="lb-badge-col"><Badge tier={row.tier} size="sm" /></span>
                  <span className="lb-name">{row.name}</span>
                  <span className="lb-pts">{row.pointsScored.toLocaleString()}</span>
                  <span className="lb-games">{row.gamesWon}/{row.gamesPlayed}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
