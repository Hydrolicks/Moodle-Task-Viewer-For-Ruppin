// Moodle Task Viewer - Fixed for Ruppin Moodle
(function() {
  'use strict';

  let taskViewerVisible = true;
  let viewerPosition = { x: 20, y: 20 };
  let isDragging = false;
  let dragOffset = { x: 0, y: 0 };
  let dragStartPos = { x: 0, y: 0 };
  let hasDragged = false;
  let originalAssignmentBox = null;
  let updateInterval = null;
  let currentFilter = 'all'; // 'all', 'upcoming', '7days', '30days', 'custom'
  let isCollapsed = false;
  let settingsVisible = false;
  let customAssignmentOrder = []; // For custom tab: tracks order and visibility
  let customAssignmentHidden = new Set(); // For custom tab: tracks hidden assignments
  let showHiddenOnly = false; // When true, custom tab shows only hidden assignments and allows restore
  let autoHideOnSubmission = true; // User setting: auto-hide when near submission area
  let persistentViewerEnabled = false; // User setting: keep viewer on all sub-pages
  let cachedAssignments = []; // Cache assignments across sub-pages when persistent mode is on
  let customColors = {
    primary: '#f98012',
    secondary: '#ff6f00',
    tertiary: '#2d9fd8'
  };

  // Debug control: set to true to enable debug logging in development.
  // For production GitHub release we keep this false.
  const DEBUG = false;
  function dlog(...args) { if (DEBUG) console.log(...args); }
  function dwarn(...args) { if (DEBUG) console.warn(...args); }
  function derror(...args) { if (DEBUG) console.error(...args); }

  // Default Moodle-themed color preset
  const DEFAULT_COLORS = {
    primary: '#f98012',
    secondary: '#ff6f00',
    tertiary: '#2d9fd8'
  };

  // Static, hard-coded profile links 
  const STATIC_PROFILES = {
    linkedin: 'https://www.linkedin.com/in/asaf-amrani',
    github: 'https://github.com/yourname'
  };

  // -------------------------------
  // Page helpers: Expand UI
  // expandAllActivities: clicks any "show more activities" buttons
  // to ensure assignment items are loaded into the DOM before extraction.
  // -------------------------------
  function expandAllActivities(retries = 6, delay = 1200) {
    // Repeatedly try to click "show more activities" buttons until they
    // are found or retries exhausted. This helps when the page loads slowly.
    // console.log('Expanding all activities (retries=' + retries + ', delay=' + delay + ')...');
    let attempt = 0;
    const runOnce = () => {
      attempt++;
      let clickedCount = 0;
      const allElements = document.querySelectorAll('button');
      allElements.forEach(el => {
        const text = (el.textContent || '').trim();
        if (text === 'הצגת פעילויות נוספות' || text.includes('הצגת פעילויות נוספות')) {
          try { el.click(); clickedCount++; } catch (e) { dwarn('Failed to click show more activities:', e); }
        }
      });
      // If we clicked any buttons, use a MutationObserver on the timeline
      // container to detect when new assignment items are inserted and
      // then update the viewer. This is more robust than polling.
      if (clickedCount > 0) {
        // console.log(`Clicked ${clickedCount} "show more activities" buttons.`);
        const initialCount = document.querySelectorAll('.timeline-event-list-item').length;
        // Choose a likely container to observe
        const timelineContainer = document.querySelector('[data-region="timeline"]') || document.querySelector('.timeline') || document.body;
        try {
          const observer = new MutationObserver((mutations, obs) => {
            const nowCount = document.querySelectorAll('.timeline-event-list-item').length;
              if (nowCount > initialCount) {
              // console.log('expandAllActivities: detected new assignment items via MutationObserver, updating viewer.');
              try { updateViewer(); } catch (e) {}
              try { obs.disconnect(); } catch (e) {}
            }
          });
          observer.observe(timelineContainer, { childList: true, subtree: true });
          // Fallback: stop observing after a timeout and trigger update
          setTimeout(() => {
            try {
              observer.disconnect();
            } catch (e) {}
            // console.log('expandAllActivities: observer timeout, calling updateViewer fallback.');
            try { updateViewer(); } catch (e) {}
          }, Math.max(2000, delay * 2));
        } catch (e) {
          // console.warn('expandAllActivities: MutationObserver not available or failed, falling back to updateViewer.', e);
          try { updateViewer(); } catch (e) {}
        }
        return; // don't schedule another run immediately; observer will call update
      }
      if (attempt < retries) {
        setTimeout(runOnce, delay);
      } else {
        // console.log('expandAllActivities: no buttons found after retries, calling updateViewer.');
        try { updateViewer(); } catch (e) {}
      }
    };
    // Start slightly delayed to allow initial DOM to settle
    setTimeout(runOnce, 400);
  }

  // Ensure the floating viewer is created until successful.
  function ensureViewerLoaded(maxAttempts = 30, interval = 1000) {
    let attempts = 0;
    const id = setInterval(() => {
      attempts++;
      const existing = document.getElementById('moodle-task-viewer');
      if (existing) {
        clearInterval(id);
        return;
      }
      try {
        createFloatingTaskViewer();
        const nowExists = document.getElementById('moodle-task-viewer');
        if (nowExists) {
          // once viewer exists, try expanding activities again to ensure content
          try { expandAllActivities(6, 800); } catch (e) { /* ignore */ }
          clearInterval(id);
        }
      } catch (e) {
        // console.warn('ensureViewerLoaded: createFloatingTaskViewer failed on attempt', attempts, e);
      }
      if (attempts >= maxAttempts) {
        clearInterval(id);
        // console.warn('ensureViewerLoaded: giving up after', attempts, 'attempts');
      }
    }, interval);
    return;
  }

  // -------------------------------
  // DOM helper: findAssignmentBox
  // - Attempts to locate the main assignments/timeline container used by
  //   Ruppin Moodle so the viewer can inspect its contents.
  // -------------------------------
  function findAssignmentBox() {
    const selector = '[data-region="timeline"]';
    const element = document.querySelector(selector);
    if (element) {
      // console.log('Found assignment box with selector:', selector);
      return element;
    }
    return null;
  }

    // Normalize assignment link for stable comparisons (strip hash, normalize origin+path+search, remove trailing slash)
    function normalizeLink(href) {
      if (!href) return '';
      try {
        const url = new URL(href, location.origin);
        let path = url.pathname.replace(/\/+$|\\\?$/g, '');
        // keep search params since they may identify resources, but remove hash
        const normalized = url.origin + path + (url.search || '');
        return normalized.replace(/\/$/, '');
      } catch (e) {
        return href.replace(/#.*$/, '').replace(/\/$/, '');
      }
    }

    function isHiddenLink(link) {
      if (!link) return false;
      if (customAssignmentHidden.has(link)) return true;
      const norm = normalizeLink(link);
      if (customAssignmentHidden.has(norm)) return true;
      return false;
    }

  // -------------------------------
  // Data extraction: extractAssignments
  // - Scans the page for known selectors to build a normalized list of
  //   assignment objects { title, link, timestamp, courseName, overdue }
  // - Uses per-assignment DOM traversal and scoped selectors to avoid
  //   index-based mismatches when multiple assignments share the same date.
  // -------------------------------
  function extractAssignments() {
    const assignments = [];
    // console.log('=== STARTING ASSIGNMENT EXTRACTION  ===');

    // Helper to find timestamp for a given assignment element
    function resolveDateTimestampForAssignment(assignmentEl) {
      // 1) If the assignment is inside a list-group, the date heading is usually the previous sibling of that list
      const listParent = assignmentEl.closest('.list-group.list-group-flush');
      if (listParent && listParent.previousElementSibling && listParent.previousElementSibling.hasAttribute('data-timestamp')) {
        const s = listParent.previousElementSibling.getAttribute('data-timestamp');
        const p = parseInt(s, 10);
        if (!isNaN(p)) return p;
      }

      // 2) Sometimes the date is on an ancestor (rare) - try closest
      const closestWithTs = assignmentEl.closest('[data-timestamp]');
      if (closestWithTs) {
        const s = closestWithTs.getAttribute('data-timestamp');
        const p = parseInt(s, 10);
        if (!isNaN(p)) return p;
      }

      // 3) As a last resort, search backward among previous siblings until a data-timestamp is found
      let node = assignmentEl.parentElement;
      while (node) {
        let prev = node.previousElementSibling;
        while (prev) {
          if (prev.hasAttribute && prev.hasAttribute('data-timestamp')) {
            const s = prev.getAttribute('data-timestamp');
            const p = parseInt(s, 10);
            if (!isNaN(p)) return p;
          }
          prev = prev.previousElementSibling;
        }
        node = node.parentElement;
      }

      return null;
    }

    // Broad list of assignment elements across page
    const allAssignmentEls = document.querySelectorAll('.timeline-event-list-item');
    const courseTitleCandidates = Array.from(document.querySelectorAll('small.mb-0')).map(el => el.textContent.trim());
    let fallbackCourseIndex = 0;

    allAssignmentEls.forEach(assignmentEl => {
      // Broaden link selection: try common assignment link patterns first
      const link = assignmentEl.querySelector('a[href*="/mod/assign"]') || assignmentEl.querySelector('a[href*="/mod/"]') || assignmentEl.querySelector('a[href*="mod"]') || assignmentEl.querySelector('a[href*="assign/view.php"]') || assignmentEl.querySelector('a');
      if (!link) {
        // console.log('No link found for assignment element, skipping', assignmentEl);
        return;
      }

      const title = link.textContent.trim();
      const ariaLabel = link.getAttribute('aria-label');
      // console.log('Link aria-label:', ariaLabel);
      // console.log('Link text:', title);

      if (!title || title.length < 2 || title.includes('התחלת ניסיון מענה') || title.includes('הוספת הגשה')) {
        // console.log('Skipping non-assignment or short title:', title);
        return;
      }

      // Resolve date timestamp for this specific assignment
      const dateTimestamp = resolveDateTimestampForAssignment(assignmentEl);
      if (!dateTimestamp) {
        // console.log('Could not resolve date timestamp for assignment:', title, assignmentEl);
        return;
      }

      // Extract time (HH:MM) scoped to this assignment element
      const timeSmall = assignmentEl.querySelector('small.text-end.text-nowrap.align-self-center.ms-1') || assignmentEl.querySelector('small.text-end') || assignmentEl.querySelector('small');
      let dueSeconds = 0;
      if (timeSmall) {
        const timeStr = timeSmall.textContent.trim();
        const hm = timeStr.match(/(\d{1,2}):(\d{2})/);
        if (hm) {
          const hours = parseInt(hm[1], 10);
          const minutes = parseInt(hm[2], 10);
          dueSeconds = (hours * 60 + minutes) * 60;
        } 
      }

      const timestamp = dateTimestamp + dueSeconds;
      if (isNaN(timestamp) || timestamp <= 0) {
        // console.log('Invalid computed timestamp for', title, 'dateTimestamp=', dateTimestamp, 'dueSeconds=', dueSeconds);
        return;
      }

      const timestampDate = new Date(timestamp * 1000);
      const nowSeconds = Math.floor(Date.now() / 1000);
      const isOverdue = timestamp <= nowSeconds;

      // Try to find course name inside this assignment element; fallback to candidates list
      let courseName = null;
      const courseEl = assignmentEl.querySelector('small.mb-0');
      if (courseEl) {
        const txt = courseEl.textContent.trim();
        courseName = txt.includes('·') ? txt.split('·')[1].trim() : txt;
      } else if (fallbackCourseIndex < courseTitleCandidates.length) {
        const candidate = courseTitleCandidates[fallbackCourseIndex++];
        courseName = candidate && candidate.includes('·') ? candidate.split('·')[1].trim() : candidate;
      }

      // Avoid duplicates by link + timestamp
      const existing = assignments.some(a => a.link === link.href && a.timestamp === timestamp);
      if (existing) {
        // console.log('Duplicate found, skipping', title, link.href);
        return;
      }

      assignments.push({
        title,
        courseName,
        timestamp,
        timestampDate,
        link: link.href,
        element: assignmentEl,
        overdue: isOverdue
      });
    });

    // console.log('=== EXTRACTION COMPLETE ===');
    // console.log(`Total assignments extracted: ${assignments.length}`);

    // Deduplicate strictly by link (keep first)
    const uniqueAssignments = [];
    const seenLinks = new Set();
    assignments.forEach(a => {
      if (!seenLinks.has(a.link)) {
        seenLinks.add(a.link);
        uniqueAssignments.push(a);
      }
    });

    if (persistentViewerEnabled) {
      // console.log('Persistent viewer enabled. Current page assignments:', uniqueAssignments.length, 'Cached:', cachedAssignments.length);
      if (uniqueAssignments.length > 0) {
        const currentLinks = new Set(uniqueAssignments.map(a => a.link));
        const newCached = uniqueAssignments.concat(cachedAssignments.filter(a => !currentLinks.has(a.link)));
        cachedAssignments = newCached;
        try {
          localStorage.setItem('moodleTaskViewerCache', JSON.stringify(newCached));
          // console.log('Saved', newCached.length, 'assignments to localStorage');
        } catch (e) {
          // console.warn('Failed to save to localStorage:', e);
        }
        return newCached;
      } else if (cachedAssignments.length > 0) {
        // console.log('Using cached assignments:', cachedAssignments.length);
        return cachedAssignments;
      }
    }

    return uniqueAssignments;
  }

  // -------------------------------
  // Initialization
  // - Entry point for the content script
  // - Loads stored settings, cached assignments
  // - Creates the floating viewer and sets up periodic updates
  // -------------------------------
  function init() {
    // console.log('Moodle Task Viewer: Initializing...');
    // console.log('Persistent viewer enabled at init:', persistentViewerEnabled);
    // Try expanding activities several times to handle slow-loading pages
    expandAllActivities(8, 1200);
    setTimeout(() => {
      originalAssignmentBox = findAssignmentBox();
      if (originalAssignmentBox) {/* console.log('Found assignment box:', originalAssignmentBox); */}
      chrome.storage.sync.get(['viewerPosition', 'filterMode', 'customColors', 'links', 'customAssignmentOrder', 'customAssignmentHidden', 'autoHideOnSubmission', 'persistentViewerEnabled', 'cachedAssignments'], (result) => {
        if (result.viewerPosition) viewerPosition = result.viewerPosition;
        if (result.filterMode) currentFilter = result.filterMode;
        if (result.customColors) customColors = result.customColors;
        if (result.customAssignmentOrder) customAssignmentOrder = result.customAssignmentOrder.map(l => normalizeLink(l));
        if (result.customAssignmentHidden) customAssignmentHidden = new Set(result.customAssignmentHidden.map(l => normalizeLink(l)));
        if (result.autoHideOnSubmission !== undefined) autoHideOnSubmission = result.autoHideOnSubmission;
        if (result.persistentViewerEnabled !== undefined) persistentViewerEnabled = result.persistentViewerEnabled;
        if (result.cachedAssignments) cachedAssignments = result.cachedAssignments;
        if (persistentViewerEnabled) {
          try {
            const stored = localStorage.getItem('moodleTaskViewerCache');
            if (stored) { cachedAssignments = JSON.parse(stored); /* console.log('Loaded cached assignments from localStorage:', cachedAssignments.length); */ }
          } catch (e) { dwarn('Failed to load from localStorage:', e); }
        }
        // Ensure viewer is created; keep trying until successful.
        ensureViewerLoaded();
        setupScrollListener();
        loadSettings();
        updateInterval = setInterval(() => { const viewer = document.getElementById('moodle-task-viewer'); if (viewer) updateTimes(viewer); }, 60000);
      });
    }, 1000);
    setTimeout(() => { updateViewer(); }, 2500);
  }

  // -------------------------------
  // Filtering
  // filterAssignments:
  // - Apply the selected filter mode ('all','upcoming','7days','30days','custom')
  // - For 'custom' uses `customAssignmentOrder` and `customAssignmentHidden` to
  //   determine the user-defined list and visibility.
  // -------------------------------
  function filterAssignments(assignments) {
    const now = Math.floor(Date.now() / 1000);
    const sevenDays = 7 * 86400;
    const thirtyDays = 30 * 86400;

    // console.log(`Filtering with mode: ${currentFilter}, total assignments: ${assignments.length}`);
    // console.log('Assignment overdue statuses:', assignments.map(a => ({ title: a.title, overdue: a.overdue })));

    let filtered;
    switch (currentFilter) {
      case 'upcoming':
        // Filter out overdue assignments - only show future ones
        filtered = assignments.filter(a => {
          const isFuture = a.timestamp > now;
          // console.log(`${a.title}: overdue=${a.overdue}, timestamp=${a.timestamp}, now=${now}, isFuture=${isFuture}`);
          return isFuture && !a.overdue;
        });
        break;
      
      case '7days':
        filtered = assignments.filter(a => {
          const daysUntil = (a.timestamp - now) / 86400;
          return !a.overdue && daysUntil >= 0 && daysUntil <= 7;
        });
        break;
      
      case '30days':
        filtered = assignments.filter(a => {
          const daysUntil = (a.timestamp - now) / 86400;
          return !a.overdue && daysUntil >= 0 && daysUntil <= 30;
        });
        break;

      case 'custom': {
        // Use custom order but normalize links so stored order still matches current assignment links
        const byNorm = new Map(assignments.map(a => [normalizeLink(a.link), a]));

        const ordered = [];
        const seen = new Set();
        customAssignmentOrder.forEach(savedLink => {
          const norm = normalizeLink(savedLink);
          if (byNorm.has(norm)) {
            const a = byNorm.get(norm);
            ordered.push(a);

            seen.add(normalizeLink(a.link));
          }
        });

        // Append any assignments not present in saved order so user sees everything
        const remaining = assignments.filter(a => !seen.has(normalizeLink(a.link)));
        const combined = ordered.concat(remaining);

        // Filter by hidden state (check both raw and normalized links in hidden set)
        filtered = combined.filter(a => {
          const rawHidden = customAssignmentHidden.has(a.link);
          const normHidden = customAssignmentHidden.has(normalizeLink(a.link));
          const isHidden = rawHidden || normHidden;
          return a && (showHiddenOnly ? isHidden : !isHidden);
        });
        break;
      }
      
      case 'all':
      default:
        filtered = assignments;
    }

    // console.log(`After filtering: ${filtered.length} assignments`);
    return filtered;
  }

  // -------------------------------
  // Time helpers
  // getTimeRemaining:
  // - Computes days/hours/minutes until (or since) a UNIX timestamp
  // - Returns an object { days, hours, minutes, overdue }
  // -------------------------------
  function getTimeRemaining(timestamp) {
    // CRITICAL: Get ACTUAL current time
    const now = Math.floor(Date.now() / 1000);
    const diff = timestamp - now;

    // Create date objects for display
    const assignmentDate = new Date(timestamp * 1000);
    const nowDate = new Date(now * 1000);
    
    // console.log('=== TIME CALCULATION DEBUG ===');
    // console.log('Assignment timestamp:', timestamp);
    // console.log('Current timestamp:', now);
    // console.log('Difference (seconds):', diff);
    // console.log('Difference (days):', (diff / 86400).toFixed(2));
    // console.log('Assignment date ISO:', assignmentDate.toISOString());
    // console.log('Current date ISO:', nowDate.toISOString());
    // console.log('Is overdue?:', diff <= 0);
    // console.log('==============================');

    if (diff <= 0) {
      // Assignment is overdue
      const absDiff = Math.abs(diff);
      const days = Math.floor(absDiff / 86400);
      const hours = Math.floor((absDiff % 86400) / 3600);
      const minutes = Math.floor((absDiff % 3600) / 60);
      
      // console.log('Overdue time:', { days, hours, minutes });
      return { days, hours, minutes, overdue: true };
    }

    // Assignment is upcoming - calculate remaining time
    const totalSeconds = diff;
    const days = Math.floor(totalSeconds / 86400);
    const remainingAfterDays = totalSeconds % 86400;
    const hours = Math.floor(remainingAfterDays / 3600);
    const remainingAfterHours = remainingAfterDays % 3600;
    const minutes = Math.floor(remainingAfterHours / 60);

    // console.log('Remaining time:', { days, hours, minutes });

    return { days, hours, minutes, overdue: false };
  }

  // -------------------------------
  // Presentation helpers
  // formatTimeRemaining:
  // - Returns an HTML snippet to display remaining or overdue time with simple
  //   styling. Kept minimal so it can be themed easily.
  // -------------------------------
  function formatTimeRemaining(time) {
    if (time.overdue) {
      return `<span style="color: #d32f2f; font-weight: 600;">עבר לפני ${time.days}d : ${time.hours}h : ${time.minutes}m</span>`;
    }
    
    // Pad with leading zeros for cleaner display
    const d = String(time.days).padStart(2, '0');
    const h = String(time.hours).padStart(2, '0');
    const m = String(time.minutes).padStart(2, '0');
    
    return `<span style="color: #2e7d32; font-weight: 500;">נותרו: ${d}d : ${h}h : ${m}m</span>`;
  }

  // -------------------------------
  // UI: Viewer construction
  // createFloatingTaskViewer:
  // - Builds the DOM for the floating viewer, header, filters, content and
  //   footer. Calls `extractAssignments()` and `filterAssignments()` to populate
  //   the list and wires up initial event handlers.
  // -------------------------------
  function createFloatingTaskViewer() {
    // avoid creating duplicate viewer
    const existingViewer = document.getElementById('moodle-task-viewer');
    if (existingViewer) return existingViewer;

    const viewer = document.createElement('div');
    viewer.id = 'moodle-task-viewer';
    viewer.className = 'moodle-floating-viewer';
    viewer.style.left = viewerPosition.x + 'px';
    viewer.style.top = viewerPosition.y + 'px';

    const allAssignments = extractAssignments();
    const filteredAssignments = filterAssignments(allAssignments);

    // Hide viewer if persistent mode is off and there are no assignments
    if (!persistentViewerEnabled && allAssignments.length === 0) {
      const existing = document.getElementById('moodle-task-viewer');
      if (existing) existing.remove();
      return;
    }

    viewer.innerHTML = `
      <div class="viewer-header">
        <div class="viewer-title">
          <span class="drag-handle">⋮⋮</span>
          <h3>📚 מטלות</h3>
        </div>
        <div class="viewer-actions">
          <a href="${STATIC_PROFILES.linkedin}" class="profile-link" target="_blank" title="LinkedIn">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4.98 3.5C4.98 4.88 3.87 6 2.5 6S0 4.88 0 3.5 1.12 1 2.5 1 4.98 2.12 4.98 3.5zM0 8.98h5V24H0zM8.5 8.98h4.78v2.06h.07c.67-1.27 2.31-2.6 4.76-2.6C23.5 8.44 24 11 24 14.78V24h-5v-8.9c0-2.12-.04-4.86-3-4.86-3 0-3.46 2.34-3.46 4.74V24H8.5V8.98z"></path></svg>
          </a>
          <a href="${STATIC_PROFILES.github}" class="profile-link" target="_blank" title="GitHub">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.7-3.88-1.54-3.88-1.54-.53-1.36-1.3-1.72-1.3-1.72-1.06-.73.08-.72.08-.72 1.17.08 1.78 1.2 1.78 1.2 1.04 1.77 2.72 1.26 3.39.96.11-.75.41-1.26.74-1.55-2.55-.29-5.23-1.28-5.23-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.47.11-3.07 0 0 .97-.31 3.18 1.18a11.1 11.1 0 012.9-.39c.98.01 1.97.13 2.9.39 2.2-1.5 3.17-1.18 3.17-1.18.64 1.6.24 2.78.12 3.07.74.81 1.19 1.84 1.19 3.1 0 4.43-2.69 5.41-5.25 5.69.42.36.8 1.07.8 2.15 0 1.55-.01 2.8-.01 3.18 0 .31.21.68.8.56A11.51 11.51 0 0023.5 12C23.5 5.65 18.35.5 12 .5z"></path></svg>
          </a>
          <button class="viewer-settings" id="viewer-settings-btn" title="הגדרות">⚙️</button>
          <button class="viewer-toggle" id="viewer-toggle-btn" title="הסתר/הצג">−</button>
        </div>
      </div>
      <div class="viewer-body" id="viewer-body">
        <div class="viewer-filters">
          <button class="filter-btn ${currentFilter === 'all' ? 'active' : ''}" data-filter="all">
            הכל (${allAssignments.length})
          </button>
          <button class="filter-btn ${currentFilter === 'upcoming' ? 'active' : ''}" data-filter="upcoming">
            להגשה (${allAssignments.filter(a => !a.overdue).length})
          </button>
          <button class="filter-btn ${currentFilter === '7days' ? 'active' : ''}" data-filter="7days">
            7 ימים
          </button>
          <button class="filter-btn ${currentFilter === 'custom' ? 'active' : ''}" data-filter="custom">
            מותאם אישית
          </button>
        </div>
        <div class="viewer-content" id="viewer-content">
          ${filteredAssignments.length > 0 ? renderAssignments(filteredAssignments) : '<p class="no-assignments">אין מטלות מתאימות</p>'}
        </div>
        </div>
      </div>
      <div class="viewer-footer">
        <small>גרור להזזה • מתעדכן כל דקה</small>
      </div>
      <div class="viewer-resize-handle" id="viewer-resize-handle"></div>
      <div class="viewer-collapsed" id="viewer-collapsed" style="display: none;">
        <span class="collapsed-icon">📚</span>
      </div>
    `;

    document.body.appendChild(viewer);

    // Load saved sizes/colors
    chrome.storage.sync.get(['viewerSize', 'customColors'], (res) => {
      // If a saved current size exists, apply it
      if (res.viewerSize && res.viewerSize.width) {
        viewer.style.width = res.viewerSize.width;
        viewer.style.height = res.viewerSize.height;
      }

      // Colors
      if (res.customColors) {
        customColors = res.customColors;
        applyColorsToViewer();
      }

      // Ensure content sizing updated
      setTimeout(() => {
        const headerEl = viewer.querySelector('.viewer-header');
        const filtersEl = viewer.querySelector('.viewer-filters');
        const footerEl = viewer.querySelector('.viewer-footer');
        const content = viewer.querySelector('#viewer-content');
        if (content) {
          const headerH = headerEl ? headerEl.offsetHeight : 0;
          const filtersH = filtersEl ? filtersEl.offsetHeight : 0;
          const footerH = footerEl ? footerEl.offsetHeight : 0;
          const viewerH = viewer.offsetHeight || parseInt(window.getComputedStyle(viewer).height) || 400;
          const available = Math.max(60, viewerH - headerH - filtersH - footerH - 24);
          content.style.maxHeight = available + 'px';
          content.style.overflowY = 'auto';
        }
      }, 60);
    });

    // Ensure the resize handle exists
    const resizeHandle = viewer.querySelector('#viewer-resize-handle');
    let resizing = false;
    let startX, startY, startWidth, startHeight;

    // Helper to update content max-height based on viewer size
    function updateContentMaxHeight() {
      const content = viewer.querySelector('#viewer-content');
      const headerEl = viewer.querySelector('.viewer-header');
      const filtersEl = viewer.querySelector('.viewer-filters');
      const footerEl = viewer.querySelector('.viewer-footer');
      if (!content) return;
      const headerH = headerEl ? headerEl.offsetHeight : 0;
      const filtersH = filtersEl ? filtersEl.offsetHeight : 0;
      const footerH = footerEl ? footerEl.offsetHeight : 0;
      const viewerComputed = window.getComputedStyle(viewer);
      const viewerH = viewer.offsetHeight || parseInt(viewerComputed.height) || 400;
      // subtract viewer padding & borders so content extends correctly to footer
      const paddingTop = parseFloat(viewerComputed.paddingTop) || 0;
      const paddingBottom = parseFloat(viewerComputed.paddingBottom) || 0;
      const borderTop = parseFloat(viewerComputed.borderTopWidth) || 0;
      const borderBottom = parseFloat(viewerComputed.borderBottomWidth) || 0;
      const extra = paddingTop + paddingBottom + borderTop + borderBottom + 8; // small safety
      const available = Math.max(60, viewerH - headerH - filtersH - footerH - extra);
      content.style.maxHeight = available + 'px';
      content.style.overflowY = 'auto';
    }

    // initialize content height immediately
    setTimeout(updateContentMaxHeight, 50);

    if (resizeHandle) {
      resizeHandle.addEventListener('mousedown', function(e) {
        e.preventDefault();
        e.stopPropagation();
        resizing = true;
        startX = e.clientX;
        startY = e.clientY;
        startWidth = viewer.offsetWidth;
        startHeight = viewer.offsetHeight;
        document.body.style.userSelect = 'none';
      });

      window.addEventListener('mousemove', function(e) {
        if (!resizing) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        // Keep min width equal to default 380
        let newWidth = Math.max(385, startWidth + dx);
        let newHeight = Math.max(220, startHeight + dy);
        viewer.style.width = newWidth + 'px';
        viewer.style.height = newHeight + 'px';
        updateContentMaxHeight();
      });

      window.addEventListener('mouseup', function(e) {
        if (resizing) {
            resizing = false;
            document.body.style.userSelect = '';
            // Save current size so it's persisted across pages/loads
            try {
              chrome.storage.sync.set({ viewerSize: { width: viewer.style.width, height: viewer.style.height } });
            } catch (e) {
              // ignore storage errors
            }
          }
      });
    }

    const header = viewer.querySelector('.viewer-header');
    header.addEventListener('mousedown', startDragging);
    
    document.getElementById('viewer-toggle-btn').addEventListener('click', toggleViewerBody);
    document.getElementById('viewer-settings-btn').addEventListener('click', toggleSettings);
    
    const collapsed = document.getElementById('viewer-collapsed');
    
    collapsed.addEventListener('mousedown', (e) => {
      hasDragged = false;
      dragStartPos.x = e.clientX;
      dragStartPos.y = e.clientY;
      startDragging(e);
    });
    
    collapsed.addEventListener('click', (e) => {
      // Only toggle if it wasn't a drag
      if (!hasDragged) {
        e.stopPropagation();
        toggleViewerBody();
      }
    });

    // Filter buttons
    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        currentFilter = e.target.getAttribute('data-filter');
        chrome.storage.sync.set({ filterMode: currentFilter });
        updateViewer();
      });
    });

    // Apply custom colors on load
    applyColorsToViewer();
    
    console.log('Task viewer created successfully');
  }

  // Toggle viewer body (collapse to square / expand)
  function toggleViewerBody() {
    const body = document.getElementById('viewer-body');
    const header = document.querySelector('.viewer-header');
    const collapsed = document.getElementById('viewer-collapsed');
    const btn = document.getElementById('viewer-toggle-btn');
    const viewer = document.getElementById('moodle-task-viewer');
    
    isCollapsed = !isCollapsed;
    
    if (isCollapsed) {
      // Collapse to small square
      body.style.display = 'none';
      header.style.display = 'none';
      collapsed.style.display = 'flex';
      viewer.classList.add('viewer-collapsed-state');
      viewer.style.width = '60px';
      viewer.style.height = '60px';
      viewer.style.minWidth = '60px';
      viewer.style.minHeight = '60px';
      viewer.style.maxWidth = '60px';
      viewer.style.maxHeight = '60px';
    } else {
      // Expand to full view
      body.style.display = 'block';
      header.style.display = 'flex';
      collapsed.style.display = 'none';
      viewer.classList.remove('viewer-collapsed-state');
      viewer.style.width = '380px';
      viewer.style.height = 'auto';
      viewer.style.minWidth = '380px';
      viewer.style.minHeight = 'auto';
      viewer.style.maxWidth = '380px';
      viewer.style.maxHeight = '600px';
    }
  }

  // Update viewer content
  function updateViewer() {
    const viewer = document.getElementById('moodle-task-viewer');
    if (!viewer) return;

    const allAssignments = extractAssignments();

    // Hide viewer if persistent mode is off and there are no assignments
    if (!persistentViewerEnabled && allAssignments.length === 0) {
      viewer.remove();
      return;
    }

    // Initialize custom order on first load
    if (customAssignmentOrder.length === 0 && allAssignments.length > 0) {
      customAssignmentOrder = allAssignments.map(a => normalizeLink(a.link));
      chrome.storage.sync.set({ customAssignmentOrder });
    }

    const filteredAssignments = filterAssignments(allAssignments);

    // Update filter counts
    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.classList.remove('active');
      const filter = btn.getAttribute('data-filter');

      if (filter === currentFilter) {
        btn.classList.add('active');
      }

      // Update counts
      let count = 0;
      const now = Math.floor(Date.now() / 1000);

      switch(filter) {
        case 'all':
          count = allAssignments.length;
          break;
        case 'upcoming':
          count = allAssignments.filter(a => !a.overdue).length;
          break;
        case '7days':
          count = allAssignments.filter(a => {
            const daysUntil = (a.timestamp - now) / 86400;
            return !a.overdue && daysUntil >= 0 && daysUntil <= 7;
          }).length;
          break;
        case 'custom':
          count = allAssignments.filter(a => !isHiddenLink(a.link)).length;
          break;
      }

      const btnText = btn.textContent.split('(')[0];
      btn.innerHTML = `${btnText}(${count})`;
    });

    // Update content
    const content = viewer.querySelector('#viewer-content');
    let contentHTML = '';

    if (currentFilter === 'custom') {
      const hiddenCount = customAssignmentHidden.size;
      const visibleCount = allAssignments.filter(a => !isHiddenLink(a.link)).length;
      // Show toggle and controls
      const toggleLabel = showHiddenOnly ? `הצג נראים (${visibleCount})` : `הצג מוסתרים (${hiddenCount})`;
      // modern toggle with icon + pill style
      contentHTML = `
        <div class="custom-controls">
          <button class="custom-toggle-btn" id="toggle-hidden-btn" aria-pressed="${showHiddenOnly}" title="${toggleLabel}">
            <span class="btn-icon">${showHiddenOnly ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5c-7 0-10 6-10 7s3 7 10 7 10-6 10-7-3-7-10-7zm0 12a5 5 0 110-10 5 5 0 010 10z"/></svg>' : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4.5C7 4.5 3.2 7.6 1.5 12c1.7 4.4 5.5 7.5 10.5 7.5s8.8-3.1 10.5-7.5C20.8 7.6 17 4.5 12 4.5zM12 17a5 5 0 100-10 5 5 0 000 10z"/></svg>'}</span>
            <span class="btn-text">${toggleLabel}</span>
          </button>
          ${showHiddenOnly ? (hiddenCount > 0 ? `<button class="custom-restore-btn" id="restore-all-btn" title="שחזר הכל (${hiddenCount})"><span class="btn-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5V1L7 6l5 5V7c3.9 0 7 3.1 7 7 0 1.1-.3 2.1-.8 3l1.6 1.6C21.6 17.6 22 15.9 22 14c0-5-4-9-10-9z"/></svg></span><span class="btn-text">שחזר הכל (${hiddenCount})</span></button>` : '') : ''}
        </div>
      `;

      if (showHiddenOnly) {
        // Show only hidden assignments
        const hiddenAssignments = filterAssignments(allAssignments); // with showHiddenOnly true, filterAssignments returns hidden ones
        contentHTML += hiddenAssignments.length > 0 ? `<div class="hidden-view">${renderAssignments(hiddenAssignments, true, true)}</div>` : '<p class="no-assignments">אין מטלות מוסתרות</p>';
      } else {
        // Show visible assignments with drag/drop
        const visibleAssignments = filterAssignments(allAssignments);
        contentHTML += visibleAssignments.length > 0 ? renderAssignments(visibleAssignments, true, false) : '<p class="no-assignments">אין מטלות</p>';
      }
    } else {
      contentHTML = filteredAssignments.length > 0 ? 
        renderAssignments(filteredAssignments, false) : 
        '<p class="no-assignments">אין מטלות מתאימות</p>';
    }
    
    content.innerHTML = contentHTML;

    // Attach event listeners for custom tab controls
    if (currentFilter === 'custom') {
      // counts
      const hiddenCount = customAssignmentHidden.size;
      const visibleCount = allAssignments.filter(a => !isHiddenLink(a.link)).length;

      // Toggle button text
      const toggleBtn = document.getElementById('toggle-hidden-btn');
      if (toggleBtn) {
        toggleBtn.onclick = (e) => {
          e.preventDefault();
          showHiddenOnly = !showHiddenOnly;
          updateViewer();
        };
      }

      if (showHiddenOnly) {
        // Attach restore-all handler
        const restoreBtn = document.getElementById('restore-all-btn');
        if (restoreBtn) {
          restoreBtn.onclick = restoreAllAssignments;
        }

        // Attach per-assignment restore handlers
        document.querySelectorAll('.assignment-restore-btn').forEach(btn => {
          btn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const link = btn.getAttribute('data-link');
            const norm = normalizeLink(link);
            if (customAssignmentHidden.has(link) || customAssignmentHidden.has(norm)) {
              customAssignmentHidden.delete(link);
              customAssignmentHidden.delete(norm);
              chrome.storage.sync.set({ customAssignmentHidden: Array.from(customAssignmentHidden) });
              updateViewer();
            }
          };
        });
      } else {
        // Setup drag/drop and hide handlers for visible custom list
        setupCustomDragDrop(filteredAssignments);
      }
    }
    // Re-apply theme/colors to newly created controls (icons, buttons)
    try { applyColorsToViewer(); } catch (e) { /* ignore */ }
  }

  // Render assignments HTML
  function renderAssignments(assignments, isCustomMode = false, isHiddenView = false) {
    return assignments.map((assignment, index) => {
      const time = getTimeRemaining(assignment.timestamp);
      const timeStr = formatTimeRemaining(time);
      
      const hideBtn = isCustomMode && !isHiddenView ? `<button class="assignment-hide-btn" data-link="${assignment.link}" title="הסתר">✕</button>` : '';
      const restoreBtn = isCustomMode && isHiddenView ? `<button class="assignment-restore-btn" data-link="${assignment.link}" title="שחזר" aria-label="שחזר מטלה"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5V1L7 6l5 5V7c3.9 0 7 3.1 7 7 0 1.1-.3 2.1-.8 3l1.6 1.6C21.6 17.6 22 15.9 22 14c0-5-4-9-10-9z"/></svg></button>` : '';
      
      return `
        <div class="assignment-item ${assignment.overdue ? 'overdue' : ''} ${isCustomMode && !isHiddenView ? 'custom-draggable' : ''}" data-index="${index}" data-link="${assignment.link}" ${isCustomMode && !isHiddenView ? 'draggable="true"' : ''}>
          <a href="${assignment.link}" class="assignment-link" target="_blank">
            <div class="assignment-header">
              <span class="assignment-icon">${assignment.overdue ? '⚠️' : '📝'}</span>
              <div class="assignment-info">
                <div class="assignment-title">${assignment.title}</div>
                ${assignment.courseName ? `<div class="assignment-course">${assignment.courseName}</div>` : ''}
              </div>
            </div>
            <div class="assignment-time">
              <span class="time-icon">⏱</span>
              <span>${timeStr}</span>
            </div>
          </a>
          ${hideBtn}
          ${restoreBtn}
        </div>
      `;
    }).join('');
  }

  // Update time displays
  function updateTimes(viewer) {
    updateViewer();
  }

  // Drag functionality
  function startDragging(e) {
    if (e.target.classList.contains('viewer-toggle') || 
        e.target.closest('.viewer-toggle') ||
        e.target.classList.contains('viewer-settings') ||
        e.target.closest('.viewer-settings') ||
        e.target.classList.contains('filter-btn')) {
      return;
    }

    isDragging = true;
    const viewer = document.getElementById('moodle-task-viewer');
    const rect = viewer.getBoundingClientRect();
    
    dragOffset.x = e.clientX - rect.left;
    dragOffset.y = e.clientY - rect.top;

    document.addEventListener('mousemove', drag);
    document.addEventListener('mouseup', stopDragging);
    
    viewer.style.cursor = 'grabbing';
    e.preventDefault();
  }
  

  function drag(e) {
    if (!isDragging) return;

    // Check if mouse has moved significantly (more than 5px)
    const deltaX = Math.abs(e.clientX - dragStartPos.x);
    const deltaY = Math.abs(e.clientY - dragStartPos.y);
    if (deltaX > 5 || deltaY > 5) {
      hasDragged = true;
    }

    const viewer = document.getElementById('moodle-task-viewer');
    const newX = e.clientX - dragOffset.x;
    const newY = e.clientY - dragOffset.y;

    const maxX = window.innerWidth - viewer.offsetWidth;
    const maxY = window.innerHeight - viewer.offsetHeight;

    viewerPosition.x = Math.max(0, Math.min(newX, maxX));
    viewerPosition.y = Math.max(0, Math.min(newY, maxY));

    viewer.style.left = viewerPosition.x + 'px';
    viewer.style.top = viewerPosition.y + 'px';
  }

  function stopDragging() {
    isDragging = false;
    document.removeEventListener('mousemove', drag);
    document.removeEventListener('mouseup', stopDragging);

    const viewer = document.getElementById('moodle-task-viewer');
    if (viewer) {
      viewer.style.cursor = 'move';
      chrome.storage.sync.set({ viewerPosition });
    }
    
    // Reset drag flag after a short delay to allow click event to check it
    setTimeout(() => {
      hasDragged = false;
    }, 100);
  }

  function toggleViewer() {
    taskViewerVisible = !taskViewerVisible;
    const viewer = document.getElementById('moodle-task-viewer');
    if (viewer) {
      viewer.style.display = taskViewerVisible ? 'block' : 'none';
    }
  }

  // -------------------------------
  // Visibility helpers
  // setupScrollListener:
  // - Listens to page scroll and hides the viewer when the original
  //   assignment area is in view (if `autoHideOnSubmission` is enabled).
  // -------------------------------
  function setupScrollListener() {
    if (!originalAssignmentBox) return;

    window.addEventListener('scroll', () => {
      const viewer = document.getElementById('moodle-task-viewer');
      if (!viewer || !taskViewerVisible) return;

      const boxRect = originalAssignmentBox.getBoundingClientRect();
      const viewportHeight = window.innerHeight;

      // Check the setting dynamically each time
      if (autoHideOnSubmission && boxRect.top <= viewportHeight && boxRect.bottom >= 0) {
        viewer.style.opacity = '0';
        viewer.style.pointerEvents = 'none';
      } else {
        viewer.style.opacity = '1';
        viewer.style.pointerEvents = 'auto';
      }
    });
  }

  // -------------------------------
  // Settings panel: show/hide and controls
  // toggleSettings:
  // - Manages the visibility of the settings modal. Ensures the panel
  //   DOM exists and loads current settings when opened.
  // -------------------------------
  function toggleSettings() {
    settingsVisible = !settingsVisible;
    let settingsPanel = document.getElementById('settings-panel');
    
    if (!settingsPanel) {
      createSettingsPanel();
      settingsPanel = document.getElementById('settings-panel');
    }
    
    if (settingsVisible) {
      settingsPanel.style.display = 'block';
      loadSettingsIntoPanel();
    } else {
      settingsPanel.style.display = 'none';
    }
  }

  // -------------------------------
  // Settings panel builder
  // createSettingsPanel:
  // - Builds the settings modal HTML and wires its internal event handlers
  //   (color inputs, save/reset, links management, option checkboxes).
  // -------------------------------
  function createSettingsPanel() {
    const panel = document.createElement('div');
    panel.id = 'settings-panel';
    panel.className = 'settings-panel';
    panel.innerHTML = `
      <div class="settings-header">
        <h3>⚙️ הגדרות</h3>
        <button class="settings-close" id="settings-close-btn">×</button>
      </div>
      <div class="settings-content">
        <div class="settings-section">
          <h4>צבעים</h4>
          <div class="color-control">
            <label>צבע ראשי:</label>
            <input type="color" id="color-primary" value="${customColors.primary}">
            <input type="text" id="color-primary-text" value="${customColors.primary}" maxlength="7">
          </div>
          <div class="color-control">
            <label>צבע משני:</label>
            <input type="color" id="color-secondary" value="${customColors.secondary}">
            <input type="text" id="color-secondary-text" value="${customColors.secondary}" maxlength="7">
          </div>
          <div class="color-control">
            <label>צבע שלישי:</label>
            <input type="color" id="color-tertiary" value="${customColors.tertiary}">
            <input type="text" id="color-tertiary-text" value="${customColors.tertiary}" maxlength="7">
          </div>
          <button class="settings-btn" id="save-all-btn">שמור הגדרות</button>
          <button class="settings-btn settings-btn-secondary" id="reset-colors-btn">שחזר ברירת מחדל</button>
        </div>
        
        <div class="settings-section">
          <h4>פרטי יוצר</h4>
          <div class="input-control">
            <label>LinkedIn:</label>
            <a href="${STATIC_PROFILES.linkedin}" id="fixed-link-linkedin" target="_blank">${STATIC_PROFILES.linkedin}</a>
          </div>
          <div class="input-control">
            <label>אימייל:</label>
            <a href="mailto:asafamrani4@gmail.com" class="contact-email">asafamrani4@gmail.com</a>
          </div>
        </div>
        
        <div class="settings-section">
          <h4>קישורים מהירים</h4>
          <div id="links-container"></div>
          <button class="settings-btn" id="add-link-btn">הוסף קישור</button>
        </div>

        <div class="settings-section">
          <h4>אפשרויות</h4>
          <div class="checkbox-control">
            <label>
              <input type="checkbox" id="auto-hide-checkbox" ${autoHideOnSubmission ? 'checked' : ''}>
              הסתר אוטומטי כאשר מתקרבים לאזור ההגשה
            </label>
          </div>
          <div class="checkbox-control">
            <label>
              <input type="checkbox" id="persistent-viewer-checkbox" ${persistentViewerEnabled ? 'checked' : ''}>
              הצג את התוסף בכל דפי Moodle
            </label>
          </div>
        </div>
      </div>
    `;
    
    document.body.appendChild(panel);

    // Ensure the freshly-created panel immediately receives theme variables
    // and inline contrast adjustments (in case applyColorsToViewer ran earlier
    // or the panel is created before it runs). This guarantees consistent
    // appearance when the panel is opened.
    try { applyColorsToViewer(); } catch (e) { /* ignore */ }

    // Event listeners
    document.getElementById('settings-close-btn').addEventListener('click', toggleSettings);
    
    // Color inputs
    ['primary', 'secondary', 'tertiary'].forEach(colorType => {
      const colorInput = document.getElementById(`color-${colorType}`);
      const textInput = document.getElementById(`color-${colorType}-text`);
      
      colorInput.addEventListener('input', (e) => {
        textInput.value = e.target.value;
      });
      
      textInput.addEventListener('input', (e) => {
        if (/^#[0-9A-F]{6}$/i.test(e.target.value)) {
          colorInput.value = e.target.value;
        }
      });
    });
    
    // Buttons
    document.getElementById('reset-colors-btn').addEventListener('click', resetColors);
    document.getElementById('add-link-btn').addEventListener('click', addLink);
    // Unified save all button
    const saveAllBtn = document.getElementById('save-all-btn');
    if (saveAllBtn) {
      saveAllBtn.addEventListener('click', () => {
        // collect color inputs and option checkboxes
        const colors = {
          primary: document.getElementById('color-primary').value,
          secondary: document.getElementById('color-secondary').value,
          tertiary: document.getElementById('color-tertiary').value
        };
        const autoHide = document.getElementById('auto-hide-checkbox').checked;
        const persistent = document.getElementById('persistent-viewer-checkbox').checked;

        // Preserve existing links if any
        chrome.storage.sync.get(['links'], (res) => {
          const links = res.links || [];
          chrome.storage.sync.set({ customColors: colors, autoHideOnSubmission: autoHide, persistentViewerEnabled: persistent, links }, () => {
            customColors = colors;
            autoHideOnSubmission = autoHide;
            persistentViewerEnabled = persistent;
            applyColorsToViewer();
            alert('הגדרות נשמרו בהצלחה!');
            updateViewer();
          });
        });
      });
    }
    
    // Close on outside click
    panel.addEventListener('click', (e) => {
      if (e.target === panel) {
        toggleSettings();
      }
    });

    // Factory reset handler (resets all settings to built-in defaults)
    const factoryBtn = document.getElementById('reset-colors-btn');
    if (factoryBtn) {
      factoryBtn.addEventListener('click', () => {
        // Reset to hard-coded defaults
        customColors = { ...DEFAULT_COLORS };
        autoHideOnSubmission = true;
        persistentViewerEnabled = false;
        chrome.storage.sync.set({ customColors, autoHideOnSubmission, persistentViewerEnabled, links, customAssignmentHidden: Array.from(customAssignmentHidden), customAssignmentOrder, cachedAssignments }, () => {
          // update UI inputs
          document.getElementById('color-primary').value = DEFAULT_COLORS.primary;
          document.getElementById('color-primary-text').value = DEFAULT_COLORS.primary;
          document.getElementById('color-secondary').value = DEFAULT_COLORS.secondary;
          document.getElementById('color-secondary-text').value = DEFAULT_COLORS.secondary;
          document.getElementById('color-tertiary').value = DEFAULT_COLORS.tertiary;
          document.getElementById('color-tertiary-text').value = DEFAULT_COLORS.tertiary;
          document.getElementById('auto-hide-checkbox').checked = autoHideOnSubmission;
          document.getElementById('persistent-viewer-checkbox').checked = persistentViewerEnabled;
          renderLinks([]);
          applyColorsToViewer();
          updateViewer();
          alert('הגדרות אופסו לברירת המחדל');
        });
      });
    }

    
  }

  // -------------------------------
  // Persistence helpers
  // saveOptions:
  // - Persists non-color options (auto-hide, persistent viewer) to storage
  //   and triggers an immediate UI update.
  // -------------------------------
  function saveOptions() {
    autoHideOnSubmission = document.getElementById('auto-hide-checkbox').checked;
    persistentViewerEnabled = document.getElementById('persistent-viewer-checkbox').checked;
    
    chrome.storage.sync.set({ 
      autoHideOnSubmission,
      persistentViewerEnabled
    }, () => {
      alert('אפשרויות נשמרו בהצלחה!');
      // Trigger scroll event to update viewer state immediately
      window.dispatchEvent(new Event('scroll'));
      // Update viewer if persistent mode changed
      updateViewer();
    });
  }

  // -------------------------------
  // loadSettings:
  // - Loads stored color settings and applies them to the viewer.
  // -------------------------------
  function loadSettings() {
    chrome.storage.sync.get(['customColors', 'links'], (result) => {
      if (result.customColors) {
        customColors = result.customColors;
        applyColorsToViewer();
      }
    });
  }

  // -------------------------------
  // loadSettingsIntoPanel:
  // - Populates the settings panel (links section, inputs) from storage
  //   when the panel is displayed.
  // -------------------------------
  function loadSettingsIntoPanel() {
    chrome.storage.sync.get(['links'], (result) => {
      if (result.links && result.links.length > 0) {
        renderLinks(result.links);
      } else {
        renderLinks([]);
      }
    });
  }

  // -------------------------------
  // applyColors:
  // - Handler for the settings panel 'apply' action that captures color
  //   values from the inputs and persists them, then re-applies theme.
  // -------------------------------
  function applyColors() {
    customColors = {
      primary: document.getElementById('color-primary').value,
      secondary: document.getElementById('color-secondary').value,
      tertiary: document.getElementById('color-tertiary').value
    };
    
    chrome.storage.sync.set({ customColors }, () => {
      applyColorsToViewer();
      alert('הצבעים עודכנו בהצלחה!');
    });
  }

  // -------------------------------
  // resetColors:
  // - UI helper invoked by the settings panel to reset color inputs to
  //   the default palette and re-apply the theme.
  // -------------------------------
  function resetColors() {
    customColors = { ...DEFAULT_COLORS };
    
    // Update input fields
    document.getElementById('color-primary').value = DEFAULT_COLORS.primary;
    document.getElementById('color-primary-text').value = DEFAULT_COLORS.primary;
    document.getElementById('color-secondary').value = DEFAULT_COLORS.secondary;
    document.getElementById('color-secondary-text').value = DEFAULT_COLORS.secondary;
    document.getElementById('color-tertiary').value = DEFAULT_COLORS.tertiary;
    document.getElementById('color-tertiary-text').value = DEFAULT_COLORS.tertiary;
    
    chrome.storage.sync.set({ customColors }, () => {
      applyColorsToViewer();
      alert('ההגדרות אופסו לברירת המחדל!');
    });
  }

  // -------------------------------
  // Theming engine
  // applyColorsToViewer:
  // - Centralizes all theme application for the viewer. It sets CSS
  //   variables on the viewer element and applies inline styles for parts
  //   that require runtime contrast calculations (icons, button fg colors).
  // -------------------------------
  function applyColorsToViewer() {
    const header = document.querySelector('.viewer-header');
    const viewer = document.getElementById('moodle-task-viewer');

    // Also set global CSS variables on :root so UI elements outside the
    // viewer (for example the settings panel which is appended to body)
    // can use the same theme when the viewer isn't present.
    try {
      const root = document.documentElement;
      root.style.setProperty('--primary', customColors.primary || '#f98012');
      root.style.setProperty('--secondary', customColors.secondary || '#ff6f00');
      root.style.setProperty('--tertiary', customColors.tertiary || '#2d9fd8');
      root.style.setProperty('--primary-contrast', getContrastColor(customColors.primary || '#f98012'));
      root.style.setProperty('--tertiary-contrast', getContrastColor(customColors.tertiary || '#2d9fd8'));
      root.style.setProperty('--filter-fg', getContrastColor(customColors.tertiary || '#f5f5f5'));
      root.style.setProperty('--scrollbar-thumb', customColors.primary || '#f98012');
    } catch (e) { /* ignore */ }

    if (viewer) {
      // expose scrollbar thumb color locally as well
      viewer.style.setProperty('--scrollbar-thumb', customColors.primary);
    }

    if (header) {
      // allow CSS to use --primary/--secondary/--tertiary variables for gradient
      header.style.background = `linear-gradient(135deg, var(--primary) 0%, var(--secondary) 50%, var(--tertiary) 100%)`;
    }
    
    const collapsed = document.getElementById('viewer-collapsed');
    if (collapsed) {
      collapsed.style.background = `linear-gradient(135deg, var(--primary) 0%, var(--secondary) 50%, var(--tertiary) 100%)`;
    }

    // Apply theme to all filter buttons (not only active)
    const allFilters = document.querySelectorAll('.filter-btn');
    allFilters.forEach(btn => {
      // default filter look: light tertiary background, dark text; active filter will be primary gradient
      btn.style.background = `${customColors.tertiary}10`;
      btn.style.color = '#333';
      btn.style.borderColor = `${customColors.tertiary}40`;
    });
    // Set active filter styling
    const activeFilter = document.querySelector('.filter-btn.active');
    if (activeFilter) {
      activeFilter.style.background = `linear-gradient(135deg, ${customColors.primary}, ${customColors.secondary})`;
      activeFilter.style.color = getContrastColor(customColors.primary);
      activeFilter.style.borderColor = customColors.primary;
    }

    // Footer color
    const footer = document.querySelector('.viewer-footer');
    if (footer) {
      footer.style.background = `${customColors.tertiary}10`;
      footer.style.color = '#222';
      // remove extra bottom gap by reducing footer padding if viewer small
      footer.style.padding = '6px 12px';
    }

    // Header control buttons (toggle, settings) should follow user colors
    const toggleBtn = document.querySelector('.viewer-toggle');
    const settingsBtn = document.querySelector('.viewer-settings');
    const closeBtn = document.querySelector('.settings-close');
    const controlBg = `linear-gradient(135deg, ${customColors.primary}, ${customColors.secondary})`;
    const controlFg = getContrastColor(customColors.primary);
    if (toggleBtn) {
      toggleBtn.style.background = controlBg;
      toggleBtn.style.color = controlFg;
      toggleBtn.style.borderColor = customColors.primary;
    }
    if (settingsBtn) {
      settingsBtn.style.background = controlBg;
      settingsBtn.style.color = controlFg;
      settingsBtn.style.borderColor = customColors.primary;
    }
    if (closeBtn) {
      closeBtn.style.background = controlBg;
      closeBtn.style.color = controlFg;
      closeBtn.style.borderColor = customColors.primary;
    }

    // Assignment items border + hover effects
    const assignments = document.querySelectorAll('.assignment-item');
    assignments.forEach(item => {
      item.style.borderRightColor = customColors.primary;
      // add dynamic hover shadow using mouse events
      item.addEventListener('mouseenter', () => {
        item.style.transform = 'translateX(-3px)';
        item.style.boxShadow = `0 2px 8px ${hexToRgba(customColors.primary, 0.18)}`;
      });
      item.addEventListener('mouseleave', () => {
        item.style.transform = '';
        item.style.boxShadow = '';
      });
    });

    // Settings/options tab theming
    const settingsPanel = document.getElementById('settings-panel');
    if (settingsPanel) {
      const settingsHeader = settingsPanel.querySelector('.settings-header');
      if (settingsHeader) {
        settingsHeader.style.background = `linear-gradient(135deg, ${customColors.primary} 0%, ${customColors.secondary} 50%, ${customColors.tertiary} 100%)`;
        settingsHeader.style.color = 'white';
      }
      // compute readable text colors for buttons
      function hexToRgb(hex) {
        const h = hex.replace('#','');
        const full = h.length===3? h.split('').map(c=>c+c).join('') : h;
        const bigint = parseInt(full,16);
        return [(bigint>>16)&255, (bigint>>8)&255, bigint&255];
      }
      function rgbToHex(r,g,b){
        return '#'+[r,g,b].map(v=>v.toString(16).padStart(2,'0')).join('');
      }
      // average primary and secondary for gradient text contrast
      let avgHex = customColors.primary || '#f98012';
      try {
        const p = hexToRgb(customColors.primary);
        const s = hexToRgb(customColors.secondary);
        const avg = [Math.round((p[0]+s[0])/2), Math.round((p[1]+s[1])/2), Math.round((p[2]+s[2])/2)];
        avgHex = rgbToHex(avg[0],avg[1],avg[2]);
      } catch (e) {
        avgHex = customColors.primary;
      }
      const btnTextColor = getContrastColor(avgHex);
      settingsPanel.querySelectorAll('.settings-btn').forEach(btn => {
        btn.style.background = `linear-gradient(135deg, ${customColors.primary}, ${customColors.secondary})`;
        btn.style.color = btnTextColor;
        btn.style.borderColor = customColors.primary;
      });
      settingsPanel.querySelectorAll('.settings-btn-secondary').forEach(btn => {
        btn.style.background = customColors.tertiary;
        btn.style.color = getContrastColor(customColors.tertiary);
        btn.style.borderColor = customColors.tertiary;
      });
    }

    // -------------------------------
    // Color math helpers (local to applyColorsToViewer)
    // - hexToRgbSimple / rgbToHex / luminance / contrastRatio are used for
    //   computing icon fills and contrast decisions for buttons.
    // -------------------------------
    // Helper: small color utilities for icon contrast
    function hexToRgbSimple(hex) {
      const h = (hex || '#000').replace('#','');
      const full = h.length === 3 ? h.split('').map(c=>c+c).join('') : h;
      const bigint = parseInt(full, 16);
      return [(bigint>>16)&255, (bigint>>8)&255, bigint&255];
    }
    function rgbToHex(r,g,b){
      return '#'+[r,g,b].map(v=>v.toString(16).padStart(2,'0')).join('');
    }
    function luminance(hex){
      const [r,g,b] = hexToRgbSimple(hex);
      const srgb = [r,g,b].map(v => {
        const s = v/255;
        return s <= 0.03928 ? s/12.92 : Math.pow((s+0.055)/1.055, 2.4);
      });
      return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
    }
    function contrastRatio(hexA, hexB) {
      try {
        const L1 = luminance(hexA);
        const L2 = luminance(hexB);
        const lighter = Math.max(L1, L2);
        const darker = Math.min(L1, L2);
        return (lighter + 0.05) / (darker + 0.05);
      } catch (e) {
        return 1;
      }
    }

    // Style custom toggle and restore buttons: let CSS (variables + aria-pressed) control backgrounds
    // Only compute and set an appropriate icon fill color so svg icons remain readable.
    const customBtns = document.querySelectorAll('.custom-toggle-btn, .custom-restore-btn');
    customBtns.forEach(btn => {
      // compute average background for icon contrast (primary+secondary) or use tertiary when pressed
      let avgHexLocal = customColors.primary || '#f98012';
      try {
        const p = hexToRgbSimple(customColors.primary);
        const s = hexToRgbSimple(customColors.secondary);
        const avg = [Math.round((p[0]+s[0])/2), Math.round((p[1]+s[1])/2), Math.round((p[2]+s[2])/2)];
        avgHexLocal = rgbToHex(avg[0], avg[1], avg[2]);
      } catch (e) {
        avgHexLocal = customColors.primary;
      }
      const isPressed = btn.getAttribute('aria-pressed') === 'true';
      const bgForContrast = isPressed ? (customColors.tertiary || avgHexLocal) : avgHexLocal;
      const icon = btn.querySelector('svg');
      if (icon) {
        try {
          const preferTertiary = customColors.tertiary && contrastRatio(bgForContrast, customColors.tertiary) >= 3.5;
          const iconFill = preferTertiary ? customColors.tertiary : getContrastColor(bgForContrast);
          icon.style.fill = iconFill;
        } catch (e) { /* ignore */ }
      }
    });

    // Per-assignment restore buttons (hidden view)
    document.querySelectorAll('.assignment-restore-btn').forEach(btn => {
      // Make restore buttons clearly visible: prefer primary background
      // but compute an icon color that has sufficient contrast. If the
      // contrast is low, fall back to tertiary/secondary or a sensible
      // accent so the icon remains visible on white/light backgrounds.
      try {
        const preferBg = customColors.primary || '#f98012';
        btn.style.borderColor = customColors.primary || 'rgba(0,0,0,0.06)';
        btn.style.background = preferBg;

        // candidate icon colors to try (use CSS vars if available)
        const candidates = [getContrastColor(preferBg), customColors.tertiary, customColors.secondary, '#2d9fd8', '#000'];
        let chosen = candidates[0];
        // choose the first candidate that meets contrast ratio >= 3.5
        for (let c of candidates) {
          if (!c) continue;
          try {
            if (contrastRatio(preferBg, c) >= 3.5) { chosen = c; break; }
          } catch (e) { /* ignore */ }
        }
        // set CSS variable so stylesheet's !important fill uses it
        btn.style.setProperty('--restore-fg', chosen);
        btn.style.color = chosen;
        const svg = btn.querySelector('svg');
        if (svg) {
          try { svg.style.fill = chosen; } catch (e) {}
        }
      } catch (e) {
        // fallback: keep previous safe defaults
        btn.style.borderColor = customColors.primary || 'rgba(0,0,0,0.06)';
        btn.style.background = customColors.primary || '#f98012';
      }
    });

    // Per-assignment hide buttons (appear on hover) should also use user colors
    document.querySelectorAll('.assignment-hide-btn').forEach(hb => {
      try {
        hb.style.background = customColors.tertiary || '#ff6b6b';
        hb.style.borderColor = customColors.tertiary || 'rgba(0,0,0,0.06)';
        const fg = getContrastColor(customColors.tertiary || '#ff6b6b');
        hb.style.color = fg;
        const svg = hb.querySelector('svg');
        if (svg) svg.style.fill = fg;
      } catch (e) { /* ignore */ }
    });
  }

  // Helper: convert hex to rgba
  // -------------------------------
  // Utility: hexToRgba
  // - Converts a hex color string into an rgba() CSS string with given alpha.
  // -------------------------------
  function hexToRgba(hex, alpha) {
    if (!hex) return `rgba(0,0,0,${alpha})`;
    const h = hex.replace('#', '');
    const bigint = parseInt(h.length === 3 ? h.split('').map(c=>c+c).join('') : h, 16);
    const r = (bigint >> 16) & 255;
    const g = (bigint >> 8) & 255;
    const b = bigint & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  // -------------------------------
  // Utility: getContrastColor
  // - Returns either '#000' or '#fff' depending on which provides a better
  //   contrast ratio against the provided hex background color.
  // -------------------------------
  // Helper: get contrasting text color (#000 or #fff) for readability
  function getContrastColor(hex) {
    if (!hex) return '#000';
    const h = hex.replace('#', '');
    const full = h.length === 3 ? h.split('').map(c=>c+c).join('') : h;
    const bigint = parseInt(full, 16);
    const r = (bigint >> 16) & 255;
    const g = (bigint >> 8) & 255;
    const b = bigint & 255;
    // relative luminance
    const srgb = [r,g,b].map(v => {
      const s = v/255;
      return s <= 0.03928 ? s/12.92 : Math.pow((s+0.055)/1.055, 2.4);
    });
    const lum = 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
    // contrast against white: (Lwhite + 0.05) / (lum + 0.05)
    const contrastWithWhite = (1.0 + 0.05) / (lum + 0.05);
    // choose white if contrastWithWhite >= 3.5 (somewhat accessible), else black
    return contrastWithWhite >= 3.5 ? '#fff' : '#000';
  }

  // Profiles are static placeholders defined in `STATIC_PROFILES` and are not editable.

  // -------------------------------
  // Links management (settings)
  // addLink:
  // - Prompts the user to add a quick-link (name + URL) and persists it.
  // -------------------------------
  function addLink() {
    const name = prompt('הזן שם לקישור:');
    if (!name) return;
    
    const url = prompt('הזן כתובת URL:');
    if (!url) return;
    
    chrome.storage.sync.get(['links'], (result) => {
      const links = result.links || [];
      links.push({ name, url });
      chrome.storage.sync.set({ links }, () => {
        renderLinks(links);
      });
    });
  }

  // -------------------------------
  // renderLinks:
  // - Renders the list of saved quick-links inside the settings panel and
  //   attaches delete handlers.
  // -------------------------------
  function renderLinks(links) {
    const container = document.getElementById('links-container');
    if (!container) return;
    
    container.innerHTML = links.map((link, index) => `
      <div class="link-item">
        <a href="${link.url}" target="_blank" class="link-name">${link.name}</a>
        <button class="link-delete" data-index="${index}">🗑️</button>
      </div>
    `).join('');
    
    // Add delete handlers
    container.querySelectorAll('.link-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const index = parseInt(e.target.getAttribute('data-index'));
        deleteLink(index);
      });
    });
  }

  // -------------------------------
  // deleteLink:
  // - Removes a saved quick-link by index and updates storage/UI.
  // -------------------------------
  function deleteLink(index) {
    chrome.storage.sync.get(['links'], (result) => {
      const links = result.links || [];
      links.splice(index, 1);
      chrome.storage.sync.set({ links }, () => {
        renderLinks(links);
      });
    });
  }

  // -------------------------------
  // Custom tab: Drag & Drop
  // setupCustomDragDrop:
  // - Enables HTML5 drag/drop for `.custom-draggable` items, handles
  //   reordering in `customAssignmentOrder`, and wires the per-item hide
  //   button behavior.
  // -------------------------------


  function setupCustomDragDrop(assignments) {
    const content = document.querySelector('#viewer-content');
    let draggedElement = null;
    
    const items = content.querySelectorAll('.custom-draggable');
    
    items.forEach(item => {
      item.addEventListener('dragstart', (e) => {
        draggedElement = item;
        item.style.opacity = '0.5';
        e.dataTransfer.effectAllowed = 'move';
      });
      
      item.addEventListener('dragend', (e) => {
        item.style.opacity = '1';
        draggedElement = null;
      });
      
      item.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (item !== draggedElement) {
          item.style.borderTop = '2px solid #f98012';
        }
      });
      
      item.addEventListener('dragleave', (e) => {
        item.style.borderTop = '';
      });
      
      item.addEventListener('drop', (e) => {
        e.preventDefault();
        item.style.borderTop = '';
        
        if (draggedElement && draggedElement !== item) {
          // Reorder in customAssignmentOrder
          const draggedLink = draggedElement.getAttribute('data-link');
          const targetLink = item.getAttribute('data-link');
          const normDragged = normalizeLink(draggedLink);
          const normTarget = normalizeLink(targetLink);

          const draggedIdx = customAssignmentOrder.indexOf(normDragged);
          const targetIdx = customAssignmentOrder.indexOf(normTarget);

          if (draggedIdx !== -1 && targetIdx !== -1) {
            customAssignmentOrder.splice(draggedIdx, 1);
            customAssignmentOrder.splice(targetIdx, 0, normDragged);
            chrome.storage.sync.set({ customAssignmentOrder });
            updateViewer();
          } else {
            // Fallback: rebuild order from current assignments array (preserves relative order seen by user)
            try {
              const currentOrder = assignments.map(a => normalizeLink(a.link)).filter(Boolean);
              // remove existing occurrences of dragged
              const filtered = currentOrder.filter(l => l !== normDragged);
              let insertAt = filtered.indexOf(normTarget);
              if (insertAt === -1) {
                // determine target position by DOM order
                const nodeList = Array.from(content.querySelectorAll('.custom-draggable'));
                const nodeIdx = nodeList.findIndex(n => normalizeLink(n.getAttribute('data-link')) === normTarget);
                insertAt = nodeIdx !== -1 ? nodeIdx : filtered.length;
              }
              filtered.splice(insertAt, 0, normDragged);
              customAssignmentOrder = filtered;
              chrome.storage.sync.set({ customAssignmentOrder });
              updateViewer();
            } catch (e) {
              dwarn('Failed to fallback reorder customAssignmentOrder:', e);
            }
          }
        }
      });
      
      // Hide button handler
      const hideBtn = item.querySelector('.assignment-hide-btn');
        if (hideBtn) {
        hideBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const link = hideBtn.getAttribute('data-link');
          const norm = normalizeLink(link);
          customAssignmentHidden.add(norm);
          chrome.storage.sync.set({ customAssignmentHidden: Array.from(customAssignmentHidden) });
          updateViewer();
        });
      }
    });
  }

  // -------------------------------
  // Custom tab: Restore helpers
  // restoreAllAssignments:
  // - Clears the hidden set and persists the change so all assignments
  //   become visible in the custom tab.
  // -------------------------------
  function restoreAllAssignments() {
    customAssignmentHidden.clear();
    chrome.storage.sync.set({ customAssignmentHidden: [] });
    updateViewer();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.addEventListener('beforeunload', () => {
    if (updateInterval) {
      clearInterval(updateInterval);
    }
    // Persist current viewer size on unload so navigation retains last size
    try {
      const viewer = document.getElementById('moodle-task-viewer');
      if (viewer) {
        chrome.storage.sync.set({ viewerSize: { width: viewer.style.width || window.getComputedStyle(viewer).width, height: viewer.style.height || window.getComputedStyle(viewer).height } });
      }
    } catch (e) {
      // ignore storage errors during unload
    }
  });
})();