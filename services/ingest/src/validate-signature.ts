import twilio from 'twilio';
import crypto from 'crypto';

/**
 * Validates Twilio webhook signature for JSON payloads (Voice Intelligence).
 *
 * For JSON webhooks, Twilio uses a two-step validation:
 * 1. Body integrity: SHA256 hash of body must match bodySHA256 query param
 * 2. Signature: HMAC-SHA1 of full URL (with bodySHA256) using Auth Token
 *
 * Note: The standard validateRequestWithBody doesn't work for JSON webhooks.
 * We must use validateRequest with the full URL including bodySHA256.
 *
 * @param authToken - Your Twilio Account Auth Token
 * @param signature - The X-Twilio-Signature header value
 * @param url - The base webhook URL (without query params)
 * @param body - The raw request body string
 * @param expectedBodyHash - The bodySHA256 query param from Twilio
 * @returns true if signature is valid
 */
export function validateTwilioSignature(
  authToken: string,
  signature: string,
  url: string,
  body: string,
  expectedBodyHash?: string
): boolean {
  // Step 1: Validate body integrity
  const computedBodyHash = crypto.createHash('sha256').update(body).digest('hex');

  if (expectedBodyHash && computedBodyHash !== expectedBodyHash) {
    console.warn('Signature validation failed: body hash mismatch');
    return false;
  }

  // Step 2: Validate signature using full URL with bodySHA256
  const urlWithBodyHash = `${url}?bodySHA256=${computedBodyHash}`;
  return twilio.validateRequest(authToken, signature, urlWithBodyHash, {});
}
