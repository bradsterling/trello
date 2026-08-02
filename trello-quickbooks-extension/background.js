chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
});

chrome.action.onClicked.addListener(async (tab) => {
  if (tab?.windowId) {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'TQB_DEBUGGER_FILL') return;
  const tabId = sender.tab?.id;
  if (!tabId) { sendResponse({ ok: false, error: 'No QuickBooks tab is available.' }); return; }
  fillWithTrustedInput(tabId, message.values, message.fields)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});

async function fillWithTrustedInput(tabId, values, suppliedFields) {
  const lines = values?.lines ?? [];
  if (!lines.length) throw new Error('No split lines were provided.');
  const fields = Array.isArray(suppliedFields) ? suppliedFields : [];
  const required = lines.length * 2;
  if (fields.length < required) throw new Error(`QuickBooks exposed ${fields.length} editable fields; ${required} are required.`);
  const descriptions = fields.filter((field) => field.kind === 'description');
  const amounts = fields.filter((field) => field.kind === 'amount');
  if (descriptions.length < lines.length || amounts.length < lines.length) {
    throw new Error(`QuickBooks exposed ${descriptions.length} description and ${amounts.length} amount fields; ${lines.length} of each are required.`);
  }
  const target = { tabId };
  await chrome.debugger.attach(target, '1.3');
  try {
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function clickField(field) {
      await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: field.x, y: field.y, button: 'left', clickCount: 1 });
      await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: field.x, y: field.y, button: 'left', clickCount: 1 });
      await pause(100);
    }
    async function clearAndType(field, value) {
      await clickField(field);
      await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Meta', code: 'MetaLeft', modifiers: 4, nativeVirtualKeyCode: 91 });
      await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
      await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
      await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Meta', code: 'MetaLeft', nativeVirtualKeyCode: 91 });
      await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
        type: 'rawKeyDown', key: 'Backspace', code: 'Backspace',
        windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8
      });
      await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'Backspace', code: 'Backspace',
        windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8
      });
      // QuickBooks' split editor is controlled by application state. A
      // keyDown event with a `text` property can change the native input value
      // without running the complete character-input lifecycle that updates
      // that state. Send the same rawKeyDown -> char -> keyUp sequence Chrome
      // produces for physical typing.
      for (const character of String(value)) {
        const isDigit = /^\d$/.test(character);
        const code = isDigit ? `Digit${character}` : character === '.' ? 'Period' : character === '-' ? 'Minus' : 'Unidentified';
        const keyCode = isDigit ? 48 + Number(character) : character === '.' ? 190 : character === '-' ? 189 : 0;
        await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
          type: 'rawKeyDown', key: character, code,
          windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode
        });
        await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
          type: 'char', key: character, code, text: character, unmodifiedText: character,
          windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode
        });
        await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
          type: 'keyUp', key: character, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode
        });
      }
      await pause(300);
    }
    async function pressTab() {
      await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
        type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9
      });
      await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9
      });
      await pause(350);
    }
    for (let index = 0; index < lines.length; index += 1) {
      await clearAndType(descriptions[index], lines[index].description);
      await pressTab();
      await clearAndType(amounts[index], lines[index].amount);
      await pressTab();
    }
    await pause(500);
    return { filledRows: lines.length, submitted: false, inputMethod: 'trusted-keyboard' };
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}
