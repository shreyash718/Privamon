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
(() => {
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
    if (el) return el;

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
        return visible[index];
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

    return null;
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

    // We can't await in a synchronous IIFE return, so we use a synchronous click
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });

    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const eventOpts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 };

    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: x, clientY: y }));
    el.dispatchEvent(new MouseEvent('mousedown', eventOpts));
    el.dispatchEvent(new MouseEvent('mouseup', eventOpts));
    el.dispatchEvent(new MouseEvent('click', eventOpts));

    // Focus for inputs
    if (el.focus) el.focus();

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

    if (!value) {
      return {
        success: false,
        actionType: 'type',
        targetElementId: targetId,
        message: 'No value provided to type'
      };
    }

    // Focus and clear
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.focus();

    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      // Select all existing text and replace
      el.select();
      el.value = value;
    } else if (el.isContentEditable) {
      el.textContent = value;
    }

    // Dispatch events to trigger React/Vue/Angular change detection
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true }));

    // For React controlled components — use native setter
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    )?.set;
    const nativeTextareaValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    )?.set;

    if (el.tagName === 'INPUT' && nativeInputValueSetter) {
      nativeInputValueSetter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (el.tagName === 'TEXTAREA' && nativeTextareaValueSetter) {
      nativeTextareaValueSetter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // Visual feedback
    const origOutline = el.style.outline;
    el.style.outline = '3px solid #60a5fa';
    setTimeout(() => { el.style.outline = origOutline; }, 1200);

    return {
      success: true,
      actionType: 'type',
      targetElementId: targetId,
      message: `Typed "${value.length > 50 ? value.slice(0, 50) + '...' : value}" into "${targetId}"`
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
    const el = findElement(targetId);
    if (!el) {
      return {
        success: false,
        actionType: 'select',
        targetElementId: targetId,
        message: `Select element not found: "${targetId}"`
      };
    }

    if (el.tagName !== 'SELECT') {
      // Try clicking it instead (for custom dropdowns)
      el.click();
      return {
        success: true,
        actionType: 'select',
        targetElementId: targetId,
        message: `Clicked non-native select element "${targetId}" (custom dropdown)`
      };
    }

    if (value) {
      // Try matching by value first, then by visible text
      let matched = false;
      for (const opt of el.options) {
        if (opt.value === value || opt.textContent.trim().toLowerCase() === value.toLowerCase()) {
          el.value = opt.value;
          matched = true;
          break;
        }
      }

      if (!matched) {
        return {
          success: false,
          actionType: 'select',
          targetElementId: targetId,
          message: `No option matching "${value}" found in select`
        };
      }
    }

    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('input', { bubbles: true }));

    return {
      success: true,
      actionType: 'select',
      targetElementId: targetId,
      message: `Selected "${value}" in "${targetId}"`
    };
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

  return {
    success: false,
    actionType: actionType,
    targetElementId: targetId,
    message: `Unknown action type: "${actionType}"`
  };
})();
