import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDir } from './paths.ts';
import { createInterface } from 'node:readline/promises';
import type { Conversation, Job } from './shared.ts';

const [command = 'help', ...args] = process.argv.slice(2);
if (command === 'help') {
  console.log(`LoWriter CLI — uses the same coordinator as the GUI; never opens a browser.
  list                         List the newest 100 conversations
  new coding|rp [title]        Create a conversation
  show ID                     Show the latest 40 persisted messages and job status
  chat ID                     Interactive coding/chat session; /exit to leave
  send ID MESSAGE             Stream one reply (Ctrl+C cancels the job)
  project ID ABSOLUTE_PATH     Select a local folder WITHOUT granting trust
  trust ID                    Explicitly grant local project-file tools
  revoke ID                   Revoke project tools
  cancel JOB_ID               Stop a job
  stop                        Emergency stop for all jobs
  quit                        Stop jobs and shut down the local service
  restore ID CHECKPOINT_ID    Restore only if the edited file is unchanged
  pair                        Display browser pairing code locally (not an API key)
Connection configuration and one-time legacy credential migration use the local GUI. Saved credentials open automatically; keys/passphrases are never CLI arguments.`);
} else {
  try {
    const client = JSON.parse(await readFile(join(dataDir(), 'client.json'), 'utf8'));
    const origin = new URL(client.origin);
    if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.username || origin.password) throw new Error('Invalid local coordinator address.');
    const api = async (path: string, body?: unknown) => {
      const response = await fetch(origin.origin + '/api' + path, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { 'X-LoWriter': '1', Authorization: `Bearer ${client.token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const data: any = await response.json(); if (!response.ok) throw new Error(data.error ?? 'Local request failed.'); return data;
    };
    const send = async (id: string, text: string) => {
      const detail = await api('/conversations/' + id);
      let job: Job = await api(`/conversations/${id}/send`, { text, revision: detail.conversation.revision });
      let displayed = '', actionCount = 0, cancelled = false;
      const cancel = () => { cancelled = true; void api(`/jobs/${job.id}/cancel`, {}).catch(() => {}); };
      process.once('SIGINT', cancel);
      try {
        while (true) {
          job = await api('/jobs/' + job.id);
          if (job.text.startsWith(displayed)) process.stdout.write(job.text.slice(displayed.length));
          else process.stdout.write('\n' + job.text);
          displayed = job.text;
          while (actionCount < job.actions.length && job.actions[actionCount].status !== 'running') { const a = job.actions[actionCount++]; process.stdout.write(`\n[${a.tool}: ${a.status}] ${a.output}\n`); }
          if (job.status !== 'running') { process.stdout.write(`\n[${job.status}] ${job.error}\n`); if (job.status !== 'complete') process.exitCode = 1; break; }
          await new Promise(resolve => setTimeout(resolve, 150));
        }
      } finally { process.removeListener('SIGINT', cancel); }
      return cancelled;
    };
    if (command === 'pair') console.log(`Enter this local pairing code in LoWriter (changes on restart):\n${client.token}`);
    else if (command === 'list') { const state = await api('/state'); for (const c of state.conversations as Conversation[]) console.log(`${c.id}  [${c.mode}] ${c.title}`); }
    else if (command === 'new') { const c = await api('/conversations', { mode: args[0] ?? 'coding', title: args.slice(1).join(' ') || 'New coding task' }); console.log(c.id); }
    else if (command === 'show') { const d = await api('/conversations/' + args[0]); for (const m of d.messages) console.log(`${m.role}: ${m.content}\n`); if (d.job) console.log(`[${d.job.status}] ${d.job.error}`); }
    else if (command === 'send') await send(args[0], args.slice(1).join(' '));
    else if (command === 'chat') {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try { while (true) { const text = await rl.question('You > '); if (text === '/exit') break; if (text.trim() && await send(args[0], text)) break; } } finally { rl.close(); }
    }
    else if (['project', 'trust', 'revoke'].includes(command)) {
      const d = await api('/conversations/' + args[0]);
      const path = command === 'project' ? args.slice(1).join(' ') : d.conversation.project;
      console.log(await api(`/conversations/${args[0]}/project`, { path, trust: command === 'trust' }));
      if (command === 'trust') console.log('Explicit trust granted for bounded file tools. This is not an OS sandbox or a desktop grant.');
    }
    else if (command === 'cancel') await api(`/jobs/${args[0]}/cancel`, {});
    else if (command === 'stop') await api('/stop', {});
    else if (command === 'quit') await api('/shutdown', {});
    else if (command === 'restore') console.log((await api(`/conversations/${args[0]}/restore`, { checkpoint: args[1] })).output);
    else throw new Error('Unknown command. Run CLI help.');
  } catch (e: any) { console.error(e.code === 'ENOENT' ? 'Start the LoWriter service first.' : e.message ?? 'CLI operation failed.'); process.exitCode = 1; }
}
