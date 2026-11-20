import { createHash, generateKeyPairSync, sign as edSign } from 'crypto';
import { sign } from 'jsonwebtoken';
import { authorizeUrl, CanvaApi, editLink, pkce, readReturnToken } from './canva';

describe('Canva', () => {
  beforeAll(() => {
    process.env.CANVA_CLIENT_ID = 'client-1';
    process.env.CANVA_CLIENT_SECRET = 'secret';
    process.env.NEXT_PUBLIC_BACKEND_URL = 'https://post.example.com/api';
  });

  it('signs in with PKCE and our callback', () => {
    const { verifier, challenge } = pkce();
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
    const url = new URL(authorizeUrl('st', challenge));
    expect(url.origin + url.pathname).toBe('https://www.canva.com/api/oauth/authorize');
    expect(url.searchParams.get('code_challenge_method')).toBe('s256');
    expect(url.searchParams.get('redirect_uri')).toBe('https://post.example.com/api/bolt-canva/callback');
    expect(url.searchParams.get('scope')).toContain('design:content:write');
  });

  it('marks the editor link so the return button says which request it was', () => {
    const link = new URL(editLink('https://www.canva.com/api/design/abc/edit', 'st123'));
    expect(link.searchParams.get('correlation_state')).toBe('st123');
  });

  const keysFor = (pub: any, kid: string, alg: string) => {
    (global as any).fetch = jest.fn(async () => ({ ok: true, json: async () => ({ keys: [{ ...(pub.export({ format: 'jwk' }) as any), kid, alg, use: 'sig' }] }) }));
  };

  it('trusts a return link only when Canva signed it for our app', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    keysFor(publicKey, 'k1', 'RS256');
    const good = sign({ design_id: 'D1', correlation_state: 'st123' }, privateKey, { algorithm: 'RS256', keyid: 'k1', audience: 'client-1', expiresIn: 60 });
    await expect(readReturnToken(good)).resolves.toEqual({ designId: 'D1', state: 'st123' });
    const otherApp = sign({ design_id: 'D1' }, privateKey, { algorithm: 'RS256', keyid: 'k1', audience: 'someone-else', expiresIn: 60 });
    await expect(readReturnToken(otherApp)).rejects.toThrow('another app');
    const { privateKey: forger } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const forged = sign({ design_id: 'D1' }, forger, { algorithm: 'RS256', keyid: 'k1', audience: 'client-1', expiresIn: 60 });
    await expect(readReturnToken(forged)).rejects.toThrow('does not check out');
    const shared = sign({ design_id: 'D1' }, 'secret', { algorithm: 'HS256', keyid: 'k1', audience: 'client-1' });
    await expect(readReturnToken(shared)).rejects.toThrow('unsupported');
  });

  it('accepts the other public-key signature types', async () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    keysFor(ec.publicKey, 'e1', 'ES256');
    const es = sign({ design_id: 'D2' }, ec.privateKey, { algorithm: 'ES256', keyid: 'e1', audience: 'client-1', expiresIn: 60 });
    await expect(readReturnToken(es)).resolves.toMatchObject({ designId: 'D2' });

    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    keysFor(rsa.publicKey, 'p1', 'PS256');
    const ps = sign({ design_id: 'D3' }, rsa.privateKey, { algorithm: 'PS256', keyid: 'p1', audience: 'client-1', expiresIn: 60 });
    await expect(readReturnToken(ps)).resolves.toMatchObject({ designId: 'D3' });

    const ed = generateKeyPairSync('ed25519');
    keysFor(ed.publicKey, 'd1', 'EdDSA');
    const head = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: 'd1', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ design_id: 'D4', aud: 'client-1', exp: Math.floor(Date.now() / 1000) + 60 })).toString('base64url');
    const sig = edSign(null, Buffer.from(`${head}.${body}`), ed.privateKey).toString('base64url');
    await expect(readReturnToken(`${head}.${body}.${sig}`)).resolves.toMatchObject({ designId: 'D4' });
  });

  it('exports and waits for the files', async () => {
    const calls: string[] = [];
    let polls = 0;
    (global as any).fetch = jest.fn(async (url: string, init: any) => {
      calls.push(`${init?.method || 'GET'} ${url.replace('https://api.canva.com/rest/v1', '')}`);
      const body = url.endsWith('/exports')
        ? { job: { id: 'J1', status: 'in_progress' } }
        : { job: { id: 'J1', status: ++polls > 1 ? 'success' : 'in_progress', urls: ['https://export.canva.com/a.jpg'] } };
      return { ok: true, status: 200, json: async () => body };
    });
    jest.useFakeTimers({ advanceTimers: true });
    const urls = await new CanvaApi('tok').exportDesign('D1', 'jpg', [1]);
    jest.useRealTimers();
    expect(urls).toEqual(['https://export.canva.com/a.jpg']);
    expect(calls[0]).toBe('POST /exports');
    expect(JSON.parse(((global as any).fetch as jest.Mock).mock.calls[0][1].body)).toEqual({ design_id: 'D1', format: { type: 'jpg', quality: 92, pages: [1] } });
    expect(calls.filter((c) => c === 'GET /exports/J1')).toHaveLength(2);
  });
});
