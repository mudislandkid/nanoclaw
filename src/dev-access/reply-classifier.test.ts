import { describe, it, expect } from 'vitest';
import { classifyReply } from './reply-classifier.js';

describe('classifyReply', () => {
  it('matches simple affirmatives', () => {
    expect(classifyReply('yes').decision).toBe('affirmative');
    expect(classifyReply('Yes').decision).toBe('affirmative');
    expect(classifyReply('YEAH').decision).toBe('affirmative');
    expect(classifyReply('yep').decision).toBe('affirmative');
    expect(classifyReply('sure').decision).toBe('affirmative');
    expect(classifyReply('ok').decision).toBe('affirmative');
    expect(classifyReply('okay').decision).toBe('affirmative');
    expect(classifyReply('do it').decision).toBe('affirmative');
    expect(classifyReply('go ahead').decision).toBe('affirmative');
    expect(classifyReply('grant').decision).toBe('affirmative');
    expect(classifyReply('allow').decision).toBe('affirmative');
    expect(classifyReply('approve').decision).toBe('affirmative');
    expect(classifyReply('👍').decision).toBe('affirmative');
  });

  it('matches simple negatives', () => {
    expect(classifyReply('no').decision).toBe('negative');
    expect(classifyReply('No').decision).toBe('negative');
    expect(classifyReply('NOPE').decision).toBe('negative');
    expect(classifyReply('nah').decision).toBe('negative');
    expect(classifyReply("don't").decision).toBe('negative');
    expect(classifyReply('dont').decision).toBe('negative');
    expect(classifyReply('deny').decision).toBe('negative');
    expect(classifyReply('reject').decision).toBe('negative');
    expect(classifyReply('👎').decision).toBe('negative');
  });

  it('returns none for non-matching messages', () => {
    expect(classifyReply('actually fix Y first').decision).toBe('none');
    expect(classifyReply('what does VoltWise do?').decision).toBe('none');
    expect(classifyReply('').decision).toBe('none');
  });

  it('extracts a project disambiguator if present', () => {
    expect(classifyReply('yes VoltWise')).toEqual({
      decision: 'affirmative',
      project: 'VoltWise',
    });
    expect(classifyReply('no Eirene')).toEqual({
      decision: 'negative',
      project: 'Eirene',
    });
  });

  it('matches affirmative only at the start of the message', () => {
    expect(classifyReply('I think no').decision).toBe('none');
    expect(classifyReply('say yes to him').decision).toBe('none');
  });
});
