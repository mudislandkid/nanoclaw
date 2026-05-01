import { describe, it, expect } from 'vitest';
import { htmlToText } from './html-text.js';

describe('htmlToText', () => {
  it('strips simple tags', () => {
    expect(htmlToText('<p>Hello</p>')).toBe('Hello');
  });

  it('converts <br> to newline', () => {
    expect(htmlToText('a<br>b<br/>c')).toBe('a\nb\nc');
  });

  it('converts </p> to double newline', () => {
    expect(htmlToText('<p>one</p><p>two</p>')).toBe('one\n\ntwo');
  });

  it('decodes common entities', () => {
    expect(htmlToText('A &amp; B &lt;test&gt; &quot;x&quot; &#39;y&#39; &nbsp;')).toBe(
      `A & B <test> "x" 'y'`,
    );
  });

  it('collapses 3+ consecutive newlines to 2', () => {
    expect(htmlToText('a<br><br><br><br>b')).toBe('a\n\nb');
  });

  it('trims leading and trailing whitespace', () => {
    expect(htmlToText('  <p>x</p>  ')).toBe('x');
  });
});
