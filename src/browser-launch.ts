import type { IncomingHttpHeaders } from 'node:http';
import { AppError } from './shared.ts';

// A trusted local launcher arms one short window. No secret is placed in a URL,
// browser history, process arguments, HTML, or frontend storage.
export class BrowserLaunch {
  private deadline = 0;
  constructor(privateClock: () => number = Date.now) { this.clock = privateClock; }
  private clock: () => number;
  arm(): void { this.deadline = this.clock() + 30000; }
  consume(headers: IncomingHttpHeaders): void {
    if (headers['sec-fetch-site'] !== 'none' || headers['sec-fetch-mode'] !== 'navigate' || headers['sec-fetch-dest'] !== 'document' || headers.origin || headers.referer) {
      throw new AppError('Open LoWriter from its launcher, not a link on another website.', 403);
    }
    if (!this.deadline || this.clock() >= this.deadline) throw new AppError('Launch expired. Open LoWriter again using its launcher.', 401);
    this.deadline = 0;
  }
}
