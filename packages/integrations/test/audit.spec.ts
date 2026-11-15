import { describe, expect, it } from 'vitest';
import { SEALED_OPEN_EVENT, sealedOpenEvent } from '../src/audit.js';

describe('sealed-open event (recipient-held)', () => {
  it('uses actor ?? sub, exactly like the crypto audit', () => {
    const impersonated = sealedOpenEvent({
      actor: { sub: 'user:42', email: 'ana@clinic.test' },
      subject: 'svc:agent',
      key: 'doctor-42',
      kid: 'kid-1',
      resource: 'grant:7',
      at: '2026-03-03T03:03:03.000Z',
    });
    expect(impersonated).toEqual({
      event: 'crypto:sealed.open',
      v: 1,
      actor: 'user:42',
      subject: 'svc:agent',
      key: 'doctor-42',
      kid: 'kid-1',
      resource: 'grant:7',
      at: '2026-03-03T03:03:03.000Z',
      result: 'ok',
    });
    expect(impersonated.event).toBe(SEALED_OPEN_EVENT);

    // Without an `act`, the subject is the actor (a plain user opening their own share).
    expect(sealedOpenEvent({ subject: 'user:7', key: 'doctor-7' })).toMatchObject({
      actor: 'user:7',
      result: 'ok',
    });
    // A plain string actor (a CLI, a worker) is accepted and wins over the subject.
    expect(
      sealedOpenEvent({ actor: 'cli:davi', subject: 'user:7', key: 'doctor-7' }),
    ).toMatchObject({ actor: 'cli:davi' });
  });

  it('stamps the time, and refuses an anonymous open', () => {
    const event = sealedOpenEvent({ subject: 'user:7', key: 'doctor-7' });
    expect(Number.isNaN(Date.parse(event.at))).toBe(false);
    expect(() => sealedOpenEvent({ key: 'doctor-7' })).toThrow(/identity/);
    expect(() => sealedOpenEvent({ subject: 'user:7', key: '' })).toThrow(/key name/);
  });

  it('marks a failed open, so a refused attempt is visible too', () => {
    expect(sealedOpenEvent({ subject: 'user:9', key: 'doctor-9', result: 'error' })).toMatchObject({
      result: 'error',
      actor: 'user:9',
    });
  });
});
