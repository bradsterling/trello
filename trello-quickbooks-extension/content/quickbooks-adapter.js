(function () {
  const visible = (element) => Boolean(element && (element.offsetWidth || element.offsetHeight || element.getClientRects().length));

  function controls(kind) {
    const exact = [...document.querySelectorAll(`input[data-columnkey="${kind}"]`)]
      .filter(visible)
      .sort((left, right) => Number(left.getAttribute('data-rowkey')) - Number(right.getAttribute('data-rowkey')));
    if (exact.length) return exact;
    const terms = {
      description: ['enter description', 'description'],
      amount: ['enter amount', 'amount']
    }[kind];
    return [...document.querySelectorAll('input, textarea, [contenteditable="true"]')].filter((element) => {
      if (!visible(element)) return false;
      const text = [element.getAttribute('aria-label'), element.getAttribute('name'), element.id, element.getAttribute('placeholder'), element.getAttribute('data-testid')].filter(Boolean).join(' ').toLowerCase();
      return terms.some((term) => text.includes(term));
    });
  }

  function buttonsWithText(text) {
    return [...document.querySelectorAll('button, [role="button"]')].filter((element) => visible(element) && element.textContent.trim().toLowerCase() === text.toLowerCase());
  }

  function valueOf(element) {
    return element?.isContentEditable ? element.textContent.trim() : String(element?.value ?? '').trim();
  }

  function cents(value) {
    const amount = Number(String(value ?? '').replace(/[,$\s]/g, ''));
    return Number.isFinite(amount) ? Math.round(amount * 100) : null;
  }

  function splitSummary() {
    const labels = [...document.querySelectorAll('*')].filter((element) =>
      visible(element) && ['Split amount', 'Original amount', 'Difference'].includes(element.textContent.trim())
    );
    const read = (label) => {
      const element = labels.find((candidate) => candidate.textContent.trim() === label);
      if (!element) return null;
      const text = element.parentElement?.innerText || element.parentElement?.textContent || '';
      const values = text.match(/-?\$?\s*[\d,]+(?:\.\d{1,2})?/g) || [];
      return values.length ? cents(values.at(-1)) : null;
    };
    return {
      splitAmountCents: read('Split amount'),
      originalAmountCents: read('Original amount'),
      differenceCents: read('Difference')
    };
  }

  async function waitForCommittedSplit(expectedCents) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const summary = splitSummary();
      if (summary.splitAmountCents === expectedCents && summary.differenceCents === 0) return summary;
      await waitForDom();
    }
    const summary = splitSummary();
    const displayed = summary.splitAmountCents == null
      ? 'unavailable'
      : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(summary.splitAmountCents / 100);
    throw new Error(`QuickBooks did not commit the split amounts (calculated split amount: ${displayed}). No transaction was posted.`);
  }

  function trustedFieldTargets(descriptions, amounts) {
    return [...descriptions.map((element) => ({ element, kind: 'description' })), ...amounts.map((element) => ({ element, kind: 'amount' }))]
      .sort((left, right) => {
        const rowDifference = Number(left.element.getAttribute('data-rowkey')) - Number(right.element.getAttribute('data-rowkey'));
        if (rowDifference) return rowDifference;
        return left.kind === 'description' ? -1 : 1;
      })
      .map(({ element, kind }) => {
        const rect = element.getBoundingClientRect();
        return {
          kind,
          row: element.getAttribute('data-rowkey'),
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2
        };
      });
  }

  function rowFor(element) {
    const tableRow = element.closest('tr, [role="row"]');
    if (tableRow) return tableRow;
    let node = element;
    for (let level = 0; node && level < 8; level += 1, node = node.parentElement) {
      const fields = [...node.querySelectorAll('input, textarea, [contenteditable="true"]')];
      const descriptionCount = fields.filter((field) => controls('description').includes(field)).length;
      const amountCount = fields.filter((field) => controls('amount').includes(field)).length;
      if (descriptionCount === 1 && amountCount === 1) return node;
    }
    return element.parentElement;
  }

  function deleteButton(row) {
    const buttons = [...(row?.querySelectorAll('button, [role="button"]') ?? [])].filter(visible);
    return buttons.find((button) => [button.getAttribute('aria-label'), button.getAttribute('title'), button.getAttribute('data-testid'), button.textContent].filter(Boolean).join(' ').toLowerCase().match(/delete|remove|trash/)) || buttons.at(-1);
  }

  function waitForDom() { return new Promise((resolve) => setTimeout(resolve, 150)); }

  async function ensureRows(required) {
    let descriptions = controls('description');
    let amounts = controls('amount');
    let attempts = 0;
    while ((descriptions.length < required || amounts.length < required) && attempts < required + 2) {
      const addLines = buttonsWithText('Add lines')[0];
      if (!addLines) throw new Error(`QuickBooks has ${descriptions.length} description row(s), but the Add lines button was not found.`);
      addLines.click();
      await waitForDom();
      descriptions = controls('description');
      amounts = controls('amount');
      attempts += 1;
    }
    if (descriptions.length < required || amounts.length < required) throw new Error(`QuickBooks could not create ${required} split rows (found ${descriptions.length} description and ${amounts.length} amount fields).`);
    return { descriptions, amounts };
  }

  async function removeBlankRowsAfter(keepCount) {
    let descriptions = controls('description');
    let amounts = controls('amount');
    for (let index = descriptions.length - 1; index >= keepCount; index -= 1) {
      if (valueOf(descriptions[index]) || valueOf(amounts[index])) continue;
      const row = rowFor(descriptions[index]);
      const remove = deleteButton(row);
      if (!remove) throw new Error('Found a blank split row, but could not find its delete button.');
      remove.click();
      await waitForDom();
      descriptions = controls('description');
      amounts = controls('amount');
    }
  }

  window.tqbQuickBooksAdapter = {
    async getTransactionTotal() {
      const containers = [...document.querySelectorAll('.trowser-txn-information')].filter(visible);
      const container = containers.find((element) => /received|spent/i.test(element.textContent));
      if (!container) throw new Error('Open a QuickBooks transaction or split transaction to find its total.');
      const transactionSection = container.closest('section') || document;
      const amountText = container.querySelector('span')?.textContent || container.textContent;
      const match = amountText.match(/-?\$?\s*([\d,]+(?:\.\d{1,2})?)/);
      if (!match) throw new Error('The QuickBooks transaction total could not be read.');
      const amount = Number(match[1].replaceAll(',', ''));
      return {
        amount,
        displayAmount: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount),
        transactionType: /spent/i.test(container.textContent) ? 'Spent' : 'Received',
        date: transactionSection.querySelector('.trowser-date-info span')?.textContent?.trim() || '',
        account: transactionSection.querySelector('.trowser-bank-account-info span')?.textContent?.trim() || '',
        description: transactionSection.querySelector('.trowser-description-info span')?.textContent?.trim() || ''
      };
    },
    async checkDuplicateSplit(values) {
      const lines = values?.lines ?? [];
      const descriptions = controls('description');
      const amounts = controls('amount');
      const normalizedAmount = (value) => Math.round(Number(String(value).replace(/[$,]/g, '')) * 100);
      const existingRows = descriptions.reduce((count, description, index) => count + (valueOf(description) || valueOf(amounts[index]) ? 1 : 0), 0);
      const duplicate = lines.length > 0 && descriptions.length >= lines.length && amounts.length >= lines.length && lines.every((line, index) =>
        valueOf(descriptions[index]) === String(line.description).trim() && normalizedAmount(valueOf(amounts[index])) === normalizedAmount(line.amount)
      );
      return { duplicate, hasExistingData: existingRows > 0, existingRows, comparedRows: lines.length };
    },
    async fillSplitTransaction(values) {
      const lines = values?.lines ?? [];
      if (!lines.length) throw new Error('No Trello cards were selected.');
      const expectedCents = lines.reduce((sum, line) => {
        const lineCents = cents(line.amount);
        if (lineCents == null) throw new Error(`Invalid split amount: ${line.amount}`);
        return sum + lineCents;
      }, 0);
      // The trusted keyboard path can only type into rows that already exist.
      const { descriptions, amounts } = await ensureRows(lines.length);
      const fields = trustedFieldTargets(descriptions, amounts);
      const trusted = await new Promise((resolve) => chrome.runtime.sendMessage({ type: 'TQB_DEBUGGER_FILL', values, fields }, resolve));
      if (!trusted?.ok) {
        throw new Error(trusted?.error || 'Ledger Flow could not start trusted keyboard input. Close other tools controlling this tab and try again.');
      }
      await removeBlankRowsAfter(lines.length);
      const summary = await waitForCommittedSplit(expectedCents);
      return { ...trusted.result, summary };
    }
  };
})();
