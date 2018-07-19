// tslint:disable:no-implicit-dependencies only-arrow-functions
import { expect } from 'chai';
import fetch, { Body, Response } from 'node-fetch';

import * as http from 'http';
import * as net from 'net';
import * as util from 'util';

import { PartialSseChannelOptions, SseChannel, SseChannelOptions } from '../index';

const PORT = process.env.PORT || 3102;
const URL = `http://localhost:${PORT}/stream`;

const nextChunk = async (body: NodeJS.ReadableStream) => {
  return new Promise(resolve => {
    body.on('data', chunk => resolve(chunk.toString()));
  });
};

const measureTime = async (pr: Promise<any>) => {
  const start = Date.now();
  await pr;
  const end = Date.now();
  return end - start;
};

let sockets: net.Socket[];
let server: http.Server;
let sse!: SseChannel;

const setupServer = async (sseOptions?: PartialSseChannelOptions) => {
  sse = new SseChannel(sseOptions);
};

describe('SSEChannel', function() {
  beforeEach(async function() {
    sse = new SseChannel();
    sockets = [];
    server = http.createServer((req, res) => {
      if (req.url === '/stream') sse.subscribe(req, res);
    });

    server.on('connection', socket => sockets.push(socket));
    await util.promisify(server.listen.bind(server))(PORT);
  });
  afterEach(async function teardownServer() {
    sockets.forEach(socket => socket.destroy());
    sse.stop();
    server.close();
  });
  it('should return 200 OK status', async function() {
    await setupServer();
    const res = await fetch(URL);
    expect(res.status).to.equal(200);
  });

  it('should have correct content-type', async function() {
    await setupServer();
    const res = await fetch(URL);
    expect(res.headers.get('content-type')).to.equal('text/event-stream');
  });

  it('should be server-cachable for the duration of the stream', async function() {
    await setupServer({ maxStreamDuration: 20000 });
    const res = await fetch(URL);
    expect(res.headers.get('cache-control')).to.contain('s-maxage=19');
  });

  it('should not be client-cachable', async function() {
    await setupServer({ maxStreamDuration: 20000 });
    const res = await fetch(URL);
    expect(res.headers.get('cache-control')).to.contain('max-age=0');
  });

  it('should include retry in first response chunk', async function() {
    await setupServer();
    const res = await fetch(URL);
    const chunk = await nextChunk(res.body);
    expect(chunk).to.match(/retry:\s*\d{4,6}\n/);
  });

  it('should allow changing clientRetryInterval', async function() {
    await setupServer({ clientRetryInterval: 1234 });
    const res = await fetch(URL);
    const chunk = await nextChunk(res.body);
    expect(chunk).to.match(/retry:\s*1234\n/);
  });

  it('should close the connection at maxStreamDuration', async function() {
    await setupServer({ maxStreamDuration: 1500 });
    const elapsed = await measureTime(fetch(URL).then(res => res.text()));
    expect(elapsed).to.be.approximately(1500, 30);
  });

  it('should start at startId = 0', async function() {
    let res;
    let output;
    await setupServer();
    res = await fetch(URL);
    await nextChunk(res.body);
    sse.publish('something');
    output = await nextChunk(res.body);
    expect(output).to.match(/id:\s*1\n/);
    expect(output).to.match(/data:\s*something\n/);
    sse.publish('something else');
    output = await nextChunk(res.body);
    expect(output).to.match(/id:\s*2\n/);
    expect(output).to.match(/data:\s*something else\n/);
  });

  it('should start at startId > 1 if set', async function() {
    let res;
    let output;
    await setupServer({ startId: 8777 });
    res = await fetch(URL);
    await nextChunk(res.body);
    sse.publish('something');
    output = await nextChunk(res.body);
    expect(output).to.match(/id:\s*8777\n/);
    expect(output).to.match(/data:\s*something\n/);
  });

  it('should ping at pingInterval', async function() {
    await setupServer({ pingInterval: 500 });
    const res = await fetch(URL);

    await nextChunk(res.body);
    const chunkPromise = nextChunk(res.body);
    const elapsed = await measureTime(chunkPromise);
    const output = await chunkPromise;
    expect(elapsed).to.be.approximately(500, 30);
    expect(output).to.match(/:ping\n\n/);
    expect(output).to.not.contain('event:');
    expect(output).to.not.contain('id:');
  });

  it('should output a retry number', async function() {
    await setupServer({ clientRetryInterval: 4321 });
    const res = await fetch(URL);
    const chunk = await nextChunk(res.body);
    expect(chunk).to.match(/retry:\s*4321\n\n/);
  });

  it('should include event name if specified', async function() {
    let chunk;
    await setupServer();
    const res = await fetch(URL);
    await nextChunk(res.body);
    sse.publish('no-event-name');
    chunk = await nextChunk(res.body);
    expect(chunk).to.not.contain('event:');
    sse.publish('with-event-name', 'myEvent');
    chunk = await nextChunk(res.body);
    expect(chunk).to.match(/event:\s*myEvent\n/);
  });

  it('should include previous events if last-event-id is specified', async function() {
    await setupServer();
    for (let i = 1; i <= 10; i++) {
      sse.publish('event-' + i);
    }
    const res = await fetch(URL, { headers: { 'last-event-id': 4 } as any });
    const output = (await nextChunk(res.body)) as string;
    const events = output.split('\n\n').filter(str => str.includes('id:'));
    expect(events.length).to.equal(6);
    expect(events[0]).to.match(/id:\s*5\n/);
  });

  it('should limit history length to historySize', async function() {
    await setupServer({ historySize: 5 });
    for (let i = 1; i <= 10; i++) {
      sse.publish('event-' + i);
    }
    const res = await fetch(URL, { headers: { 'Last-Event-ID': 2 } as any });
    const output = (await nextChunk(res.body)) as string;
    const events = output.split('\n\n').filter(str => str.includes('id:'));
    expect(events.length).to.equal(5);
    expect(events[0]).to.match(/id:\s*6\n/);
  });

  it('should serialise non scalar values as JSON', async function() {
    const testData = { foo: 42 };
    await setupServer();
    const res = await fetch(URL);
    await nextChunk(res.body);
    sse.publish(testData);
    const chunk = await nextChunk(res.body);
    expect(chunk).to.contain(JSON.stringify(testData));
  });

  it('should list connected clients by IP address', async function() {
    await setupServer();
    const res1 = await fetch(URL);
    const res2 = await fetch(URL);
    expect(sse.listClients()).to.eql({
      '::ffff:127.0.0.1': 2,
    });
  });

  it('should count connected clients', async function() {
    await setupServer();
    const res1 = await fetch(URL);
    const res2 = await fetch(URL);
    expect(sse.getSubscriberCount()).to.equal(2);
  });

  it('should understand the rewind option', async function() {
    let res;
    let output;
    await setupServer({ rewind: 2 });
    sse.publish('message-1');
    sse.publish('message-2');
    sse.publish('message-3');
    res = await fetch(URL);
    output = await nextChunk(res.body);
    expect(output).to.not.include('message-1');
    expect(output).to.include('message-2');
    expect(output).to.include('message-3');

    await setupServer({ rewind: 6 });
    sse.publish('message-1');
    sse.publish('message-2');
    sse.publish('message-3');
    res = await fetch(URL);
    output = await nextChunk(res.body);
    expect(output).to.include('message-1');
    expect(output).to.include('message-2');
    expect(output).to.include('message-3');
  });
});
