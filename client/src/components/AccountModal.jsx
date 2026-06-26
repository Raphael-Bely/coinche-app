import React, { useState } from 'react';
import socket from '../socket';
import Badge, { getTier } from './Badge';

export default function AccountModal({ onClose, onLogin, myUuid }) {
  const [tab,    setTab]    = useState('login');   // 'login' | 'create'
  const [name,   setName]   = useState('');
  const [pin,    setPin]    = useState('');
  const [error,  setError]  = useState('');
  const [loading, setLoading] = useState(false);

  function submit() {
    if (!name.trim() || pin.length !== 4) return;
    setError('');
    setLoading(true);

    const handler = (r) => {
      setLoading(false);
      socket.off('account_result', handler);
      if (r.error) { setError(r.error); return; }
      onLogin({ name: r.name, tier: r.tier ?? getTier(r.stats?.pointsScored ?? 0), uuid: r.uuid });
      onClose();
    };

    socket.on('account_result', handler);

    if (tab === 'login') {
      socket.emit('account_login', { name: name.trim(), pin });
    } else {
      socket.emit('account_create', { name: name.trim(), pin });
    }
  }

  function onKey(e) {
    if (e.key === 'Enter') submit();
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="account-modal" onClick={e => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>✕</button>
        <h2 className="modal-title">Mon compte</h2>

        <div className="acc-tabs">
          <button className={`acc-tab ${tab === 'login'  ? 'active' : ''}`} onClick={() => { setTab('login');  setError(''); }}>Se connecter</button>
          <button className={`acc-tab ${tab === 'create' ? 'active' : ''}`} onClick={() => { setTab('create'); setError(''); }}>Créer un compte</button>
        </div>

        <div className="field">
          <label>Nom</label>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={onKey}
            placeholder="Ton nom"
            maxLength={20}
            autoFocus
          />
        </div>

        <div className="field">
          <label>PIN (4 chiffres)</label>
          <input
            type="password"
            inputMode="numeric"
            pattern="\d{4}"
            value={pin}
            onChange={e => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
            onKeyDown={onKey}
            placeholder="••••"
            maxLength={4}
          />
        </div>

        {error && <p className="acc-error">{error}</p>}

        <button
          className="btn-primary large"
          onClick={submit}
          disabled={loading || !name.trim() || pin.length !== 4}
        >
          {loading ? '…' : tab === 'login' ? 'Se connecter' : 'Créer le compte'}
        </button>

        {tab === 'create' && (
          <div className="badge-tiers-preview">
            <p className="tiers-label">Badges débloqués selon tes points</p>
            {[0,1,2,3,4,5,6].map(i => (
              <div key={i} className="tier-row">
                <Badge tier={i} size="sm" />
                <span className="tier-name">{['Novice','Apprenti','Confirmé','Expert','Maître','Grand Maître','Légende'][i]}</span>
                <span className="tier-pts">{[0,500,2000,5000,10000,25000,50000][i].toLocaleString()} pts</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
