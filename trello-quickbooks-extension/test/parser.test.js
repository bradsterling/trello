import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCard, parseListName } from '../lib/parser.js';

test('parses date, source, and currency total', () => {
  assert.deepEqual(parseListName('7/14 - CC Stripe - $6,220.62'), {
    valid: true, rawName: '7/14 - CC Stripe - $6,220.62', date: '7/14', source: 'CC Stripe', amount: 6220.62, displayAmount: '$6,220.62'
  });
});

test('flags malformed list names', () => assert.equal(parseListName('July transactions').valid, false));

test('normalizes card fields', () => assert.deepEqual(formatCard({ id: '1', name: 'Vendor', url: 'https://trello.com/c/1', desc: 'Memo' }), { id: '1', name: 'Vendor', url: 'https://trello.com/c/1', description: 'Memo', amount: null, displayAmount: '' }));

test('extracts the trailing card amount while preserving the full description', () => {
  const card = formatCard({ id: '1', name: '1234 - brad - final - $800.00' });
  assert.equal(card.name, '1234 - brad - final - $800.00');
  assert.equal(card.amount, 800);
  assert.equal(card.displayAmount, '$800.00');
});

test('leaves cards without a trailing amount invalid for split paste', () => assert.equal(formatCard({ id: '1', name: 'No amount' }).amount, null));
