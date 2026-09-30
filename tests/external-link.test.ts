import assert from 'node:assert/strict';
import { test } from 'node:test';
import { externalLink } from '../electron/core/external-link';

test('external links accept only supported URL protocols', () => {
  assert.equal(externalLink('https://example.com/path?q=1').href, 'https://example.com/path?q=1');
  assert.equal(externalLink('http://example.com').protocol, 'http:');
  assert.equal(externalLink('mailto:help@example.com').protocol, 'mailto:');
  for (const value of [
    'javascript:alert(1)',
    'data:text/html,test',
    'file:///etc/passwd',
    'ftp://example.com',
    'https://user:password@example.com',
  ])
    assert.throws(() => externalLink(value), /not supported/);
});

test('external links reject malformed, non-text and oversized values', () => {
  for (const value of [undefined, null, 1, {}, 'https://'])
    assert.throws(() => externalLink(value), /Invalid link|Invalid URL/);
  assert.throws(() => externalLink(`https://example.com/${'a'.repeat(2049)}`), /Invalid link/);
});
