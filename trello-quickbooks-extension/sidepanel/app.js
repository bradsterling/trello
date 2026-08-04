import { getAuthSession } from '../lib/auth.js';
import { authorizeWithTrello, disconnectTrello, getSettings, loadBoards, loadCards, loadLists } from '../lib/trello.js';
import { authenticatedFetch } from '../lib/auth.js';

const $ = (id) => document.getElementById(id);
let boards = [];
let lists = [];
let selectedBoardId = '';
let selectedList;
let selectedCards = [];
let quickBooksTotal = null;
let reconciliationPassed = false;
let onboardingTrelloToken = '';

function status(message, kind = '') {
  $('status').querySelector('span').textContent = message;
  $('status').className = `status-pill ${kind}`.trim();
}
function show(id, visible) { $(id).classList.toggle('hidden', !visible); }

function showSignInHome(message = 'Connect Trello to get started.') {
  show('settings', false); show('listsView', false); show('onboarding', true);
  show('signOut', false); show('settingsButton', false); show('accountMenu', false);
  onboardingTrelloToken = '';
  $('onboardingWorkspaceField').classList.add('hidden');
  $('onboardingCopy').textContent = 'Connect the private Trello account used by this installation, then enter its Workspace ID.';
  $('onboardingConnect').querySelector('span').textContent = 'Connect with Trello';
  $('onboardingOrganizationId').value = '';
  $('token').value = '';
  status(message);
}

function showAuthenticatedApp() {
  show('onboarding', false); show('listsView', true); show('signOut', true); show('settingsButton', true);
}

async function showTrelloReconnect(error) {
  if (error?.code !== 'TRELLO_REAUTH_REQUIRED') return false;
  const settings = await getSettings();
  showSignInHome('Your Trello token was revoked or expired. Connect Trello again.');
  $('onboardingOrganizationId').value = settings.organizationId;
  status('Your Trello connection needs to be renewed.', 'error');
  return true;
}

function setFlowStep(step) {
  document.querySelectorAll('.progress-step').forEach((element) => {
    const value = Number(element.dataset.step);
    element.classList.toggle('active', value === step);
    element.classList.toggle('complete', value < step);
  });
}

function renderLists() {
  const container = $('lists'); container.replaceChildren();
  if (!lists.length) { container.textContent = 'No lists found.'; updateMatchNotice([], null); return; }
  const validLists = lists.filter((list) => list.parsed.valid);
  const exactMatches = quickBooksTotal == null ? [] : validLists.filter((list) => Math.round(list.parsed.amount * 100) === Math.round(quickBooksTotal.amount * 100));
  const closest = quickBooksTotal == null || exactMatches.length ? null : validLists.reduce((best, list) => !best || Math.abs(list.parsed.amount - quickBooksTotal.amount) < Math.abs(best.parsed.amount - quickBooksTotal.amount) ? list : best, null);
  const rankedMatches = [...exactMatches].sort((left, right) => matchScore(right) - matchScore(left));
  const recommended = rankedMatches[0] || null;
  const orderedLists = [...lists].sort((left, right) => Number(right === recommended) - Number(left === recommended) || matchScore(right) - matchScore(left) || Number(right === closest) - Number(left === closest));
  updateMatchNotice(exactMatches, closest, recommended);
  for (const list of orderedLists) {
    const button = document.createElement('div'); button.className = 'item';
    const selectButton = document.createElement('button'); selectButton.type = 'button'; selectButton.className = 'item-select';
    if (list === recommended) { button.classList.add('best-match'); const badge = document.createElement('span'); badge.className = 'match-badge'; badge.textContent = `✓ Best match: ${matchReasons(list).join(' + ')}`; button.append(badge); }
    else if (list === closest) button.classList.add('closest-match');
    const title = document.createElement('strong'); title.textContent = list.parsed.valid ? list.parsed.source : list.name; button.append(title);
    if (list.parsed.valid) { const amount = document.createElement('span'); amount.className = 'item-amount'; amount.textContent = list.parsed.displayAmount; button.append(amount); }
    const summary = document.createElement('span'); summary.textContent = list.parsed.valid ? `${list.parsed.date} · Trello list` : `Invalid format: ${list.parsed.error}`; button.append(summary);
    selectButton.append(...button.childNodes); button.append(selectButton);
    if (!list.parsed.valid) button.classList.add('warning');
    selectButton.addEventListener('click', () => selectList(list));
    if (list === recommended) { const pasteButton = document.createElement('button'); pasteButton.type = 'button'; pasteButton.className = 'paste-match'; pasteButton.textContent = 'Paste match'; pasteButton.addEventListener('click', (event) => { event.stopPropagation(); pasteRecommended(list, pasteButton); }); button.append(pasteButton); }
    container.append(button);
  }
}

function monthDay(value) {
  const match = String(value ?? '').match(/(\d{1,2})\/(\d{1,2})/);
  return match ? `${Number(match[1])}/${Number(match[2])}` : '';
}

function normalizedText(value) { return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function sourceMatches(list) {
  if (!quickBooksTotal || !list.parsed.valid) return false;
  const source = normalizedText(list.parsed.source);
  const quickBooksText = normalizedText(`${quickBooksTotal.account} ${quickBooksTotal.description}`);
  return Boolean(source && quickBooksText && (quickBooksText.includes(source) || source.includes(quickBooksText)));
}
function matchReasons(list) {
  const reasons = ['amount'];
  if (monthDay(list.parsed.date) && monthDay(list.parsed.date) === monthDay(quickBooksTotal?.date)) reasons.push('date');
  if (sourceMatches(list)) reasons.push('source');
  return reasons;
}
function matchScore(list) {
  if (!quickBooksTotal || !list?.parsed?.valid || Math.round(list.parsed.amount * 100) !== Math.round(quickBooksTotal.amount * 100)) return 0;
  const listDate = monthDay(list.parsed.date);
  const quickBooksDate = monthDay(quickBooksTotal.date);
  return 10 + (listDate && quickBooksDate && listDate === quickBooksDate ? 3 : 0) + (sourceMatches(list) ? 2 : 0);
}

function updateMatchNotice(exactMatches, closest, recommended = null) {
  const notice = $('matchNotice');
  if (!quickBooksTotal) { notice.textContent = 'Open a QuickBooks transaction to match its total against these lists.'; notice.className = 'card match-notice neutral'; return; }
  if (exactMatches.length) { notice.textContent = `${quickBooksTotal.transactionType} ${quickBooksTotal.displayAmount}${quickBooksTotal.date ? ` on ${quickBooksTotal.date}` : ''}: ${exactMatches.length} exact-amount match${exactMatches.length === 1 ? '' : 'es'}. Select ${recommended?.name || 'the highlighted list'}.`; notice.className = 'card match-notice success'; return; }
  const closestText = closest ? ` Closest: ${closest.name} (${closest.parsed.displayAmount}).` : '';
  notice.textContent = `QuickBooks total ${quickBooksTotal.displayAmount}: no exact Trello list match.${closestText}`;
  notice.className = 'card match-notice neutral';
}

function currency(amount) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount); }

function isQuickBooksTab(tab) {
  try {
    const url = new URL(tab?.url || '');
    return url.protocol === 'https:' && (url.hostname === 'intuit.com' || url.hostname.endsWith('.intuit.com'));
  } catch (_error) { return false; }
}

async function activeQuickBooksTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!isQuickBooksTab(tab)) throw new Error('Open the QuickBooks transaction in the active tab before continuing.');
  if (!tab.id) throw new Error('The active QuickBooks tab is unavailable.');
  return tab;
}

function updateReconciliation() {
  const notice = $('reconciliationNotice');
  if (!selectedList || !selectedCards.length) { reconciliationPassed = false; notice.className = 'reconciliation-notice hidden'; $('pasteAll').disabled = true; setFlowStep(selectedList ? 2 : 1); return false; }
  const invalid = selectedCards.filter((card) => !Number.isFinite(card.amount));
  const cardTotalCents = selectedCards.reduce((sum, card) => sum + (Number.isFinite(card.amount) ? Math.round(card.amount * 100) : 0), 0);
  const listTotalCents = Math.round(selectedList.parsed.amount * 100);
  const quickBooksCents = quickBooksTotal ? Math.round(quickBooksTotal.amount * 100) : null;
  reconciliationPassed = !invalid.length && quickBooksCents != null && cardTotalCents === listTotalCents && listTotalCents === quickBooksCents;
  notice.textContent = `Cards ${currency(cardTotalCents / 100)} · List ${selectedList.parsed.displayAmount} · QuickBooks ${quickBooksTotal?.displayAmount ?? 'unavailable'} — ${reconciliationPassed ? 'Reconciled and ready to paste.' : invalid.length ? `${invalid.length} card amount${invalid.length === 1 ? ' is' : 's are'} invalid.` : 'Totals do not reconcile; paste is disabled.'}`;
  notice.className = `card reconciliation-notice ${reconciliationPassed ? 'success' : 'error'}`;
  $('pasteAll').disabled = !reconciliationPassed;
  setFlowStep(reconciliationPassed ? 3 : 2);
  return reconciliationPassed;
}

async function sendQuickBooksMessage(tabId, message) {
  try { return await chrome.tabs.sendMessage(tabId, message); }
  catch (_error) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/quickbooks-adapter.js', 'content/content-script.js'] });
    return chrome.tabs.sendMessage(tabId, message);
  }
}

async function readQuickBooksTotal() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!isQuickBooksTab(tab) || !tab?.id) return null;
    const message = { type: 'TQB_GET_TRANSACTION_TOTAL' };
    const response = await sendQuickBooksMessage(tab.id, message);
    return response?.ok ? response.result : null;
  } catch (_error) { return null; }
}

function renderBoards() {
  const select = $('boardSelect'); select.replaceChildren();
  for (const board of boards) {
    const option = document.createElement('option'); option.value = board.id; option.textContent = board.name; select.append(option);
  }
  select.value = selectedBoardId;
}

async function loadBoardLists() {
  if (!selectedBoardId) { lists = []; renderLists(); return; }
  status('Loading lists…');
  lists = await loadLists(selectedBoardId);
  quickBooksTotal = await readQuickBooksTotal();
  selectedList = undefined; selectedCards = []; reconciliationPassed = false;
  show('cardsView', false); show('lists', true);
  setFlowStep(1);
  renderLists();
  status(`${lists.length} list${lists.length === 1 ? '' : 's'} loaded from ${boards.find((board) => board.id === selectedBoardId)?.name ?? 'board'}`);
}

async function refresh() {
  $('refresh').disabled = true; status('Loading boards…');
  try {
    const settings = await getSettings();
    boards = await loadBoards(settings);
    if (!boards.length) throw new Error('No open boards were found in this Trello workspace.');
    selectedBoardId = boards.some((board) => board.id === settings.selectedBoardId) ? settings.selectedBoardId : boards[0].id;
    renderBoards();
    await chrome.storage.local.set({ selectedBoardId });
    await loadBoardLists();
  }
  catch (error) {
    status(error.message, 'error'); $('lists').textContent = error.message;
    await showTrelloReconnect(error);
  }
  finally { $('refresh').disabled = false; }
}

async function selectList(list) {
  if (!list.parsed.valid) { status('This list name does not match the expected format.', 'error'); return; }
  selectedList = list; $('cardsHeading').textContent = 'Review split lines'; $('cards').textContent = 'Loading cards…'; $('cardCount').textContent = '…'; show('cardsView', true); show('lists', false); setFlowStep(2);
  try { const cards = await loadCards(list.id); selectedCards = cards; const container = $('cards'); container.replaceChildren(); $('cardCount').textContent = cards.length; $('cardsSummary').textContent = `${list.parsed.source} · ${list.parsed.date} · ${list.parsed.displayAmount}. Each card becomes one QuickBooks split line.`; if (!cards.length) container.textContent = 'No cards found.'; for (const card of cards) { const button = document.createElement('button'); button.type = 'button'; button.className = 'item'; const title = document.createElement('strong'); title.textContent = card.name; button.append(title); const amount = document.createElement('span'); amount.textContent = Number.isFinite(card.amount) ? card.displayAmount : 'Amount missing'; button.append(amount); container.append(button); } updateReconciliation(); status(`${cards.length} card${cards.length === 1 ? '' : 's'} ready to review`); }
  catch (error) { $('cards').textContent = error.message; status(error.message, 'error'); await showTrelloReconnect(error); }
}

async function pasteRecommended(list, actionButton) {
  actionButton.disabled = true;
  actionButton.textContent = 'Preparing…';
  try {
    selectedList = list;
    selectedCards = await loadCards(list.id);
    await paste();
  } catch (error) {
    status(error.message, 'error');
    await showTrelloReconnect(error);
  } finally {
    actionButton.disabled = false;
    actionButton.textContent = 'Paste match';
  }
}

async function paste() {
  if (!selectedCards.length || !selectedList) return;
  if (!updateReconciliation()) {
    const cardTotal = selectedCards.reduce((sum, card) => sum + (Number.isFinite(card.amount) ? card.amount : 0), 0);
    const invalidCount = selectedCards.filter((card) => !Number.isFinite(card.amount)).length;
    const detail = invalidCount
      ? `${invalidCount} card${invalidCount === 1 ? '' : 's'} has no valid amount.`
      : `Cards ${currency(cardTotal)} · List ${selectedList.parsed.displayAmount} · QuickBooks ${quickBooksTotal?.displayAmount ?? 'unavailable'}.`;
    const notice = $('matchNotice');
    notice.textContent = `Paste blocked. ${detail}`;
    notice.className = 'card match-notice neutral';
    status(`Paste blocked. ${detail}`, 'error');
    return;
  }
  const invalid = selectedCards.filter((card) => !Number.isFinite(card.amount));
  if (invalid.length) { status(`Missing dollar amount on: ${invalid.map((card) => card.name).join(', ')}`, 'error'); return; }
  $('pasteAll').disabled = true; setFlowStep(3); status('Preparing split lines…');
  try {
    const tab = await activeQuickBooksTab();
    const currentTotal = await readQuickBooksTotal();
    if (!currentTotal || Math.round(currentTotal.amount * 100) !== Math.round(quickBooksTotal.amount * 100)) {
      throw new Error('The active QuickBooks transaction changed. Refresh the match before pasting.');
    }
    const values = { lines: selectedCards.map((card) => ({ description: card.name, amount: card.amount.toFixed(2) })) };
    const duplicate = await sendQuickBooksMessage(tab.id, { type: 'TQB_CHECK_DUPLICATE_SPLIT', values });
    if (duplicate?.ok && duplicate.result.hasExistingData) {
      const notice = $('matchNotice');
      notice.textContent = `Paste stopped: QuickBooks already has data in ${duplicate.result.existingRows} split line${duplicate.result.existingRows === 1 ? '' : 's'}. Nothing was overwritten.`;
      notice.className = 'card match-notice neutral';
      return;
    }
    const message = { type: 'TQB_FILL_SPLIT_TRANSACTION', values };
    const response = await sendQuickBooksMessage(tab.id, message);
    if (!response?.ok) throw new Error(response?.error || 'QuickBooks did not accept the values.');
    const verified = await sendQuickBooksMessage(tab.id, { type: 'TQB_CHECK_DUPLICATE_SPLIT', values });
    if (!verified?.ok || !verified.result?.duplicate) throw new Error('QuickBooks did not confirm all split lines. Review the transaction before saving.');
    const notice = $('matchNotice');
    notice.textContent = `Pasted ${selectedCards.length} split line${selectedCards.length === 1 ? '' : 's'} into QuickBooks.`;
    notice.className = 'card match-notice success';
    status('Split descriptions and amounts filled. Review and save in QuickBooks when ready.');
  } catch (error) { status(error.message, 'error'); throw error; }
  finally { updateReconciliation(); }
}

async function openSettings() { const settings = await getSettings(); $('organizationId').value = settings.organizationId; $('token').value = ''; show('settings', true); show('accountMenu', false); $('settingsButton').setAttribute('aria-expanded', 'false'); }
async function saveSettings() {
  const organizationId = $('organizationId').value.trim(); const token = $('token').value.trim();
  if (!organizationId || !token) throw new Error('Connect Trello and enter your Workspace ID before saving.');
  const previous = await getSettings();
  await authenticatedFetch('/trello', { method: 'POST', body: JSON.stringify({ action: 'connect', organizationId, token }) });
  await chrome.storage.local.set({ organizationId, ...(previous.organizationId !== organizationId ? { selectedBoardId: '' } : {}) });
  $('token').value = '';
  onboardingTrelloToken = '';
  show('settings', false); show('onboarding', false); show('listsView', true); status('Settings saved on this browser.'); refresh();
}

async function authorizeTrello() {
  $('authorizeTrello').disabled = true;
  try {
    const token = await authorizeWithTrello();
    $('token').value = token;
    status('Trello connected. Save your settings to finish.');
    return token;
  } catch (error) { status(error.message, 'error'); throw error; }
  finally { $('authorizeTrello').disabled = false; }
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type !== 'TQB_TRANSACTION_CHANGED') return;
  chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
    if (!tab?.id || tab.id !== sender.tab?.id) return;
    quickBooksTotal = message.transaction;
    renderLists();
    updateReconciliation();
    status(quickBooksTotal ? `QuickBooks transaction changed to ${quickBooksTotal.displayAmount}. Matches updated.` : 'Open a QuickBooks transaction to find a matching list.');
  });
});

const headerMenu = document.querySelector('.header-menu'); $('settingsButton').addEventListener('click', () => { const menu = $('accountMenu'); const isOpen = !menu.classList.contains('hidden'); show('accountMenu', !isOpen); $('settingsButton').setAttribute('aria-expanded', String(!isOpen)); }); $('manageConnection').addEventListener('click', openSettings); document.addEventListener('click', (event) => { if (!headerMenu.contains(event.target)) { show('accountMenu', false); $('settingsButton').setAttribute('aria-expanded', 'false'); } }); document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { show('accountMenu', false); $('settingsButton').setAttribute('aria-expanded', 'false'); } }); $('saveSettings').addEventListener('click', saveSettings); $('cancelSettings').addEventListener('click', () => show('settings', false)); $('settings').addEventListener('click', (event) => { if (event.target === $('settings')) show('settings', false); }); $('refresh').addEventListener('click', refresh); $('boardSelect').addEventListener('change', async () => { selectedBoardId = $('boardSelect').value; await chrome.storage.local.set({ selectedBoardId }); try { await loadBoardLists(); } catch (error) { status(error.message, 'error'); $('lists').textContent = error.message; await showTrelloReconnect(error); } }); $('backToLists').addEventListener('click', () => { show('cardsView', false); show('lists', true); setFlowStep(1); status('Choose a matching list.'); }); $('pasteAll').addEventListener('click', paste);
$('authorizeTrello').addEventListener('click', authorizeTrello);
$('signOut').addEventListener('click', async () => {
  const button = $('signOut');
  button.disabled = true;
  try {
    await disconnectTrello();
    showSignInHome('Trello disconnected.');
  } catch (error) { status(error.message, 'error'); }
  finally { button.disabled = false; }
});
async function startOnboarding() {
  try {
    await getAuthSession();
    const settings = await getSettings();
    if (settings.organizationId) { showAuthenticatedApp(); refresh(); return; }
    $('onboardingOrganizationId').value = settings.organizationId;
    showSignInHome();
  } catch (error) {
    showSignInHome(error.message);
    status(error.message, 'error');
  }
}
$('onboardingManual').addEventListener('click', () => { show('onboarding', false); openSettings(); });
$('onboardingConnect').addEventListener('click', async () => {
  const button = $('onboardingConnect');
  button.disabled = true;
  try {
    if (onboardingTrelloToken) {
      const organizationId = $('onboardingOrganizationId').value.trim();
      if (!organizationId) throw new Error('Enter your Trello Workspace ID to continue.');
      $('organizationId').value = organizationId;
      $('token').value = onboardingTrelloToken;
      status('Saving your Workspace ID…');
      await saveSettings();
      return;
    }
    status('Opening Trello authorization…');
    onboardingTrelloToken = await authorizeTrello();
    if (!onboardingTrelloToken) throw new Error('Trello authorization returned no token.');
    $('onboardingWorkspaceField').classList.remove('hidden');
    $('onboardingCopy').textContent = 'Trello is connected. Enter the Workspace ID whose boards this installation should show.';
    button.textContent = 'Save Workspace ID';
    status('Enter your Workspace ID to finish setup.');
    $('onboardingOrganizationId').focus();
  } catch (error) { status(error.message, 'error'); }
  finally { button.disabled = false; }
});
startOnboarding();
