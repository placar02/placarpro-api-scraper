import './config/env';

console.log('ENV LOADED - NODE_ENV:', process.env.NODE_ENV);
console.log('ENV LOADED - SCORES_PROVIDER:', process.env.SCORES_PROVIDER);

import { startServer } from './server.js';

startServer();

//teste
