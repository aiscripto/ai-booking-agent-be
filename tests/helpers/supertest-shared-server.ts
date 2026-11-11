// A drop-in replacement for `supertest` in the tests (see jest.config.js, moduleNameMapper).
//
// Plain supertest starts a new throwaway server for every request. Under load a request could be answered
// by the wrong server (random 200/400/404 in unrelated tests). This keeps ONE server per app for the whole
// test file, so every request goes to the same place.
import type { Server } from 'http';
// The real package, by path, so the mapping of "supertest" to this file does not point back here.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const realSupertest = require('../../node_modules/supertest/index.js') as (app: unknown) => unknown;

const servers = new WeakMap<object, Server>();

function request(app: unknown): unknown {
  if (typeof app !== 'function') return realSupertest(app); // already a server or a URL
  let server = servers.get(app);
  if (!server) {
    server = (app as unknown as { listen: (port: number) => Server }).listen(0);
    server.unref();
    servers.set(app, server);
  }
  return realSupertest(server);
}

export = request;
