(function attachJevReviewerUI(global) {
  "use strict";

  const PRIORITIES = ["P0", "P1", "P2"];
  const DEFAULT_DISPLAY = Object.freeze({
    visible: { P0: true, P1: true, P2: true },
    expanded: { P0: true, P1: false, P2: false },
    showNativeDiff: false
  });

  function text(value, fallback = "") {
    if (typeof value !== "string") return fallback;
    const clean = value.trim();
    return clean ? clean.slice(0, 30000) : fallback;
  }

  function asArray(value, max = 100) {
    return Array.isArray(value) ? value.slice(0, max) : [];
  }

  function stringArray(value, max = 50) {
    return asArray(value, max).map((item) => text(item)).filter(Boolean);
  }

  function priority(value) {
    const normalized = String(value || "").toUpperCase();
    return PRIORITIES.includes(normalized) ? normalized : "P0";
  }

  function normalizeEvidence(item) {
    if (typeof item === "string") return { path: "", startLine: null, endLine: null, side: "new", snippet: text(item) };
    if (!item || typeof item !== "object") return null;
    const startLine = Number(item.startLine ?? item.start_line);
    const endLine = Number(item.endLine ?? item.end_line);
    return {
      path: text(item.path),
      startLine: Number.isInteger(startLine) && startLine > 0 ? startLine : null,
      endLine: Number.isInteger(endLine) && endLine > 0 ? endLine : null,
      side: item.side === "old" ? "old" : "new",
      snippet: text(item.snippet)
    };
  }

  function normalizeChange(item, index) {
    const source = item && typeof item === "object" ? item : {};
    return {
      id: text(source.id, `change-${index + 1}`),
      title: text(source.title, `Change ${index + 1}`),
      priority: priority(source.priority),
      oldLogic: text(source.oldLogic ?? source.old_logic, "No old-logic explanation was provided."),
      newLogic: text(source.newLogic ?? source.new_logic, "No new-logic explanation was provided."),
      whatChanged: text(source.whatChanged ?? source.what_changed, "No change summary was provided."),
      whyHumanReview: text(
        source.whyHumanReview ?? source.why_human_review ?? source.reason ?? source.rationale,
        "No human-review question was provided. Treating incomplete analysis conservatively."
      ),
      files: asArray(source.files, 50).map((file) => text(typeof file === "string" ? file : file && file.path)).filter(Boolean),
      evidence: asArray(source.evidence, 50).map(normalizeEvidence).filter(Boolean),
      diff: text(source.diff),
      confidence: Number.isFinite(Number(source.confidence)) ? Math.max(0, Math.min(1, Number(source.confidence))) : null,
      signals: stringArray(source.signals),
      policyReasons: stringArray(source.policyReasons ?? source.policy_reasons),
      contextWarnings: stringArray(source.contextWarnings ?? source.context_warnings)
    };
  }

  function normalizeReport(report) {
    const source = report && typeof report === "object" ? report : {};
    const rawChanges = source.changes ?? source.groups ?? source.items ?? source.review_items;
    const changes = asArray(rawChanges, 500).map(normalizeChange);
    changes.sort((a, b) => PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority));
    return {
      repository: text(source.repository),
      pullRequest: Number(source.pullRequest ?? source.pull_request) || null,
      title: text(source.title, "Pull request review"),
      url: text(source.url),
      baseSha: text(source.baseSha ?? source.base_sha),
      headSha: text(source.headSha ?? source.head_sha),
      generatedAt: text(source.generatedAt ?? source.generated_at),
      mode: source.mode === "replay" ? "replay" : "live",
      providers: source.providers && typeof source.providers === "object" ? source.providers : {},
      provenance: source.provenance && typeof source.provenance === "object" ? {
        classification: text(source.provenance.classification),
        explanations: text(source.provenance.explanations),
        note: text(source.provenance.note)
      } : {},
      coverage: source.coverage && typeof source.coverage === "object" ? {
        total: Number.isInteger(Number(source.coverage.total)) && Number(source.coverage.total) >= 0 ? Number(source.coverage.total) : changes.length,
        analyzed: Number.isInteger(Number(source.coverage.analyzed)) && Number(source.coverage.analyzed) >= 0 ? Number(source.coverage.analyzed) : changes.length,
        unanalysed: Number.isInteger(Number(source.coverage.unanalysed ?? source.coverage.unanalyzed)) && Number(source.coverage.unanalysed ?? source.coverage.unanalyzed) >= 0
          ? Number(source.coverage.unanalysed ?? source.coverage.unanalyzed)
          : 0
      } : { total: changes.length, analyzed: changes.length, unanalysed: 0 },
      context: source.context && typeof source.context === "object" ? source.context : {},
      display: source.display && typeof source.display === "object" ? source.display : {},
      changes
    };
  }

  function mergeDisplay(display, reportDisplay = {}) {
    const source = display && typeof display === "object" ? display : {};
    const policy = reportDisplay && typeof reportDisplay === "object" ? reportDisplay : {};
    return {
      visible: Object.fromEntries(PRIORITIES.map((p) => [p, source.visible?.[p] !== false])),
      expanded: Object.fromEntries(PRIORITIES.map((p) => [
        p,
        typeof source.expanded?.[p] === "boolean"
          ? source.expanded[p]
          : typeof policy.expanded?.[p] === "boolean"
            ? policy.expanded[p]
            : typeof policy[p] === "boolean"
              ? policy[p]
              : DEFAULT_DISPLAY.expanded[p]
      ])),
      showNativeDiff: source.showNativeDiff === true
    };
  }

  // Classic "Files changed" is /files; GitHub's new React page is /changes. Commit-range
  // views (/files/<range>) show a partial diff, so they are deliberately not matched.
  function pageIdentity(pathname) {
    const match = /^\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]*)\/(?:(files)\/?|(changes)(?:\/.*)?)$/.exec(String(pathname || ""));
    if (!match) return null;
    return { owner: match[1], repo: match[2], pullRequest: Number(match[3]), view: match[4] ? "files" : "changes" };
  }

  function makeFreshness(report, currentHeadSha) {
    if (!currentHeadSha || !report.headSha) {
      return { state: "unverified", label: `Head ${report.headSha ? report.headSha.slice(0, 8) : "unknown"} · freshness unverified` };
    }
    const matches = currentHeadSha.startsWith(report.headSha) || report.headSha.startsWith(currentHeadSha);
    return matches
      ? { state: "fresh", label: `Current at ${report.headSha.slice(0, 8)}` }
      : { state: "stale", label: `Stale · analyzed ${report.headSha.slice(0, 8)}, page ${currentHeadSha.slice(0, 8)}` };
  }

  function provenanceText(report) {
    const liveClassifiers = ["live-typesafe-api", "live-classifier-dev-api", "live-custom-jev-api"];
    const classification = liveClassifiers.includes(report.provenance.classification)
      ? report.mode === "replay" ? "Recorded Jev decisions" : "Live Jev decisions"
      : "Jev decision provenance unverified";
    const explanations = report.provenance.explanations === "prepared-copy"
      ? "prepared demo explanations"
      : report.provenance.explanations === "live-openai-api"
        ? "OpenAI explanations"
        : "explanation provenance unverified";
    return `${classification} · ${explanations}`;
  }

  function el(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = String(content);
    return node;
  }

  function priorityDescription(value) {
    if (value === "P0") return "must review";
    if (value === "P1") return "review if time permits";
    return "automated review sufficient";
  }

  function createPriorityBadge(value, rawReport = {}) {
    const report = rawReport && Array.isArray(rawReport.changes) ? rawReport : normalizeReport(rawReport);
    const normalized = priority(value);
    const badge = el("span", `jrv-priority jrv-priority--${normalized.toLowerCase()}`, normalized);
    const notes = [`${normalized}: ${priorityDescription(normalized)}`];
    if (report.mode === "replay") notes.push("recorded review");
    if (report.provenance?.explanations === "prepared-copy") notes.push("prepared demo explanations");
    if (report.context?.graphify && report.context.graphify !== "available") notes.push(`Graphify ${text(report.context.graphify)}`);
    badge.title = notes.join(" · ");
    badge.setAttribute("aria-label", notes.join(". "));
    return badge;
  }

  function isNormalizedChange(change) {
    return Boolean(change && typeof change === "object" && typeof change.oldLogic === "string" && typeof change.newLogic === "string");
  }

  function renderLogicTable(container, rawChanges, options = {}) {
    if (!container || typeof container.append !== "function") throw new TypeError("renderLogicTable requires a DOM container.");
    const report = options.report && Array.isArray(options.report.changes) ? options.report : normalizeReport(options.report || {});
    const changes = asArray(rawChanges, 500).map((change, index) => isNormalizedChange(change) ? change : normalizeChange(change, index));
    const mixedPriorities = new Set(changes.map((change) => change.priority)).size > 1;

    const table = el("table", "jrv-logic-table");
    const thead = el("thead", "jrv-logic-table__head");
    const headerRow = el("tr");
    const oldHeader = el("th", "jrv-logic-table__heading", "Old logic");
    const newHeader = el("th", "jrv-logic-table__heading", "New logic");
    oldHeader.scope = "col";
    newHeader.scope = "col";
    headerRow.append(oldHeader, newHeader);
    thead.append(headerRow);
    table.append(thead);

    const tbody = el("tbody");
    changes.forEach((change) => {
      const row = el("tr", "jrv-logic-table__row");
      row.dataset.changeId = change.id;
      const oldCell = el("td", "jrv-old-logic");
      const newCell = el("td", "jrv-new-logic");
      if (mixedPriorities) oldCell.append(createPriorityBadge(change.priority, report));
      oldCell.append(el("p", "jrv-logic-text", change.oldLogic));
      newCell.append(el("p", "jrv-logic-text", change.newLogic));

      const info = el("details", "jrv-change-note");
      const summary = el("summary", "jrv-change-note__summary");
      const provenance = provenanceText(report);
      summary.title = `${change.whyHumanReview} · ${provenance}`;
      summary.setAttribute("aria-label", `What changed: ${change.whatChanged}. Human review question: ${change.whyHumanReview}. ${provenance}.`);
      const icon = el("span", "jrv-change-note__icon", "ⓘ");
      icon.setAttribute("aria-hidden", "true");
      summary.append(icon, document.createTextNode(change.whatChanged));
      info.append(summary, el("p", "jrv-change-note__detail", change.whyHumanReview));
      newCell.append(info);
      row.append(oldCell, newCell);
      tbody.append(row);
    });
    table.append(tbody);
    container.append(table);
    return table;
  }

  function fileGroups(changes) {
    const groups = new Map();
    changes.forEach((change) => {
      const path = change.files[0] || "Changed logic";
      if (!groups.has(path)) groups.set(path, []);
      groups.get(path).push(change);
    });
    return [...groups.entries()];
  }

  function highestPriority(changes) {
    return changes.reduce((current, change) => {
      return PRIORITIES.indexOf(change.priority) < PRIORITIES.indexOf(current) ? change.priority : current;
    }, "P2");
  }

  function renderReview(container, rawReport, options = {}) {
    if (!container || typeof container.replaceChildren !== "function") throw new TypeError("renderReview requires a DOM container.");
    const report = normalizeReport(rawReport);
    const display = mergeDisplay(options.display, report.display);
    container.replaceChildren();
    container.className = "jrv-files";

    fileGroups(report.changes).forEach(([path, changes]) => {
      const filePriority = highestPriority(changes);
      if (!display.visible[filePriority]) return;
      const file = el("details", "jrv-file");
      file.dataset.priority = filePriority;
      file.open = Boolean(display.expanded[filePriority]);

      const summary = el("summary", "jrv-file__header");
      const chevron = el("span", "jrv-file__chevron");
      chevron.setAttribute("aria-hidden", "true");
      summary.append(chevron, el("span", "jrv-file__path", path), createPriorityBadge(filePriority, report));
      file.append(summary);

      const body = el("div", "jrv-file__body");
      renderLogicTable(body, changes, { report });
      file.append(body);
      container.append(file);
    });

    if (!report.changes.length) container.append(el("p", "jrv-empty", "No semantic changes found."));
    return { report, display };
  }

  global.JevReviewerUI = {
    DEFAULT_DISPLAY,
    PRIORITIES,
    createPriorityBadge,
    makeFreshness,
    mergeDisplay,
    normalizeChange,
    normalizeReport,
    pageIdentity,
    provenanceText,
    renderLogicTable,
    renderReview
  };

  if (typeof module !== "undefined" && module.exports) module.exports = global.JevReviewerUI;
})(typeof globalThis !== "undefined" ? globalThis : this);
