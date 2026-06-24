import React, { useContext } from 'react';
import { SkinContext } from '../skin';

const SUIT_LETTER = { '♠': 'S', '♥': 'H', '♦': 'D', '♣': 'C' };
const RANK_API    = { '10': '0' };
const CSS_SKINS   = new Set(['neon', 'minimal']);
const RED_SUITS   = new Set(['♥', '♦']);

function imgPath(card) {
  const r = RANK_API[card.rank] || card.rank;
  const s = SUIT_LETTER[card.suit];
  return `/cards/${r}${s}.png`;
}

export default function Card({ card, selected, playable = true, onClick, small, tiny }) {
  const [skin] = useContext(SkinContext);
  if (!card) return null;

  const classes = [
    'card',
    selected   ? 'selected'   : '',
    !playable  ? 'unplayable' : '',
    onClick    ? 'clickable'  : '',
    small      ? 'small'      : '',
    tiny       ? 'tiny'       : '',
  ].filter(Boolean).join(' ');

  const isCss = CSS_SKINS.has(skin);
  const isRed = RED_SUITS.has(card.suit);

  return (
    <div className={classes} onClick={onClick}>
      {isCss ? (
        <div className={`card-face ${isRed ? 'cf-red' : 'cf-black'}`}>
          <div className="cf-corner cf-tl">
            <span>{card.rank}</span>
            <span>{card.suit}</span>
          </div>
          <span className="cf-center">{card.suit}</span>
          <div className="cf-corner cf-br">
            <span>{card.rank}</span>
            <span>{card.suit}</span>
          </div>
        </div>
      ) : (
        <img src={imgPath(card)} alt={`${card.rank}${card.suit}`} className="card-img" draggable={false} />
      )}
    </div>
  );
}
