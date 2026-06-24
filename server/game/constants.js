'use strict';

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

// Point values by mode
const PLAIN_VALUES = { '7': 0, '8': 0, '9': 0, '10': 10, 'J': 2, 'Q': 3, 'K': 4, 'A': 11 };
const TRUMP_VALUES = { '7': 0, '8': 0, '9': 14, '10': 10, 'J': 20, 'Q': 3, 'K': 4, 'A': 11 };
const SA_VALUES    = { '7': 0, '8': 0, '9': 0,  '10': 10, 'J': 2,  'Q': 3, 'K': 4, 'A': 19 };
// Tout-Atout: all suits are trump but with reduced values to keep total ≈162
const TA_VALUES    = { '7': 0, '8': 0, '9': 9,  '10': 5,  'J': 14, 'Q': 1, 'K': 3, 'A': 6  };

// Trick strength (higher wins within same suit comparison)
const PLAIN_STRENGTH = { '7': 0, '8': 1, '9': 2, 'J': 3, 'Q': 4, 'K': 5, '10': 6, 'A': 7 };
const TRUMP_STRENGTH = { '7': 0, '8': 1, 'Q': 2, 'K': 3, '10': 4, 'A': 5, '9': 6, 'J': 7 };

// Canonical order for sequence detection (7 < 8 < 9 < 10 < J < Q < K < A)
const SEQ_ORDER     = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const SEQ_ORDER_IDX = Object.fromEntries(SEQ_ORDER.map((r, i) => [r, i]));

const BID_STEPS       = [80, 90, 100, 110, 120, 130, 140, 150, 160, 'Capot'];
const CONTRACT_SUITS  = ['♠', '♥', '♦', '♣', 'SA', 'TA'];

// Announcement definitions: pts = value, tier = comparison priority (higher beats lower)
const ANNOUNCE_DEFS = {
  carre_J:  { pts: 200, tier: 10, label: 'Carré de Valets' },
  carre_9:  { pts: 150, tier: 9,  label: 'Carré de 9'      },
  carre_A:  { pts: 100, tier: 7,  label: "Carré d'As"      },
  carre_10: { pts: 100, tier: 7,  label: 'Carré de 10'     },
  carre_K:  { pts: 100, tier: 7,  label: 'Carré de Rois'   },
  carre_Q:  { pts: 100, tier: 7,  label: 'Carré de Dames'  },
  quinte:   { pts: 100, tier: 6,  label: 'Quinte'          },
  quarte:   { pts: 50,  tier: 5,  label: 'Quarte'          },
  tierce:   { pts: 20,  tier: 4,  label: 'Tierce'          },
};

module.exports = {
  SUITS, RANKS,
  PLAIN_VALUES, TRUMP_VALUES, SA_VALUES, TA_VALUES,
  PLAIN_STRENGTH, TRUMP_STRENGTH,
  SEQ_ORDER, SEQ_ORDER_IDX,
  BID_STEPS, CONTRACT_SUITS,
  ANNOUNCE_DEFS,
};
