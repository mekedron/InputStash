const MAX_COMPARE_CHARS = 4000;

export function shouldUpdateExistingValue(previous: string, next: string, identityThreshold: number): boolean {
  if (identityThreshold <= 0) return true;
  const left = normalizeComparableText(previous);
  const right = normalizeComparableText(next);
  if (left === right) return true;
  if (!left || !right) return false;
  if (isIncrementalEdit(left, right)) return true;
  return textIdentityPercent(left, right) >= identityThreshold;
}

export function textIdentityPercent(previous: string, next: string): number {
  const left = normalizeComparableText(previous);
  const right = normalizeComparableText(next);
  if (left === right) return 100;
  if (!left || !right) return 0;

  const charScore = diceCoefficient(toBigrams(left), toBigrams(right));
  const wordScore = diceCoefficient(words(left), words(right));
  return Math.round(Math.max(charScore, wordScore) * 100);
}

function isIncrementalEdit(left: string, right: string): boolean {
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length > right.length ? left : right;
  if (shorter.length <= 2) return longer.startsWith(shorter);
  if (longer.includes(shorter)) return true;

  const shortWords = words(shorter);
  if (shortWords.length < 2) return false;
  const longerWords = new Set(words(longer));
  return shortWords.every((word) => longerWords.has(word));
}

function normalizeComparableText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, MAX_COMPARE_CHARS);
}

function toBigrams(value: string): string[] {
  if (value.length < 2) return [value];
  const bigrams: string[] = [];
  for (let index = 0; index < value.length - 1; index += 1) {
    bigrams.push(value.slice(index, index + 2));
  }
  return bigrams;
}

function words(value: string): string[] {
  return value.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function diceCoefficient(leftItems: string[], rightItems: string[]): number {
  if (!leftItems.length || !rightItems.length) return 0;
  const rightCounts = new Map<string, number>();
  for (const item of rightItems) rightCounts.set(item, (rightCounts.get(item) || 0) + 1);

  let overlap = 0;
  for (const item of leftItems) {
    const count = rightCounts.get(item) || 0;
    if (count > 0) {
      overlap += 1;
      rightCounts.set(item, count - 1);
    }
  }

  return (2 * overlap) / (leftItems.length + rightItems.length);
}
