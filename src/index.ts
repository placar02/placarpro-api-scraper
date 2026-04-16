import dotenv from 'dotenv';

dotenv.config();

console.log('ENV LOADED - NODE_ENV:', process.env.NODE_ENV);

import { startServer } from './server.js';

startServer();