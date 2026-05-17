const SENSITIVE_AUTOCOMPLETE = new Set([
  'cc-additional-name',
  'cc-csc',
  'cc-exp',
  'cc-exp-month',
  'cc-exp-year',
  'cc-family-name',
  'cc-given-name',
  'cc-name',
  'cc-number',
  'cc-type',
  'current-password',
  'new-password',
  'one-time-code',
  'password',
]);

const SENSITIVE_TEXT =
  /\b(pass(word)?|passwd|credit\s*card|card\s*(number|num|no)|cc[-_\s]?(num|number)?|cvc|cvv|security\s*code|one[-_\s]?time|otp|2fa|mfa|ssn|social\s*security|pin)\b/i;

export function hasSensitiveAutocomplete(value: string): boolean {
  return value.split(/\s+/).some((token) => SENSITIVE_AUTOCOMPLETE.has(token.toLowerCase()));
}

export function looksSensitiveFieldText(value: string): boolean {
  return SENSITIVE_TEXT.test(value);
}
