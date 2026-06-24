import { io } from 'socket.io-client';
// No URL → se connecte à l'origine de la page (passera par le proxy Vite → port 3001)
const socket = io({ autoConnect: false });
export default socket;
