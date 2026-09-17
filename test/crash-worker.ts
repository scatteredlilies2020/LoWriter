import { startServer } from '../src/server.ts';
import { startMock } from '../src/mock.ts';
const mock = await startMock();
const app = await startServer({ dataDir: process.env.LOWRITER_DATA_DIR!, port: 0, demo: { endpoint: mock.endpoint, model: 'crash-fixture', route: 'direct', dialect: 'chat-completions' } });
const c = app.store.create('rp', 'Crash fixture'); const job = app.engine.start(c.id, '[slow]', 0);
setTimeout(() => process.send?.({ conversation: c.id, job: job.id }), 300);
