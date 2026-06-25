import React from 'react';

const SUIT_LETTER = { '♠': 'S', '♥': 'H', '♦': 'D', '♣': 'C' };
const RANK_FILE   = { '10': '0' };

function imgPath(card) {
  const r = RANK_FILE[card.rank] || card.rank;
  const s = SUIT_LETTER[card.suit];
  return `/cards/${r}${s}.png`;
}

export default function Card({ card, selected, playable = true, onClick, small, tiny }) {
  if (!card) return null;

  const classes = [
    'card',
    selected  ? 'selected'   : '',
    !playable ? 'unplayable' : '',
    onClick   ? 'clickable'  : '',
    small     ? 'small'      : '',
    tiny      ? 'tiny'       : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={classes} onClick={onClick}>
      <img src={imgPath(card)} alt={`${card.rank}${card.suit}`} className="card-img" draggable={false} loading="eager" />
    </div>
  );
}
