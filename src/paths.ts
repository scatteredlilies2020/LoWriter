import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
export function dataDir(): string { return process.env.LOWRITER_DATA_DIR ? resolve(process.env.LOWRITER_DATA_DIR) : join(homedir(), '.lowriter'); }
