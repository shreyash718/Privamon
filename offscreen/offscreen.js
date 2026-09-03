/**
 * Privamon — Offscreen Document Controller
 *
 * Listens for messages from the background service worker,
 * runs the sanitization pipeline, and sends results back.
 */
(() => {
  'use strict';

  console.log('[Offscreen] Document loaded, modules initialized');

  // Listen for messages from the background service worker
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action !== 'runPipeline') return;

    // Run the pipeline asynchronously
    handlePipeline(message)
      .then(result => {
        // Send the result back to the background
        chrome.runtime.sendMessage({
          type: 'pipelineResult',
          result,
        });
      })
      .catch(err => {
        console.error('[Offscreen] Pipeline error:', err);
        chrome.runtime.sendMessage({
          type: 'pipelineResult',
          error: err.message || 'Pipeline failed',
        });
      });

    // Return true to indicate we will respond asynchronously via sendMessage
    // (we don't use sendResponse because the pipeline is long-running)
    return true;
  });

  /**
   * Handle the pipeline execution.
   */
  async function handlePipeline(message) {
    const { screenshot, domData } = message;

    console.log(`[Offscreen] Starting pipeline with ${domData.elements.length} elements`);

    const result = await Privamon.SanitizePipeline.run({
      screenshot,
      domData,
      onProgress: (stageId, status, statusText) => {
        // Forward progress to the background (which forwards to popup)
        chrome.runtime.sendMessage({
          type: 'pipelineProgress',
          stageId,
          status,
          statusText,
        });
      },
    });

    console.log('[Offscreen] Pipeline complete');
    return result;
  }
})();
