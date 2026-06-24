import { createContext, useContext } from 'react';

export const SKINS = [
  { id: 'classic',  label: 'Classique',   cssOnly: false },
  { id: 'vintage',  label: 'Vintage',     cssOnly: false },
  { id: 'night',    label: 'Nuit',        cssOnly: false },
  { id: 'neon',     label: 'Néon',        cssOnly: true  },
  { id: 'minimal',  label: 'Minimaliste', cssOnly: true  },
];

export const SkinContext = createContext(['classic', () => {}]);
export const useSkin = () => useContext(SkinContext);
