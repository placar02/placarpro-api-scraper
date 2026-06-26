import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const configDir = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(configDir, '..', '..');
export const envPath = path.join(projectRoot, '.env');

dotenv.config({ path: envPath, override: true });
