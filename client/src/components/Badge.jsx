import React from 'react';

export const TIERS = [
  { name: 'Novice',       pts: 0,     bg: 'linear-gradient(145deg,#9e9e9e,#424242)',     border: '#757575' },
  { name: 'Apprenti',     pts: 500,   bg: 'linear-gradient(145deg,#d4a574,#7d4524)',     border: '#a0522d' },
  { name: 'Confirmé',     pts: 2000,  bg: 'linear-gradient(145deg,#e8e8e8,#8a9096)',     border: '#b0bec5' },
  { name: 'Expert',       pts: 5000,  bg: 'linear-gradient(145deg,#ffd740,#b8860b)',     border: '#ffc107' },
  { name: 'Maître',       pts: 10000, bg: 'linear-gradient(145deg,#4dd0e1,#006064)',     border: '#00bcd4' },
  { name: 'Grand Maître', pts: 25000, bg: 'linear-gradient(145deg,#ce93d8,#6a1b9a)',     border: '#ab47bc' },
  { name: 'Légende',      pts: 50000, bg: 'linear-gradient(145deg,#ff6e6e,#7f0000)',     border: '#f44336' },
];

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

export function getTier(points) {
  for (let i = TIERS.length - 1; i >= 0; i--)
    if ((points || 0) >= TIERS[i].pts) return i;
  return 0;
}

export default function Badge({ tier = 0, size = 'md' }) {
  const t = TIERS[Math.min(tier, TIERS.length - 1)];
  return (
    <span
      className={`badge-hex badge-${size} badge-tier-${tier}`}
      style={{ background: t.bg, '--badge-border': t.border }}
      title={`${t.name} (${t.pts.toLocaleString()}+ pts)`}
    >
      {ROMAN[tier]}
    </span>
  );
}
