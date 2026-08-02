export function parseListName(name) {
  const match = String(name ?? '').trim().match(/^([^\s-]+)\s*-\s*(.+?)\s*-\s*\$?\s*([\d,]+(?:\.\d{1,2})?)\s*$/);
  if (!match) return { valid: false, rawName: name, error: 'Expected date - source - $total' };

  const [, date, source, amountText] = match;
  const amount = Number(amountText.replaceAll(',', ''));
  if (!Number.isFinite(amount)) return { valid: false, rawName: name, error: 'Total is not a valid number' };

  return {
    valid: true,
    rawName: name,
    date,
    source: source.trim(),
    amount,
    displayAmount: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount)
  };
}

export function formatCard(card) {
  const name = card.name ?? 'Untitled card';
  const amountMatch = name.match(/\$\s*([\d,]+(?:\.\d{1,2})?)\s*$/);
  const amount = amountMatch ? Number(amountMatch[1].replaceAll(',', '')) : null;
  return {
    id: card.id,
    name,
    url: card.url ?? '',
    description: card.desc ?? '',
    amount,
    displayAmount: Number.isFinite(amount) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount) : ''
  };
}
