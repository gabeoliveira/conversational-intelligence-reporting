import crypto from 'crypto';
import { validateTwilioSignature } from '../validate-signature';

const AUTH_TOKEN = 'test-auth-token-12345';
const WEBHOOK_URL = 'https://example.com/v1/webhook/ci';
const BODY = JSON.stringify({ transcript_sid: 'GT123', event_type: 'voice_intelligence_transcript_available' });

function computeBodyHash(body: string): string {
  return crypto.createHash('sha256').update(body).digest('hex');
}

function computeSignature(authToken: string, url: string): string {
  return crypto
    .createHmac('sha1', authToken)
    .update(Buffer.from(url, 'utf-8'))
    .digest('base64');
}

describe('validateTwilioSignature', () => {
  const bodyHash = computeBodyHash(BODY);
  const urlWithHash = `${WEBHOOK_URL}?bodySHA256=${bodyHash}`;
  const validSignature = computeSignature(AUTH_TOKEN, urlWithHash);

  it('returns true for valid signature and body hash', () => {
    expect(
      validateTwilioSignature(AUTH_TOKEN, validSignature, WEBHOOK_URL, BODY, bodyHash)
    ).toBe(true);
  });

  it('returns false for wrong signature', () => {
    expect(
      validateTwilioSignature(AUTH_TOKEN, 'wrong-signature', WEBHOOK_URL, BODY, bodyHash)
    ).toBe(false);
  });

  it('returns false for wrong auth token', () => {
    expect(
      validateTwilioSignature('wrong-token', validSignature, WEBHOOK_URL, BODY, bodyHash)
    ).toBe(false);
  });

  it('returns false for body hash mismatch', () => {
    expect(
      validateTwilioSignature(AUTH_TOKEN, validSignature, WEBHOOK_URL, BODY, 'wrong-hash')
    ).toBe(false);
  });

  it('returns false for tampered body', () => {
    const tamperedBody = JSON.stringify({ transcript_sid: 'GT999', event_type: 'tampered' });
    expect(
      validateTwilioSignature(AUTH_TOKEN, validSignature, WEBHOOK_URL, tamperedBody, bodyHash)
    ).toBe(false);
  });

  it('validates signature when bodySHA256 param is not provided', () => {
    // Without expectedBodyHash, only signature is checked (body hash step is skipped)
    const sigForUrl = computeSignature(AUTH_TOKEN, `${WEBHOOK_URL}?bodySHA256=${bodyHash}`);
    expect(
      validateTwilioSignature(AUTH_TOKEN, sigForUrl, WEBHOOK_URL, BODY, undefined)
    ).toBe(true);
  });
});
