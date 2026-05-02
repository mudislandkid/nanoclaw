const AFFIRMATIVE_WORDS = [
  'yes',
  'yeah',
  'yep',
  'sure',
  'ok',
  'okay',
  'do it',
  'go ahead',
  'go',
  'grant',
  'allow',
  'approve',
  '👍',
];

const NEGATIVE_WORDS = ['no', 'nope', 'nah', 'deny', "don't", 'dont', 'reject', '👎'];

export type ReplyDecision = 'affirmative' | 'negative' | 'none';

export interface ClassifiedReply {
  decision: ReplyDecision;
  project?: string;
}

export function classifyReply(text: string): ClassifiedReply {
  const trimmed = text.trim();
  if (!trimmed) return { decision: 'none' };

  let decision: ReplyDecision = 'none';
  let matchedLength = 0;

  // Check affirmative words
  for (const word of AFFIRMATIVE_WORDS) {
    if (trimmed.toLowerCase().startsWith(word.toLowerCase())) {
      // Ensure it's a word boundary (followed by space, end of string, or punctuation)
      const nextChar = trimmed[word.length];
      if (!nextChar || /\s|[^\w-]/.test(nextChar)) {
        decision = 'affirmative';
        matchedLength = word.length;
        break;
      }
    }
  }

  // Check negative words if no affirmative match
  if (decision === 'none') {
    for (const word of NEGATIVE_WORDS) {
      if (trimmed.toLowerCase().startsWith(word.toLowerCase())) {
        // Ensure it's a word boundary
        const nextChar = trimmed[word.length];
        if (!nextChar || /\s|[^\w-]/.test(nextChar)) {
          decision = 'negative';
          matchedLength = word.length;
          break;
        }
      }
    }
  }

  if (decision === 'none') return { decision };

  // Look for a trailing project name after the keyword
  const remainder = trimmed.slice(matchedLength).trim();
  if (remainder) {
    const projectMatch = remainder.match(/^([A-Za-z0-9_-]+)/);
    if (projectMatch) {
      return { decision, project: projectMatch[1] };
    }
  }
  return { decision };
}
