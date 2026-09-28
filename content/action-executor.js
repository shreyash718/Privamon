/**
 * Privamon — Action Executor (Content Script)
 *
 * Injected into the active tab via chrome.scripting.executeScript().
 * Receives a single action instruction and executes it on the page.
 *
 * Supported action types:
 *   click   — Click an element by ID/selector
 *   type    — Focus an input/textarea and type text with realistic delays
 *   scroll  — Scroll viewport up or down
 *   select  — Set a <select> element's value
 *   wait    — Simply wait for a specified duration
 *   done    — No-op, signal task completion
 *   ask_user — No-op, return reasoning for user display
 *
 * Returns: { success: boolean, actionType: string, targetElementId: string|null, message: string }
 */
(async () => {
  'use strict';

  // The action payload is injected via chrome.scripting.executeScript args
  // We read it from the global __privamon_action variable set before injection
  const action = window.__privamon_action;

  if (!action || !action.type) {
    return { success: false, actionType: 'unknown', targetElementId: null, message: 'No action payload provided' };
  }

  const actionType = action.type.toLowerCase();
  const targetId = action.targetElementId || null;
  const value = action.value || null;
  const scrollDirection = action.scrollDirection || null;

  try {

  /**
   * Finds an element using multiple strategies:
   * 1. By DOM id attribute
   * 2. By data-privamon-id attribute
   * 3. By the elementId format "dom-tok-N" — look up the Nth interactive element
   * 4. By CSS selector (if targetId looks like a selector)
   */
  function findElement(elementId) {
    if (!elementId) return null;

    // Strategy 1: Direct DOM id
    let el = document.getElementById(elementId);
    if (el) {
      const allWithId = document.querySelectorAll(`#${CSS.escape(elementId)}`);
      if (allWithId.length > 1) {
        for (const candidate of allWithId) {
          const container = candidate.closest('ytd-video-renderer, ytd-playlist-renderer, ytd-radio-renderer, ytd-rich-item-renderer, ytd-compact-video-renderer, yt-lockup-view-model');
          const isMembersOnly = container && (
            container.querySelector('.badge-style-type-members-only') ||
            /members\s*only/i.test(container.textContent || '')
          );
          const rect = candidate.getBoundingClientRect();
          const isNotSidebar = rect.left >= 200;
          if (!isMembersOnly && isNotSidebar && rect.width > 5 && rect.height > 5 && rect.top >= 0 && rect.bottom <= window.innerHeight * 1.5) {
            return candidate;
          }
        }
      }
      return el;
    }

    // Strategy 2: data-privamon-id attribute
    el = document.querySelector(`[data-privamon-id="${elementId}"]`);
    if (el) return el;

    // Strategy 3: dom-tok-N index-based lookup
    const tokMatch = elementId.match(/^dom-tok-(\d+)$/);
    if (tokMatch) {
      const index = parseInt(tokMatch[1], 10);
      // Re-enumerate interactive elements in DOM order (mirrors dom-extractor.js logic)
      const interactiveSelectors = [
        'a[href]', 'button', 'input', 'select', 'textarea',
        '[role="button"]', '[role="link"]', '[role="checkbox"]',
        '[role="radio"]', '[role="menuitem"]', '[role="tab"]',
        '[role="combobox"]', '[role="textbox"]',
        '[onclick]', '[tabindex]'
      ].join(', ');

      const allInteractive = document.querySelectorAll(interactiveSelectors);
      // Filter to visible elements only
      const visible = Array.from(allInteractive).filter(e => {
        const rect = e.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return false;
        const style = window.getComputedStyle(e);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      });

      if (index >= 0 && index < visible.length) {
        let found = visible[index];

        // YouTube media container resolution: if the matched element is inside a
        // video, playlist, or course renderer, resolve to the actual playable link
        // so that clicks navigate correctly in the SPA.
        if (window.location.hostname.includes('youtube.com')) {
          const mediaContainer = found.closest(
            'ytd-video-renderer, ytd-playlist-renderer, ytd-radio-renderer, ytd-rich-item-renderer, ytd-compact-video-renderer, ytd-reel-item-renderer, yt-lockup-view-model, ytd-playlist-video-renderer, ytd-grid-playlist-renderer'
          );
          if (mediaContainer) {
            const mediaLink = mediaContainer.querySelector('a#video-title, a[href*="/watch"], a[href*="/playlist?list="], a[href*="/course/"], a#thumbnail');
            if (mediaLink) {
              console.log('[Privamon ActionExecutor] Resolved dom-tok element to YouTube media link inside container');
              found = mediaLink;
            }
          }
        }

        return found;
      }
    }

    // Strategy 4: CSS selector
    try {
      el = document.querySelector(elementId);
      if (el) return el;
    } catch (e) {
      // Invalid selector — ignore
    }

    // Strategy 5: Try matching by visible text content for buttons and links
    const buttons = document.querySelectorAll('button, a, [role="button"]');
    for (const btn of buttons) {
      const btnText = (btn.textContent || '').trim().toLowerCase();
      if (btnText && btnText === elementId.toLowerCase()) {
        return btn;
      }
    }

    // Strategy 6: Try partial label/aria-label match
    el = document.querySelector(`[aria-label="${elementId}"]`);
    if (el) return el;

    el = document.querySelector(`[name="${elementId}"]`);
    if (el) return el;

    el = document.querySelector(`[placeholder="${elementId}"]`);
    if (el) return el;

    // Strategy 7: Substring match on ID or name for inputs / selects (handles ASP.NET WebForms prefixes like ctl00_..._ddlSemester)
    try {
      const escaped = CSS.escape(elementId);
      el = document.querySelector(`select[id*="${escaped}" i], select[name*="${escaped}" i], input[id*="${escaped}" i], input[name*="${escaped}" i]`);
      if (el) return el;
    } catch (e) {}

    // Strategy 8: Associated label text or nearby table cell matching elementId
    const labels = document.querySelectorAll('label, th, td, span');
    for (const lbl of labels) {
      const lblText = (lbl.textContent || '').trim().toLowerCase();
      if (lblText && (lblText === elementId.toLowerCase() || lblText.includes(elementId.toLowerCase()))) {
        if (lbl.htmlFor) {
          const associated = document.getElementById(lbl.htmlFor);
          if (associated) return associated;
        }
        const nested = lbl.querySelector('select, input, textarea');
        if (nested) return nested;
        const adjacent = lbl.closest('tr, td, div, form')?.querySelector('select, input, textarea');
        if (adjacent) return adjacent;
      }
    }

    // Strategy 9: Semantic Travel / IRCTC field resolution (from, to, date, class)
    const lowerId = elementId.toLowerCase().trim();
    if (lowerId === 'from' || lowerId === 'origin') {
      const fromEl = document.querySelector('p-autocomplete input, .ui-autocomplete input, [placeholder*="from" i], [aria-label*="from" i], input#origin, input[name*="origin" i]');
      if (fromEl) return fromEl;
      const allAuto = document.querySelectorAll('p-autocomplete input, .ui-autocomplete input');
      if (allAuto.length >= 1) return allAuto[0];
    }
    if (lowerId === 'to' || lowerId === 'destination') {
      const toEl = document.querySelector('[placeholder*="to" i]:not([placeholder*="from" i]), [aria-label*="to" i]:not([aria-label*="from" i]), input#destination, input[name*="destination" i]');
      if (toEl) return toEl;
      const allAuto = document.querySelectorAll('p-autocomplete input, .ui-autocomplete input');
      if (allAuto.length >= 2) return allAuto[1];
    }
    if (lowerId === 'date' || lowerId === 'journey date' || lowerId === 'journey_date') {
      const dateEl = document.querySelector('p-calendar input, .ui-calendar input, [placeholder*="dd/mm" i], [placeholder*="date" i], input[type="date"], [aria-label*="date" i]');
      if (dateEl) return dateEl;
    }
    if (lowerId === 'class' || lowerId === 'quota') {
      const classEl = document.querySelector('p-dropdown, .ui-dropdown, [placeholder*="classes" i], [aria-label*="class" i], select[name*="class" i]');
      if (classEl) return classEl;
    }

    return null;
  }

  /**
   * Resolves an element to an editable input child if it is a wrapper container
   * (e.g. p-autocomplete, p-calendar, mat-form-field).
   */
  function resolveInputTarget(el) {
    if (!el) return null;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) {
      return el;
    }
    const inner = el.querySelector?.('input:not([type="hidden"]), textarea, [contenteditable="true"]');
    return inner || el;
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Polls the DOM until the selector or predicate returns a visible element.
   */
  async function waitForElement(selectorOrFn, timeoutMs = 1500, pollIntervalMs = 50) {
    const start = performance.now();
    while (performance.now() - start < timeoutMs) {
      const el = typeof selectorOrFn === 'function' ? selectorOrFn() : document.querySelector(selectorOrFn);
      if (el) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) return el;
      }
      await sleep(pollIntervalMs);
    }
    return null;
  }

  /**
   * Sets value on an input bypassing React/Angular synthetic property descriptor overrides.
   */
  function setNativeValue(element, val) {
    if (!element) return;
    const valueSetter = Object.getOwnPropertyDescriptor(
      element.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype,
      'value'
    )?.set;
    if (valueSetter) {
      valueSetter.call(element, val);
    } else {
      element.value = val;
    }
  }

  /**
   * Dispatches Angular / PrimeNG / modern framework compatible input and change events.
   * Crucial for IRCTC p-autocomplete, p-calendar, and ngModel bindings.
   */
  function dispatchAngularEvent(element, eventType = 'input', data = '') {
    if (!element) return;
    try {
      if (eventType === 'input') {
        try {
          element.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            composed: true,
            cancelable: true,
            inputType: 'insertText',
            data: data || element.value || ''
          }));
        } catch (e) {
          element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        }
      } else {
        element.dispatchEvent(new Event(eventType, { bubbles: true, composed: true }));
      }

      // Check for Angular NgZone or ng component to trigger change detection
      if (typeof window !== 'undefined' && window.ng) {
        try {
          const comp = window.ng.getComponent?.(element);
          if (comp) window.ng.applyChanges?.(comp);
        } catch (e) {}
      }
    } catch (e) {}
  }

  /**
   * Interacts with autocomplete inputs (e.g. IRCTC station search):
   * Focuses -> types query -> waits for suggestion overlay -> clicks matching station item.
   */
  async function executeTypeAndSelect(targetId, queryText) {
    let el = findElement(targetId);
    if (!el) {
      return { success: false, actionType: 'type_and_select', targetElementId: targetId, message: `Autocomplete element not found: "${targetId}"` };
    }
    const inputEl = resolveInputTarget(el);
    if (!inputEl) {
      return { success: false, actionType: 'type_and_select', targetElementId: targetId, message: `No editable input found for "${targetId}"` };
    }

    inputEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    inputEl.focus();

    // Clear existing value
    setNativeValue(inputEl, '');
    dispatchAngularEvent(inputEl, 'input', '');

    // Type character by character with small delay so PrimeNG/Angular filter kicks in
    const textToType = String(queryText || '').trim();
    for (let i = 0; i < textToType.length; i++) {
      const char = textToType[i];
      inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true, composed: true }));
      inputEl.dispatchEvent(new KeyboardEvent('keypress', { key: char, bubbles: true, composed: true }));
      setNativeValue(inputEl, inputEl.value + char);
      dispatchAngularEvent(inputEl, 'input', inputEl.value);
      inputEl.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true, composed: true }));
      await sleep(25);
    }
    dispatchAngularEvent(inputEl, 'change');

    // Wait for dropdown suggestion panel to appear
    const panelSelectors = [
      '.p-autocomplete-panel', '.ui-autocomplete-panel', '.mat-autocomplete-panel',
      '[role="listbox"]', 'ul.ui-autocomplete', 'ul.ui-autocomplete-items', 'ul.p-autocomplete-items',
      '.ng-dropdown-panel', '.typeahead-popup', '.dropdown-menu', '.suggestions'
    ].join(', ');

    const panel = await waitForElement(() => {
      const panels = document.querySelectorAll(panelSelectors);
      for (const p of panels) {
        const style = window.getComputedStyle(p);
        if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
          const rect = p.getBoundingClientRect();
          if (rect.width > 20 && rect.height > 10) return p;
        }
      }
      return null;
    }, 2500, 60);

    let selectedItemText = '';
    if (panel) {
      const items = Array.from(panel.querySelectorAll('li, .p-autocomplete-item, .ui-autocomplete-list-item, mat-option, [role="option"], .suggestion-item'));
      if (items.length > 0) {
        const qLower = textToType.toLowerCase();
        // Priority 1: Match station code or exact text (e.g. "NDLS" or "NEW DELHI")
        let targetItem = items.find(it => {
          const t = (it.textContent || '').toLowerCase();
          return t.includes(`(${qLower})`) || t.includes(`- ${qLower}`) || t.startsWith(qLower);
        });
        // Priority 2: Contains query
        if (!targetItem) {
          targetItem = items.find(it => (it.textContent || '').toLowerCase().includes(qLower));
        }
        // Priority 3: First available item
        if (!targetItem) {
          targetItem = items[0];
        }

        selectedItemText = (targetItem.textContent || '').trim();
        targetItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        await sleep(100);

        // Click the suggestion item
        const rect = targetItem.getBoundingClientRect();
        const ev = { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, composed: true };
        targetItem.dispatchEvent(new MouseEvent('mouseover', ev));
        targetItem.dispatchEvent(new MouseEvent('mousedown', ev));
        targetItem.dispatchEvent(new MouseEvent('mouseup', ev));
        targetItem.dispatchEvent(new MouseEvent('click', ev));
        if (typeof targetItem.click === 'function') targetItem.click();

        await sleep(150);
        dispatchAngularEvent(inputEl, 'change');
        inputEl.dispatchEvent(new Event('blur', { bubbles: true, composed: true }));

        return {
          success: true,
          actionType: 'type_and_select',
          targetElementId: targetId,
          message: `Typed "${textToType}" and selected suggestion "${selectedItemText}"`
        };
      }
    }

    // Fallback if no dropdown panel appeared: Press Enter and Tab
    const enterOpts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, composed: true };
    inputEl.dispatchEvent(new KeyboardEvent('keydown', enterOpts));
    inputEl.dispatchEvent(new KeyboardEvent('keypress', enterOpts));
    inputEl.dispatchEvent(new KeyboardEvent('keyup', enterOpts));
    inputEl.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    inputEl.dispatchEvent(new Event('blur', { bubbles: true, composed: true }));

    return {
      success: true,
      actionType: 'type_and_select',
      targetElementId: targetId,
      message: `Typed "${textToType}" into autocomplete field "${targetId}" (no dropdown appeared, submitted via Enter)`
    };
  }

  /**
   * Interacts with date pickers (e.g. IRCTC p-calendar / Angular Material datepicker).
   * Direct input setting with DD/MM/YYYY formatting, plus calendar popup selection.
   */
  async function executePickDate(targetId, dateValue) {
    let el = findElement(targetId);
    if (!el) {
      return { success: false, actionType: 'pick_date', targetElementId: targetId, message: `Date element not found: "${targetId}"` };
    }
    const inputEl = resolveInputTarget(el);
    if (!inputEl) {
      return { success: false, actionType: 'pick_date', targetElementId: targetId, message: `No date input found for "${targetId}"` };
    }

    // Parse date value (handles YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY, or today/tomorrow)
    let rawDate = String(dateValue || '').trim();
    let targetDay = null;
    let targetMonth = null;
    let targetYear = null;
    let formattedDDMMYYYY = '';

    const now = new Date();
    if (/tomorrow/i.test(rawDate)) {
      const tom = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      targetDay = tom.getDate();
      targetMonth = tom.getMonth() + 1;
      targetYear = tom.getFullYear();
    } else if (/today/i.test(rawDate)) {
      targetDay = now.getDate();
      targetMonth = now.getMonth() + 1;
      targetYear = now.getFullYear();
    } else {
      const ymd = rawDate.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
      if (ymd) {
        targetYear = parseInt(ymd[1], 10);
        targetMonth = parseInt(ymd[2], 10);
        targetDay = parseInt(ymd[3], 10);
      } else {
        const dmy = rawDate.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
        if (dmy) {
          targetDay = parseInt(dmy[1], 10);
          targetMonth = parseInt(dmy[2], 10);
          targetYear = parseInt(dmy[3], 10);
        }
      }
    }

    if (targetDay && targetMonth && targetYear) {
      const dd = String(targetDay).padStart(2, '0');
      const mm = String(targetMonth).padStart(2, '0');
      formattedDDMMYYYY = `${dd}/${mm}/${targetYear}`;
    } else {
      formattedDDMMYYYY = rawDate;
    }

    inputEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    inputEl.focus();

    // 1. Direct input setting with Angular events (most reliable on IRCTC <p-calendar>)
    setNativeValue(inputEl, formattedDDMMYYYY);
    dispatchAngularEvent(inputEl, 'input', formattedDDMMYYYY);
    dispatchAngularEvent(inputEl, 'change', formattedDDMMYYYY);

    // 2. Click calendar icon or input if present to test for datepicker overlay
    const calWrapper = inputEl.closest('p-calendar, .ui-calendar, .mat-form-field, [class*="datepicker"]') || inputEl.parentElement;
    const triggerBtn = calWrapper?.querySelector('button, .ui-datepicker-trigger, .p-datepicker-trigger, .mat-datepicker-toggle');
    if (triggerBtn) {
      triggerBtn.click();
    } else {
      inputEl.click();
    }

    await sleep(250);

    // 3. If calendar popup appeared and we have a targetDay, click the day in calendar
    const calPanel = document.querySelector('.p-datepicker:not([style*="display: none"]), .ui-datepicker:not([style*="display: none"]), .mat-datepicker-content');
    if (calPanel && targetDay) {
      const dayCells = Array.from(calPanel.querySelectorAll('td:not(.p-disabled):not(.ui-state-disabled) span, td:not(.p-disabled):not(.ui-state-disabled) a, button.mat-calendar-body-cell'));
      const matchingCell = dayCells.find(cell => (cell.textContent || '').trim() === String(targetDay));
      if (matchingCell) {
        matchingCell.click();
        await sleep(150);
      }
    }

    dispatchAngularEvent(inputEl, 'change');
    inputEl.dispatchEvent(new Event('blur', { bubbles: true, composed: true }));

    return {
      success: true,
      actionType: 'pick_date',
      targetElementId: targetId,
      message: `Set date to "${formattedDDMMYYYY}" on "${targetId}"`
    };
  }

  /**
   * Interacts with custom dropdown components (PrimeNG p-dropdown, Angular Material mat-select, ng-select).
   */
  async function executeSelectCustom(targetId, optionValue) {
    let el = findElement(targetId);
    if (!el) {
      return { success: false, actionType: 'select_custom', targetElementId: targetId, message: `Custom dropdown not found: "${targetId}"` };
    }

    const valStr = String(optionValue || '').trim().toLowerCase();

    // If native SELECT, delegate to selectOptionInElement
    if (el.tagName === 'SELECT' || el.querySelector?.('select')) {
      const sel = el.tagName === 'SELECT' ? el : el.querySelector('select');
      return selectOptionInElement(sel, optionValue, targetId);
    }

    // Scroll and click trigger
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const trigger = el.querySelector('.p-dropdown-trigger, .ui-dropdown-trigger, .mat-select-trigger, [role="button"]') || el;
    trigger.click();

    // Wait for dropdown panel
    const panel = await waitForElement(() => {
      const panels = document.querySelectorAll('.p-dropdown-panel, .ui-dropdown-panel, .mat-select-panel, [role="listbox"]');
      for (const p of panels) {
        const style = window.getComputedStyle(p);
        if (style.display !== 'none' && style.visibility !== 'hidden') return p;
      }
      return null;
    }, 1500, 50);

    if (panel) {
      const items = Array.from(panel.querySelectorAll('li, .p-dropdown-item, .ui-dropdown-item, mat-option, [role="option"]'));
      let matchedItem = items.find(it => {
        const t = (it.textContent || '').trim().toLowerCase();
        return t === valStr || t.includes(valStr) || valStr.includes(t);
      });
      if (!matchedItem && items.length > 0) {
        matchedItem = items[0];
      }

      if (matchedItem) {
        matchedItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        matchedItem.click();
        await sleep(150);
        return {
          success: true,
          actionType: 'select_custom',
          targetElementId: targetId,
          message: `Selected custom option "${matchedItem.textContent.trim()}" on "${targetId}"`
        };
      }
    }

    return {
      success: true,
      actionType: 'select_custom',
      targetElementId: targetId,
      message: `Clicked dropdown trigger on "${targetId}"`
    };
  }

  /**
   * Batch fills multiple form fields locally (From, To, Date, Class).
   * Ensures private details never touch any remote reasoning model.
   */
  async function executeFillForm(fields) {
    if (!fields || (typeof fields !== 'object' && !Array.isArray(fields))) {
      return { success: false, actionType: 'fill_form', message: 'No fields provided in fill_form' };
    }

    const fieldEntries = Array.isArray(fields)
      ? fields
      : Object.entries(fields).map(([k, v]) => ({ name: k, value: v }));

    const results = [];
    for (const f of fieldEntries) {
      const val = f.value;
      if (!val) continue;

      const targetIdentifier = f.targetElementId || f.id || f.name || f.label;
      const widgetType = f.widgetType || (
        /from|to|station|origin|dest/i.test(targetIdentifier) ? 'autocomplete' :
        /date|journey|day|cal/i.test(targetIdentifier) ? 'datepicker' :
        /class|quota/i.test(targetIdentifier) ? 'dropdown' : 'type'
      );

      let subResult;
      if (widgetType === 'autocomplete') {
        subResult = await executeTypeAndSelect(targetIdentifier, val);
      } else if (widgetType === 'datepicker') {
        subResult = await executePickDate(targetIdentifier, val);
      } else if (widgetType === 'dropdown') {
        subResult = await executeSelectCustom(targetIdentifier, val);
      } else {
        const el = findElement(targetIdentifier);
        if (el) {
          const inp = resolveInputTarget(el);
          inp.focus();
          setNativeValue(inp, val);
          dispatchAngularEvent(inp, 'input', val);
          dispatchAngularEvent(inp, 'change', val);
          subResult = { success: true, message: `Filled ${targetIdentifier} with ${val}` };
        } else {
          subResult = { success: false, message: `Could not find element for ${targetIdentifier}` };
        }
      }
      results.push({ field: targetIdentifier, result: subResult });
      await sleep(200);
    }

    return {
      success: results.some(r => r.result?.success),
      actionType: 'fill_form',
      message: `Filled ${results.length} fields: ` + results.map(r => `${r.field}: ${r.result?.success ? 'OK' : 'FAIL'}`).join(', '),
      details: results
    };
  }

  /**
   * Simulates realistic typing by dispatching keyboard events character by character.
   */
  function simulateTyping(element, text) {
    return new Promise((resolve) => {
      // Focus the element
      element.focus();

      // Clear existing content
      if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
        element.value = '';
        element.dispatchEvent(new Event('input', { bubbles: true }));
      } else if (element.isContentEditable) {
        element.textContent = '';
      }

      let i = 0;
      const typeChar = () => {
        if (i >= text.length) {
          // Final events
          element.dispatchEvent(new Event('change', { bubbles: true }));
          element.dispatchEvent(new Event('input', { bubbles: true }));
          resolve();
          return;
        }

        const char = text[i];

        // Dispatch keyboard events
        element.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
        element.dispatchEvent(new KeyboardEvent('keypress', { key: char, bubbles: true }));

        if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
          element.value += char;
        } else if (element.isContentEditable) {
          element.textContent += char;
        }

        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));

        i++;
        // Random delay between 30-80ms per character for realism
        setTimeout(typeChar, 30 + Math.random() * 50);
      };

      typeChar();
    });
  }

  /**
   * Scrolls the element into view with smooth behavior, then clicks it.
   */
  function clickElement(element) {
    // Scroll into view if needed
    element.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });

    return new Promise((resolve) => {
      // Small delay to allow scroll to complete
      setTimeout(() => {
        try {
          // Dispatch full mouse event sequence
          const rect = element.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;

          const eventOpts = {
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
            button: 0
          };

          element.dispatchEvent(new MouseEvent('mousedown', eventOpts));
          element.dispatchEvent(new MouseEvent('mouseup', eventOpts));
          element.dispatchEvent(new MouseEvent('click', eventOpts));

          // Also call .click() as fallback for elements with onclick handlers
          if (typeof element.click === 'function') {
            element.click();
          }

          resolve(true);
        } catch (e) {
          resolve(false);
        }
      }, 300);
    });
  }

  /**
   * Intelligently selects an option in a <select> element supporting:
   * - Exact value / text match
   * - Ordinal words (first, second, third, fourth, fifth, sixth, seventh, eighth)
   * - Number / digit extraction (e.g. "fourth semester" -> 4 -> matches "4th Semester", "4", "IV")
   * - Roman numerals (I, II, III, IV, V, VI, VII, VIII)
   * - Substring / fuzzy match
   * - Index-based fallback
   * - ASP.NET WebForms / jQuery / HTML5 event dispatching (__doPostBack)
   */
  function selectOptionInElement(el, val, targetElementId) {
    if (!el) {
      return {
        success: false,
        actionType: 'select',
        targetElementId: targetElementId,
        message: `Select element not found: "${targetElementId}"`
      };
    }

    if (el.tagName !== 'SELECT') {
      const innerSelect = el.querySelector?.('select');
      if (innerSelect) {
        el = innerSelect;
      } else {
        // Try clicking it instead (for custom ARIA dropdowns)
        el.click();
        return {
          success: true,
          actionType: 'select',
          targetElementId: targetElementId,
          message: `Clicked non-native select element "${targetElementId}" (custom dropdown)`
        };
      }
    }

    if (!val) {
      return {
        success: true,
        actionType: 'select',
        targetElementId: targetElementId,
        message: `No value specified to select on "${targetElementId}"`
      };
    }

    const valStr = String(val).trim();
    const valLower = valStr.toLowerCase();

    // Mapping for ordinals & Roman numerals
    const ORDINAL_MAP = {
      'first': 1, '1st': 1, 'i': 1, 'one': 1,
      'second': 2, '2nd': 2, 'ii': 2, 'two': 2,
      'third': 3, '3rd': 3, 'iii': 3, 'three': 3,
      'fourth': 4, 'forth': 4, '4th': 4, 'iv': 4, 'four': 4,
      'fifth': 5, '5th': 5, 'v': 5, 'five': 5,
      'sixth': 6, '6th': 6, 'vi': 6, 'six': 6,
      'seventh': 7, '7th': 7, 'vii': 7, 'seven': 7,
      'eighth': 8, '8th': 8, 'viii': 8, 'eight': 8,
      'ninth': 9, '9th': 9, 'ix': 9, 'nine': 9,
      'tenth': 10, '10th': 10, 'x': 10, 'ten': 10
    };

    // Extract numeric intent if present (e.g. "fourth semester" -> 4, "sem 4" -> 4, "4" -> 4)
    let targetNum = null;
    const numMatch = valLower.match(/\b(\d+)(?:st|nd|rd|th)?\b/);
    if (numMatch) {
      targetNum = parseInt(numMatch[1], 10);
    } else {
      for (const [word, num] of Object.entries(ORDINAL_MAP)) {
        const regex = new RegExp(`\\b${word}\\b`, 'i');
        if (regex.test(valLower)) {
          targetNum = num;
          break;
        }
      }
    }

    let matchedOpt = null;
    let matchedIndex = -1;

    // Strategy 1: Exact match on value or textContent
    for (let i = 0; i < el.options.length; i++) {
      const opt = el.options[i];
      const optVal = (opt.value || '').trim();
      const optText = (opt.textContent || '').trim();
      if (optVal.toLowerCase() === valLower || optText.toLowerCase() === valLower) {
        matchedOpt = opt;
        matchedIndex = i;
        break;
      }
    }

    // Strategy 2: Numeric / Ordinal match
    if (!matchedOpt && targetNum !== null) {
      const romanNumerals = ['', 'i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x'];
      const targetRoman = romanNumerals[targetNum] || '';
      for (let i = 0; i < el.options.length; i++) {
        const opt = el.options[i];
        const optVal = (opt.value || '').trim().toLowerCase();
        const optText = (opt.textContent || '').trim().toLowerCase();

        // Check if value is the exact number (e.g. value="4")
        if (optVal === String(targetNum)) {
          matchedOpt = opt;
          matchedIndex = i;
          break;
        }

        // Check if option text explicitly refers to target number (e.g. "4th Semester", "Semester - 4", "Sem 4")
        const optNumMatch = optText.match(/\b(\d+)(?:st|nd|rd|th)?\b/);
        if (optNumMatch && parseInt(optNumMatch[1], 10) === targetNum) {
          matchedOpt = opt;
          matchedIndex = i;
          break;
        }

        // Check Roman numeral match (e.g. "IV" or "Semester IV")
        if (targetRoman) {
          const romanRegex = new RegExp(`\\b${targetRoman}\\b`, 'i');
          if (romanRegex.test(optText) || romanRegex.test(optVal)) {
            matchedOpt = opt;
            matchedIndex = i;
            break;
          }
        }
      }
    }

    // Strategy 3: Substring / token containment (excluding placeholders like --Select--)
    if (!matchedOpt) {
      for (let i = 0; i < el.options.length; i++) {
        const opt = el.options[i];
        const optText = (opt.textContent || '').trim().toLowerCase();
        if (/select|choose|--/i.test(optText) && i === 0) continue;

        if (optText.includes(valLower) || valLower.includes(optText)) {
          matchedOpt = opt;
          matchedIndex = i;
          break;
        }
      }
    }

    // Strategy 4: Index-based match for 1-based ordinals if reasonable
    if (!matchedOpt && targetNum !== null) {
      if (targetNum < el.options.length) {
        const firstOptText = (el.options[0].textContent || '').toLowerCase();
        const firstIsPlaceholder = /select|choose|--/i.test(firstOptText) || el.options[0].value === '0' || el.options[0].value === '';
        const candidateIndex = firstIsPlaceholder ? targetNum : targetNum - 1;
        if (candidateIndex >= 0 && candidateIndex < el.options.length) {
          matchedOpt = el.options[candidateIndex];
          matchedIndex = candidateIndex;
        }
      }
    }

    if (!matchedOpt) {
      const availableOpts = Array.from(el.options).map(o => o.textContent.trim()).slice(0, 10).join(', ');
      return {
        success: false,
        actionType: 'select',
        targetElementId: targetElementId,
        message: `No option matching "${valStr}" found in select. Available options: [${availableOpts}]`
      };
    }

    // Apply selection
    el.selectedIndex = matchedIndex;
    el.value = matchedOpt.value;
    matchedOpt.selected = true;

    // Dispatch comprehensive event chain for ASP.NET WebForms & modern frameworks
    el.focus();
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

    // ASP.NET WebForms inline onchange / __doPostBack trigger
    if (typeof el.onchange === 'function') {
      try { el.onchange.call(el, new Event('change')); } catch (e) {}
    } else if (el.getAttribute('onchange')) {
      try {
        const oc = el.getAttribute('onchange');
        if (oc && (oc.includes('__doPostBack') || oc.includes('submit'))) {
          window.eval?.(oc);
        }
      } catch (e) {}
    }

    el.blur();

    return {
      success: true,
      actionType: 'select',
      targetElementId: targetElementId,
      message: `Selected "${matchedOpt.textContent.trim()}" (value: "${matchedOpt.value}") in "${targetElementId || el.id || 'select'}"`
    };
  }

  // ── Execute the action ──

  if (actionType === 'click') {
    const el = findElement(targetId);
    if (!el) {
      return {
        success: false,
        actionType: 'click',
        targetElementId: targetId,
        message: `Element not found: "${targetId}". It may have changed since the last screenshot.`
      };
    }

    // If clicked element is a <select> and a value is provided, route directly to option selection
    if ((el.tagName === 'SELECT' || el.querySelector?.('select')) && value) {
      const selectEl = el.tagName === 'SELECT' ? el : el.querySelector('select');
      return selectOptionInElement(selectEl, value, targetId);
    }

    // Safety Circuit-Breaker: Prevent clicking "Search Trains" if From/To stations are empty on IRCTC
    const isSearchTrainsBtn = (el.textContent && /search\s*trains|find\s*trains/i.test(el.textContent)) ||
      el.classList?.contains('search_btn') || el.classList?.contains('train_Search') ||
      (el.type === 'submit' && (window.location.hostname.includes('irctc.co.in') || document.querySelector('p-autocomplete')));
    if (isSearchTrainsBtn) {
      const pAutos = Array.from(document.querySelectorAll('p-autocomplete input, .ui-autocomplete input'));
      const fromInp = pAutos[0] || document.querySelector('input[placeholder*="from" i], input[aria-label*="from" i], #origin input');
      const toInp = pAutos[1] || document.querySelector('input[placeholder*="to" i], input[aria-label*="to" i], #destination input');
      const fromEmpty = !fromInp || !fromInp.value || fromInp.value.trim() === '';
      const toEmpty = !toInp || !toInp.value || toInp.value.trim() === '';
      if (fromEmpty || toEmpty) {
        console.warn('[Privamon ActionExecutor] Blocked premature click on Search Trains button: From/To are empty!');
        return {
          success: false,
          actionType: 'click',
          targetElementId: targetId,
          needsClarification: true,
          message: 'Cannot click Search Trains: Please enter From and To stations first.'
        };
      }
    }

    // We can't await in a synchronous IIFE return, so we use a synchronous click
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });

    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const eventOpts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, composed: true };

    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: x, clientY: y }));
    el.dispatchEvent(new MouseEvent('mousedown', eventOpts));
    el.dispatchEvent(new MouseEvent('mouseup', eventOpts));
    el.dispatchEvent(new MouseEvent('click', eventOpts));

    // Focus for inputs
    if (el.focus) el.focus();

    // Native .click() invocation for anchor or button elements
    if (typeof el.click === 'function') {
      el.click();
    }

    // YouTube SPA Video / Playlist / Course click fallback: robust resolution of playable links
    if (window.location.hostname.includes('youtube.com')) {
      let targetHref = null;
      // Strategy 1: direct href on clicked element or parent <a>
      const directHref = el.href || el.getAttribute('href') || el.closest('a')?.href || el.closest('a')?.getAttribute('href');
      if (directHref && (/watch\?v=|playlist\?list=|\/playlist|\/course/i.test(directHref))) {
        targetHref = directHref;
      }
      // Strategy 2: Find title link or playable thumbnail inside closest video/playlist container
      if (!targetHref) {
        const mediaContainer = el.closest(
          'ytd-video-renderer, ytd-playlist-renderer, ytd-radio-renderer, ytd-rich-item-renderer, ytd-compact-video-renderer, ytd-reel-item-renderer, yt-lockup-view-model, ytd-playlist-video-renderer, ytd-grid-playlist-renderer'
        );
        if (mediaContainer) {
          const mediaLink = mediaContainer.querySelector('a#video-title, a[href*="/watch"], a[href*="/playlist?list="], a[href*="/course/"], a#thumbnail, ytd-thumbnail-overlay-hover-text-renderer');
          if (mediaLink) {
            targetHref = mediaLink.href || mediaLink.getAttribute('href') || mediaLink.closest('a')?.href;
            try { mediaLink.click(); } catch (e) {}
          }
        }
      }
      // Strategy 3: If element is #video-title itself
      if (!targetHref && (el.id === 'video-title' || el.querySelector?.('#video-title'))) {
        targetHref = el.href || el.closest('a')?.href;
      }

      // If we found a playable target link and after 300ms the page is still on /results, execute SPA navigation fallback
      if (targetHref && (/watch\?v=|playlist\?list=|\/playlist|\/course/i.test(targetHref))) {
        setTimeout(() => {
          if (window.location.pathname.startsWith('/results')) {
            console.log('[Privamon ActionExecutor] Executing YouTube media navigation fallback to:', targetHref);
            window.location.href = targetHref;
          }
        }, 300);
      }
    }

    // Visual feedback — brief highlight
    const origOutline = el.style.outline;
    const origTransition = el.style.transition;
    el.style.transition = 'outline 0.2s ease';
    el.style.outline = '3px solid #4ade80';
    setTimeout(() => {
      el.style.outline = origOutline;
      el.style.transition = origTransition;
    }, 1200);

    return {
      success: true,
      actionType: 'click',
      targetElementId: targetId,
      message: `Clicked element "${targetId}" at (${Math.round(x)}, ${Math.round(y)})`
    };
  }

  if (actionType === 'type') {
    const el = findElement(targetId);
    if (!el) {
      return {
        success: false,
        actionType: 'type',
        targetElementId: targetId,
        message: `Input element not found: "${targetId}"`
      };
    }

    // Strip any leaked step guidance or verification text from the value
    let cleanValue = value;
    if (cleanValue) {
      cleanValue = cleanValue.replace(/\[(?:STEP GUIDANCE|VERIFY TASK COMPLETION)[^\]]*\]/gi, '').trim();
    }

    if (!cleanValue) {
      return {
        success: false,
        actionType: 'type',
        targetElementId: targetId,
        message: 'No value provided to type'
      };
    }

    // If target is a SELECT element, redirect to selectOptionInElement
    if (el.tagName === 'SELECT' || el.querySelector?.('select')) {
      const selectEl = el.tagName === 'SELECT' ? el : el.querySelector('select');
      return selectOptionInElement(selectEl, cleanValue, targetId);
    }

    // If target is a wrapper/container or accidentally targeted button, locate the real editable input
    let targetNode = el;
    const isButton = targetNode.tagName === 'BUTTON' || targetNode.getAttribute('role') === 'button';
    if (isButton || (!targetNode.isContentEditable && targetNode.tagName !== 'INPUT' && targetNode.tagName !== 'TEXTAREA')) {
      const editableChild = targetNode.querySelector?.('[contenteditable="true"], input, textarea');
      if (editableChild) {
        targetNode = editableChild;
      } else if (isButton) {
        // Find adjacent or global message input on page
        const nearbyInput = targetNode.closest('footer, form, div')?.querySelector?.('[contenteditable="true"], [role="textbox"], input, textarea')
          || document.querySelector('div[contenteditable="true"][role="textbox"], div[contenteditable="true"], [role="textbox"], textarea, input[type="text"]:not([type="hidden"])');
        if (nearbyInput) {
          targetNode = nearbyInput;
        } else {
          return {
            success: false,
            actionType: 'type',
            targetElementId: targetId,
            message: `Target element is a button, not an editable text input: "${targetId}".`
          };
        }
      }
    }

    // Focus and scroll
    targetNode.scrollIntoView({ behavior: 'smooth', block: 'center' });
    targetNode.focus();

    const isContentEditable = targetNode.isContentEditable || targetNode.getAttribute('contenteditable') === 'true';

    if (isContentEditable) {
      // Robust rich-text editor typing (Lexical for WhatsApp Web, Draft.js, ProseMirror, Slate)
      try {
        // 1. Select all existing text inside editable element so we replace cleanly
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(targetNode);
        selection.removeAllRanges();
        selection.addRange(range);

        // 2. Native document.execCommand — Chromium automatically fires native beforeinput and input events.
        // DO NOT add synchronous textContent fallbacks here, as modern frameworks (Lexical/React)
        // update their internal DOM state asynchronously, which would falsely trigger the fallback and duplicate text!
        document.execCommand('insertText', false, cleanValue);
      } catch (e) {
        console.warn('[Privamon ActionExecutor] ContentEditable typing error:', e);
        targetNode.textContent = cleanValue;
        targetNode.dispatchEvent(new Event('input', { bubbles: true }));
      }
      targetNode.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (targetNode.tagName === 'INPUT' || targetNode.tagName === 'TEXTAREA') {
      // Select all existing text and replace
      targetNode.select();
      targetNode.value = cleanValue;

      // For React controlled components — invoke prototype setter
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      )?.set;
      const nativeTextareaValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value'
      )?.set;

      if (targetNode.tagName === 'INPUT' && nativeInputValueSetter) {
        nativeInputValueSetter.call(targetNode, cleanValue);
      } else if (targetNode.tagName === 'TEXTAREA' && nativeTextareaValueSetter) {
        nativeTextareaValueSetter.call(targetNode, cleanValue);
      }

      dispatchAngularEvent(targetNode, 'input', cleanValue);
      dispatchAngularEvent(targetNode, 'change', cleanValue);
    }

    // Auto-submit detection for Search inputs (YouTube, Google, GitHub, etc.)
    const nameAttr = (targetNode.getAttribute('name') || '').toLowerCase();
    const idAttr = (targetNode.id || '').toLowerCase();
    const roleAttr = (targetNode.getAttribute('role') || '').toLowerCase();
    const placeholderAttr = (targetNode.getAttribute('placeholder') || '').toLowerCase();
    const ariaLabel = (targetNode.getAttribute('aria-label') || '').toLowerCase();
    const titleAttr = (targetNode.getAttribute('title') || '').toLowerCase();
    const combinedAttrs = `${placeholderAttr} ${ariaLabel} ${nameAttr} ${idAttr} ${titleAttr}`;

    const isSearchInput = (
      idAttr === 'search' ||
      nameAttr === 'search_query' ||
      nameAttr === 'q' ||
      targetNode.type === 'search' ||
      roleAttr === 'searchbox' ||
      (roleAttr === 'combobox' && /search/i.test(combinedAttrs)) ||
      /search|find|query/i.test(combinedAttrs)
    );

    const isChatOrMessageInput = (
      /message|chat|reply|type a message|send/i.test(combinedAttrs) ||
      (isContentEditable && (roleAttr === 'textbox' || !isSearchInput)) ||
      window.location.hostname.includes('whatsapp.com') ||
      window.location.hostname.includes('telegram.org') ||
      window.location.hostname.includes('messenger.com') ||
      window.location.hostname.includes('slack.com') ||
      window.location.hostname.includes('discord.com')
    );

    if (isSearchInput) {
      setTimeout(() => {
        // 1. Dispatch Enter key sequence (keydown, keypress, keyup)
        const enterOpts = {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          charCode: 13,
          bubbles: true,
          cancelable: true,
          composed: true
        };
        targetNode.dispatchEvent(new KeyboardEvent('keydown', enterOpts));
        targetNode.dispatchEvent(new KeyboardEvent('keypress', enterOpts));
        targetNode.dispatchEvent(new KeyboardEvent('keyup', enterOpts));

        // 2. Submit parent form directly if present (native HTML form submission for Flipkart, Amazon, etc.)
        const parentForm = targetNode.form || targetNode.closest('form');
        if (parentForm) {
          try {
            parentForm.requestSubmit();
          } catch (e) {
            try { parentForm.submit(); } catch (e2) {}
          }
        }

        // 3. Locate and click dedicated Search button (Flipkart, YouTube #search-icon-legacy, Amazon, etc.)
        setTimeout(() => {
          const searchBtnCandidates = [
            parentForm?.querySelector('button[type="submit"], input[type="submit"], button, [role="button"]'),
            targetNode.closest('form, ytd-searchbox, [role="search"], div, header')?.querySelector(
              'button#search-icon-legacy, button[aria-label*="Search" i], button[title*="Search" i], button[type="submit"]'
            ),
            document.querySelector('button#search-icon-legacy, button[aria-label*="Search" i], button[title*="Search" i]')
          ];
          for (const btn of searchBtnCandidates) {
            if (btn) {
              const btnLabel = (btn.getAttribute('aria-label') || btn.getAttribute('title') || btn.textContent || '').toLowerCase();
              if (/voice|mic|audio|record/i.test(btnLabel)) continue;
              try { btn.click(); } catch (e) {}
              break;
            }
          }

          // 4. SPA Navigation Fallbacks for popular platforms
          const host = window.location.hostname;
          if (host.includes('flipkart.com')) {
            setTimeout(() => {
              if (!window.location.pathname.startsWith('/search')) {
                console.log('[Privamon ActionExecutor] Executing Flipkart search navigation fallback for:', cleanValue);
                window.location.href = `/search?q=${encodeURIComponent(cleanValue)}`;
              }
            }, 350);
          } else if (host.includes('youtube.com')) {
            setTimeout(() => {
              if (!window.location.pathname.startsWith('/results')) {
                console.log('[Privamon ActionExecutor] Executing YouTube search navigation fallback for:', cleanValue);
                window.location.href = `/results?search_query=${encodeURIComponent(cleanValue)}`;
              }
            }, 350);
          } else if (host.includes('amazon.')) {
            setTimeout(() => {
              if (!window.location.pathname.startsWith('/s')) {
                console.log('[Privamon ActionExecutor] Executing Amazon search navigation fallback for:', cleanValue);
                window.location.href = `/s?k=${encodeURIComponent(cleanValue)}`;
              }
            }, 350);
          }
        }, 80);
      }, 60);
    } else if (isChatOrMessageInput) {
      // If NOT contentEditable (e.g. standard input or textarea), ensure input event is fired
      if (!isContentEditable) {
        try {
          targetNode.dispatchEvent(new Event('input', { bubbles: true }));
        } catch (e) { /* ignore */ }
      }

      // Send the message ONCE using either the Send button OR the Enter key (never both)
      setTimeout(() => {
        let sent = false;

        // Strategy 1: Check if a dedicated Send button is present in the UI
        const sendSelectors = [
          'button[aria-label="Send"]',
          'button[aria-label="send"]',
          'button[aria-label*="Send" i]',
          'span[data-icon="send"]',
          '[data-icon="send"]',
          'span[data-testid="send"]',
          '[data-testid="send"]',
          'button[data-testid="compose-btn-send"]',
          'button[data-testid*="send" i]',
          'button[data-tab="11"]',
          'button[title="Send"]',
          'button[title="send"]',
          'button[title*="Send" i]'
        ];

        for (const sel of sendSelectors) {
          let found;
          try { found = document.querySelectorAll(sel); } catch(e) { continue; }
          for (const el of found) {
            const btn = el.closest('button') || el;
            const label = (btn.getAttribute('aria-label') || btn.getAttribute('title') || '').toLowerCase();
            const icon = (btn.getAttribute('data-icon') || btn.querySelector?.('[data-icon]')?.getAttribute('data-icon') || '').toLowerCase();
            const testId = (btn.getAttribute('data-testid') || btn.querySelector?.('[data-testid]')?.getAttribute('data-testid') || '').toLowerCase();
            if (/voice|mic|ptt|audio|record/i.test(label) || icon === 'ptt' || testId.includes('ptt') || testId.includes('mic')) {
              continue;
            }
            console.log('[Privamon ActionExecutor] Clicking chat send button once');
            btn.click();
            sent = true;
            break;
          }
          if (sent) break;
        }

        // Strategy 2: If no dedicated Send button was found, dispatch Enter key sequence ONCE
        if (!sent) {
          console.log('[Privamon ActionExecutor] No send button found; dispatching Enter key once');
          const enterOpts = {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            which: 13,
            charCode: 13,
            bubbles: true,
            cancelable: true,
            composed: true
          };
          targetNode.dispatchEvent(new KeyboardEvent('keydown', enterOpts));
          targetNode.dispatchEvent(new KeyboardEvent('keypress', enterOpts));
          targetNode.dispatchEvent(new KeyboardEvent('keyup', enterOpts));
        }
      }, 100);
    }

    // Visual feedback
    const origOutline = targetNode.style.outline;
    targetNode.style.outline = '3px solid #60a5fa';
    setTimeout(() => { targetNode.style.outline = origOutline; }, 1200);

    return {
      success: true,
      actionType: 'type',
      targetElementId: targetId,
      message: `Typed "${cleanValue.length > 50 ? cleanValue.slice(0, 50) + '...' : cleanValue}" into "${targetId}"${isChatOrMessageInput ? ' and sent message' : ''}`
    };
  }

  if (actionType === 'scroll') {
    const dir = (scrollDirection || 'down').toLowerCase();
    const amount = dir === 'up' ? -window.innerHeight * 0.75 : window.innerHeight * 0.75;
    window.scrollBy({ top: amount, behavior: 'smooth' });

    return {
      success: true,
      actionType: 'scroll',
      targetElementId: null,
      message: `Scrolled ${dir} by ${Math.abs(Math.round(amount))}px`
    };
  }

  if (actionType === 'select') {
    let el = findElement(targetId);
    if (!el) {
      // Fallback: search for any select on the page if targetId mentions select/semester or if only 1 select
      const allSelects = document.querySelectorAll('select');
      if (allSelects.length === 1) {
        el = allSelects[0];
      } else if (targetId) {
        for (const s of allSelects) {
          const sId = (s.id || '').toLowerCase();
          const sName = (s.name || '').toLowerCase();
          const tId = targetId.toLowerCase();
          if (sId.includes(tId) || sName.includes(tId) || tId.includes(sId) || tId.includes('semester')) {
            el = s;
            break;
          }
        }
      }
    }

    return selectOptionInElement(el, value, targetId);
  }

  if (actionType === 'wait') {
    // In synchronous context we can't truly wait, but we signal success
    return {
      success: true,
      actionType: 'wait',
      targetElementId: null,
      message: 'Wait action acknowledged. Page state may need re-evaluation.'
    };
  }

  if (actionType === 'done') {
    return {
      success: true,
      actionType: 'done',
      targetElementId: null,
      message: 'Task marked as complete by the reasoning agent.'
    };
  }

  if (actionType === 'ask_user') {
    return {
      success: true,
      actionType: 'ask_user',
      targetElementId: null,
      message: value || 'The agent needs clarification before proceeding.'
    };
  }

  if (actionType === 'type_and_select') {
    return await executeTypeAndSelect(targetId, value);
  }

  if (actionType === 'pick_date') {
    return await executePickDate(targetId, value);
  }

  if (actionType === 'select_custom') {
    return await executeSelectCustom(targetId, value);
  }

  if (actionType === 'fill_form') {
    const fields = action.fields || (value ? (typeof value === 'object' ? value : JSON.parse(value)) : null);
    return await executeFillForm(fields);
  }

  return {
    success: false,
    actionType: actionType,
    targetElementId: targetId,
    message: `Unknown action type: "${actionType}"`
  };
  } catch (err) {
    console.error('[Privamon ActionExecutor] Execution error:', err);
    return {
      success: false,
      actionType: actionType,
      targetElementId: targetId,
      message: `Action execution error: ${err.message || String(err)}`
    };
  }
})();
