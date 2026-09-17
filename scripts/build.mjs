import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['ui/app.tsx'], bundle: true, minify: true, format: 'esm', target: 'es2022', outfile: 'dist/app.js', jsx: 'automatic', jsxImportSource: 'preact' });
await copyFile('ui/index.html', 'dist/index.html');
console.log('Built local GUI. No CDN or remote frontend dependencies.');
