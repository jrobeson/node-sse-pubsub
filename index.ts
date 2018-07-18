import { IncomingMessage, ServerResponse } from 'http';

export interface SseChannelOptions {
  pingInterval: number;
  maxStreamDuration: number;
  clientRetryInterval: number;
  startId: number;
  historySize: number;
  rewind: number;
}

export type PartialSseChannelOptions = Partial<SseChannelOptions>;

interface RequestAndResponse {
  req: IncomingMessage;
  res: ServerResponse;
}

export interface ClientCountByIp {
  [index: string]: number;
}

export class SseChannel {
  private options: SseChannelOptions;
  private nextId: number = 0;
  private clients: Set<RequestAndResponse>;
  private messages: any[] = [];
  private pingTimer!: NodeJS.Timer;

  constructor(options: PartialSseChannelOptions = {}) {
    const defaultOptions = {
      pingInterval: 3000,
      maxStreamDuration: 30000,
      clientRetryInterval: 1000,
      startId: 1,
      historySize: 100,
      rewind: 0,
    };
    this.options = { ...defaultOptions, ...options };

    this.nextId = this.options.startId;
    this.clients = new Set();

    if (this.options.pingInterval) {
      this.pingTimer = setInterval(() => this.publish(), this.options.pingInterval);
    }
  }

  public publish(data?: string | object, eventName?: string | null) {
    const thisId = this.nextId;
    if (typeof data === 'object') data = JSON.stringify(data);
    data = data
      ? data
          .split(/[\r\n]+/)
          .map(str => `data: ${str}`)
          .join('\n')
      : '';

    const output =
      (data ? `id: ${thisId}\n` : '') + (eventName ? `event: ${eventName}\n` : '') + (data || 'data: ') + '\n\n';
    this.clients.forEach(({ res }) => res.write(output));

    this.messages.push(output);
    while (this.messages.length > this.options.historySize) {
      this.messages.shift();
    }
    this.nextId++;
  }

  public subscribe(req: IncomingMessage, res: ServerResponse) {
    const client = { req, res };
    client.req.socket.setNoDelay(true);
    client.res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control':
        's-maxage=' +
        (Math.floor(this.options.maxStreamDuration / 1000) - 1) +
        '; max-age=0; stale-while-revalidate=0; stale-if-error=0',
      Connection: 'keep-alive',
    });
    let body = `retry: ${this.options.clientRetryInterval}\n\n`;

    const lastEventId = req.headers['last-event-id'] || '';
    const lastId = Number.parseInt(lastEventId, 10);
    const rewind = !Number.isNaN(lastId) ? this.nextId - 1 - lastId : this.options.rewind;
    if (rewind) {
      this.messages.slice(0 - rewind).forEach(output => {
        body += output;
      });
    }

    client.res.write(body);
    this.clients.add(client);

    setTimeout(() => {
      if (!client.res.finished) {
        this.unsubscribe(client);
      }
    }, this.options.maxStreamDuration);
    client.res.on('close', () => this.unsubscribe(client));
    return client;
  }

  public unsubscribe(client: RequestAndResponse) {
    client.res.end();
    this.clients.delete(client);
  }

  public stop() {
    this.clients.forEach(({ req, res }) => {
      req.destroy();
      res.end();
    });
  }

  public listClients() {
    const rollupByIp: ClientCountByIp = {};
    this.clients.forEach(({ req }) => {
      const ip = req.connection.remoteAddress;
      if (ip === undefined) return;
      if (!rollupByIp.hasOwnProperty(ip)) {
        rollupByIp[ip] = 0;
      }
      rollupByIp[ip]++;
    });
    return rollupByIp;
  }

  public getSubscriberCount() {
    return this.clients.size;
  }
}
