chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const type = message?.type;
  const supported = ['TQB_FILL_SPLIT_TRANSACTION', 'TQB_GET_TRANSACTION_TOTAL', 'TQB_CHECK_DUPLICATE_SPLIT'];
  if (!supported.includes(type)) return;
  try {
    const adapter = window.tqbQuickBooksAdapter;
    if (!adapter) throw new Error('QuickBooks adapter is not loaded. Reload the QuickBooks page and try again.');
    const operation = type === 'TQB_FILL_SPLIT_TRANSACTION'
      ? adapter.fillSplitTransaction(message.values)
      : type === 'TQB_CHECK_DUPLICATE_SPLIT'
        ? adapter.checkDuplicateSplit(message.values)
        : adapter.getTransactionTotal();
    Promise.resolve(operation)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  } catch (error) {
    sendResponse({ ok: false, error: error?.message || String(error) });
  }
  return true;
});

let transactionChangeTimer;
let lastTransactionSignature = '';

async function announceTransactionChange() {
  clearTimeout(transactionChangeTimer);
  transactionChangeTimer = setTimeout(async () => {
    let transaction = null;
    try { transaction = await window.tqbQuickBooksAdapter.getTransactionTotal(); } catch (_error) {}
    const signature = JSON.stringify(transaction);
    if (signature === lastTransactionSignature) return;
    lastTransactionSignature = signature;
    // The side panel reads the current transaction when it refreshes. Avoid
    // broadcasting from this observer: an unpacked extension reload can leave
    // an old content script alive briefly, which makes runtime.sendMessage
    // reject with “Extension context invalidated”.
  }, 150);
}

new MutationObserver(announceTransactionChange).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
announceTransactionChange();
