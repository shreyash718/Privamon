/**
 * Privamon Marketing & Documentation Portal — Interactive Logic
 *
 * Implements:
 *   1. IntersectionObserver: pipeline card step-by-step reveal
 *   2. IntersectionObserver: general section element reveal
 *   3. Accessible Tab navigation (Tested Sites vs Report)
 *   4. Vercel Serverless Form submission to /api/report
 *   5. Smooth scroll navigation
 */

document.addEventListener('DOMContentLoaded', () => {
  'use strict';

  // ── 1. Pipeline Card Scroll Animation ──
  const pipelineCards = document.querySelectorAll('.pipeline-card');

  if ('IntersectionObserver' in window && pipelineCards.length > 0) {
    const cardObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          // Stagger reveal: add small delay per card
          const card = entry.target;
          const parent = card.closest('.phase-steps');
          if (parent) {
            const siblings = Array.from(parent.querySelectorAll('.pipeline-card'));
            const idx = siblings.indexOf(card);
            setTimeout(() => {
              card.classList.add('is-active');
            }, idx * 100);
          } else {
            card.classList.add('is-active');
          }
          cardObserver.unobserve(entry.target);
        }
      });
    }, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' });

    pipelineCards.forEach(card => cardObserver.observe(card));
  } else {
    pipelineCards.forEach(card => card.classList.add('is-active'));
  }

  // ── 2. General Element Reveal ──
  const revealTargets = document.querySelectorAll(
    '.section-header, .hero-image-col, .hero-cta-group, .hero-meta-row, ' +
    '.sih-banner, .video-wrapper, .pipeline-overview-image, .phase-header, ' +
    '.phase-image-card, .limitations-box, .research-card, .install-step-card'
  );

  if ('IntersectionObserver' in window && revealTargets.length > 0) {
    const revealObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          revealObserver.unobserve(entry.target);
        }
      });
    }, { threshold: 0.08, rootMargin: '0px 0px -30px 0px' });

    revealTargets.forEach(el => {
      el.classList.add('reveal');
      revealObserver.observe(el);
    });
  }

  // ── 3. Compatibility & Feedback Tabs ──
  const tabBtns = document.querySelectorAll('[data-tab-target]');
  const tabPanes = document.querySelectorAll('.tab-pane');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-tab-target');

      tabBtns.forEach(b => {
        b.classList.remove('is-active');
        b.setAttribute('aria-selected', 'false');
      });
      btn.classList.add('is-active');
      btn.setAttribute('aria-selected', 'true');

      tabPanes.forEach(pane => {
        pane.classList.toggle('is-active', pane.id === targetId);
      });
    });
  });

  // ── 4. Report Form Submission ──
  const reportForm = document.getElementById('reportProblemForm');
  const reportSubmitBtn = document.getElementById('reportSubmitBtn');
  const reportBtnText = document.getElementById('reportBtnText');
  const reportBtnSpinner = document.getElementById('reportBtnSpinner');
  const formAlertSuccess = document.getElementById('formAlertSuccess');
  const formAlertError = document.getElementById('formAlertError');
  const formErrorMessage = document.getElementById('formErrorMessage');

  if (reportForm) {
    reportForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      hideAlerts();

      const name = document.getElementById('reportName')?.value.trim() || '';
      const email = document.getElementById('reportEmail')?.value.trim() || '';
      const siteUrl = document.getElementById('reportSiteUrl')?.value.trim() || '';
      const description = document.getElementById('reportDescription')?.value.trim() || '';

      if (!description || description.length < 10) {
        showError('Please provide a detailed description (at least 10 characters).');
        document.getElementById('reportDescription')?.focus();
        return;
      }

      setSubmittingState(true);

      try {
        const response = await fetch('/api/report', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ name, email, siteUrl, description })
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok || !data.success) {
          throw new Error(data.error || 'Failed to submit report.');
        }

        showSuccess(data.message || 'Thanks! Your report has been received.');
        reportForm.reset();
      } catch (err) {
        console.error('[Privamon Form Error]', err);
        const subject = encodeURIComponent(`[Privamon Report] ${siteUrl ? 'Issue on ' + siteUrl : 'Compatibility Feedback'}`);
        const bodyContent = encodeURIComponent(
          `Reporter: ${name || 'Anonymous'}\n` +
          `Contact: ${email || 'Not provided'}\n` +
          `Target Site: ${siteUrl || 'Not specified'}\n\n` +
          `Issue Description:\n${description}`
        );
        const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=shreyashmishra700@gmail.com&su=${subject}&body=${bodyContent}`;
        
        hideAlerts();
        if (formAlertError) {
          if (formErrorMessage) {
            formErrorMessage.innerHTML = `Serverless endpoint offline. <a href="${gmailUrl}" target="_blank" rel="noopener noreferrer" style="color: #ffffff; text-decoration: underline; font-weight: 600;">Click here to send this report directly via Gmail &rarr;</a>`;
          }
          formAlertError.style.display = 'flex';
          formAlertError.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
        window.open(gmailUrl, '_blank', 'noopener,noreferrer');
      } finally {
        setSubmittingState(false);
      }
    });
  }

  // Intercept any mailto: links so they open directly in Gmail web instead of triggering OS desktop apps
  document.addEventListener('click', function (e) {
    const mailLink = e.target.closest('a[href^="mailto:"]');
    if (mailLink) {
      e.preventDefault();
      const href = mailLink.getAttribute('href');
      const email = href.replace(/^mailto:/, '').split('?')[0];
      const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(email)}`;
      window.open(gmailUrl, '_blank', 'noopener,noreferrer');
    }
  });

  function setSubmittingState(isSubmitting) {
    if (!reportSubmitBtn) return;
    reportSubmitBtn.disabled = isSubmitting;
    if (reportBtnSpinner) reportBtnSpinner.style.display = isSubmitting ? 'inline-block' : 'none';
    if (reportBtnText) reportBtnText.textContent = isSubmitting ? 'Submitting…' : 'Submit Report';
  }

  function showSuccess(msg) {
    hideAlerts();
    if (formAlertSuccess) {
      const msgBox = formAlertSuccess.querySelector('.alert-text') || formAlertSuccess;
      msgBox.textContent = msg;
      formAlertSuccess.style.display = 'flex';
      formAlertSuccess.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  function showError(msg) {
    hideAlerts();
    if (formAlertError) {
      if (formErrorMessage) formErrorMessage.textContent = msg;
      formAlertError.style.display = 'flex';
      formAlertError.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  function hideAlerts() {
    if (formAlertSuccess) formAlertSuccess.style.display = 'none';
    if (formAlertError) formAlertError.style.display = 'none';
  }

  // ── 5. Smooth Anchor Scrolling ──
  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
      const targetId = this.getAttribute('href');
      if (targetId === '#') return;
      const targetEl = document.querySelector(targetId);
      if (targetEl) {
        e.preventDefault();
        targetEl.scrollIntoView({ behavior: 'smooth' });
      }
    });
  });
});
