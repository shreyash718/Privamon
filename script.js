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
    '.sih-banner, .pipeline-overview-image, .phase-header, ' +
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

  // ── 6. Symmetrical Scroll-Driven Cinema Zoom for Video Demo ──
  const videoZoomStage = document.getElementById('videoZoomStage');
  const zoomVideoWrapper = document.getElementById('zoomVideoWrapper');
  const demoHeader = document.getElementById('demoHeader');

  if (videoZoomStage && zoomVideoWrapper) {
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let ticking = false;
    let snapTimeout = null;
    let isAutoSnapping = false;

    // Instantly cancel any auto-snap when the user actively scrolls, swipes, or presses keys
    const cancelAutoSnap = () => {
      if (snapTimeout) clearTimeout(snapTimeout);
      isAutoSnapping = false;
    };

    window.addEventListener('wheel', cancelAutoSnap, { passive: true });
    window.addEventListener('touchstart', cancelAutoSnap, { passive: true });
    window.addEventListener('keydown', cancelAutoSnap, { passive: true });

    const updateSymmetricalZoom = () => {
      if (prefersReducedMotion) return;

      const stageRect = videoZoomStage.getBoundingClientRect();
      const viewportH = window.innerHeight;

      // Vertical center of the video stage and vertical center of viewport
      const stageCenterY = stageRect.top + stageRect.height / 2;
      const viewportCenterY = viewportH / 2;

      // Signed distance from center: positive when below center, negative when above
      const signedDist = stageCenterY - viewportCenterY;
      const distFromCenter = Math.abs(signedDist);

      // Active zone distance: spans from entering viewport to exiting
      const maxDistance = (viewportH + stageRect.height) * 0.54;

      // Fullscreen hold plateau: video stays at 100% maximum cinema zoom
      // across this wide, comfortable range (±155px) so stopping at full size is effortless
      const plateauRadius = Math.min(155, viewportH * 0.18);

      // Calculate responsive scale bounds
      const baseW = Math.min(820, window.innerWidth - 44);
      const baseH = (baseW * 9) / 16 + 50;

      // Expansive IMAX Cinema scale: target up to 94vw or 1320px wide
      const targetCinemaW = Math.min(window.innerWidth * 0.94, 1320);
      const maxScaleW = targetCinemaW / baseW;

      // Vertical safety limit: leaves at least 18% of screen height for margins and bottom continuation
      const maxScaleH = (viewportH * 0.82) / baseH;

      // Responsive cinema scale cap: blooms up to ~1.62x on desktop screens
      const scaleMax = Math.max(1.0, Math.min(maxScaleW, maxScaleH, 1.62));

      // Minimum scale when entering or leaving viewport
      const scaleMin = window.innerWidth < 768 ? 0.92 : 0.86;

      if (distFromCenter >= maxDistance) {
        zoomVideoWrapper.style.transform = `scale3d(${scaleMin}, ${scaleMin}, 1)`;
        zoomVideoWrapper.style.borderRadius = '16px';
        zoomVideoWrapper.style.boxShadow = '0 12px 32px rgba(0, 0, 0, 0.08)';
        if (demoHeader) {
          demoHeader.style.transform = 'translate3d(0, 0, 0)';
          demoHeader.style.opacity = '1';
        }
        return;
      }

      let factor = 0;
      if (distFromCenter <= plateauRadius) {
        // Firmly held at full cinema scale across the entire sweet-spot plateau
        factor = 1.0;
      } else {
        // Harmonic cosine curve: continuous and differentiable everywhere outside the plateau
        const outerDist = distFromCenter - plateauRadius;
        const outerSpan = Math.max(maxDistance - plateauRadius, 1);
        const normalized = Math.min(outerDist / outerSpan, 1.0);
        factor = 0.5 * (1 + Math.cos(normalized * Math.PI));
      }

      // Current scale grows continuously towards scaleMax, holds across plateau, continuously shrinks away
      const currentScale = scaleMin + (scaleMax - scaleMin) * factor;

      // Subtle shadow, amber glow, and radius modulation
      const radius = 16 - 8 * factor;
      const shadowY = Math.round(14 + 30 * factor);
      const shadowBlur = Math.round(36 + 52 * factor);
      const shadowAlpha = (0.08 + 0.18 * factor).toFixed(2);
      const amberAlpha = (0.16 * factor).toFixed(2);

      // Pure hardware-accelerated 2D scale with zero layout shifts
      zoomVideoWrapper.style.transform = `scale3d(${currentScale.toFixed(4)}, ${currentScale.toFixed(4)}, 1)`;
      zoomVideoWrapper.style.borderRadius = `${radius.toFixed(1)}px`;
      zoomVideoWrapper.style.boxShadow = `0 ${shadowY}px ${shadowBlur}px rgba(0, 0, 0, ${shadowAlpha}), 0 0 ${Math.round(48 * factor)}px rgba(192, 97, 43, ${amberAlpha})`;

      // Dynamic header choreography: smoothly dims and glides up slightly at peak zoom
      // to give the expanded video 100% of the stage without ANY text collision
      if (demoHeader) {
        const headerShift = -32 * factor;
        const headerOpacity = 1.0 - 0.40 * factor;
        demoHeader.style.transform = `translate3d(0, ${headerShift.toFixed(1)}px, 0)`;
        demoHeader.style.opacity = headerOpacity.toFixed(2);
      }

      // Stronger magnetic snap assist:
      // When the user slows down and pauses near the fullscreen zone (within ±150px),
      // gently guide the scroll to the exact center.
      // If the user continues scrolling down, it immediately yields with zero resistance.
      if (snapTimeout) clearTimeout(snapTimeout);
      snapTimeout = setTimeout(() => {
        if (!isAutoSnapping && distFromCenter <= 150 && distFromCenter > 10) {
          isAutoSnapping = true;
          window.scrollBy({
            top: signedDist,
            behavior: 'smooth'
          });
          setTimeout(() => {
            isAutoSnapping = false;
          }, 350);
        }
      }, 95);
    };

    const onScroll = () => {
      if (!ticking) {
        requestAnimationFrame(() => {
          updateSymmetricalZoom();
          ticking = false;
        });
        ticking = true;
      }
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    // Initial run
    updateSymmetricalZoom();
  }
});
