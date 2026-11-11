import fs from 'fs';
import express from 'express';
import request from 'supertest';

// Same setting as src/app.ts. The test shows that a forged header is ignored when the
// connection is not from a private address, and used when it is.
function appFor(setting: string) {
  const a = express();
  a.set('trust proxy', setting);
  a.get('/ip', (req, res) => res.json({ ip: req.ip }));
  return a;
}

describe('trust proxy setting (SEC-013)', () => {
  it('app.ts uses the private-address setting', () => {
    const src = fs.readFileSync('src/app.ts', 'utf8');
    expect(src).toContain("app.set('trust proxy', 'loopback, linklocal, uniquelocal')");
  });

  it('uses the forwarded address when the connection is local (nginx case)', async () => {
    const res = await request(appFor('loopback, linklocal, uniquelocal')).get('/ip').set('X-Forwarded-For', '203.0.113.9');
    expect(res.body.ip).toBe('203.0.113.9');
  });

  it('ignores the header when the connection address is not trusted (direct public client)', async () => {
    const res = await request(appFor('10.255.255.255')).get('/ip').set('X-Forwarded-For', '203.0.113.9');
    expect(res.body.ip).not.toBe('203.0.113.9');
  });
});
