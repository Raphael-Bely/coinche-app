import { createContext, useContext } from 'react';

// All skins use real card images — face cards always visible
export const SKINS = [
  { id: 'classic', label: 'Classique' },
  { id: 'vintage', label: 'Vintage'   },
  { id: 'nuit',    label: 'Nuit'      },
  { id: 'neon',    label: 'Néon'      },
];

export const SkinContext = createContext(['classic', () => {}]);
export const useSkin = () => useContext(SkinContext);
