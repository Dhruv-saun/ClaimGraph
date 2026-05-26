/* ClaimGraph frontend.
 *
 * Talks to the Flask API in claimgraph.api, renders the graph with
 * Cytoscape.js (dagre layout), and provides forms for adding claims,
 * evidence and edges.
 *
 * Confidence -> node colour mapping: linear interpolation between red,
 * yellow and green in [-1, +1].
 */

(function () {
  let currentLayout = "TB";

  const cy = cytoscape({
    container: document.getElementById("cy"),
    elements: [],
    style: [
      {
        selector: "node",
        style: {
          "shape": "roundrectangle",
          "label": "data(short)",
          "text-wrap": "wrap",
          "text-max-width": 150,
          "font-size": 11,
          "color": "#0b1020",
          "background-color": "data(color)",
          "border-color": "#1a1e2a",
          "border-width": 2,
          "width": "label",
          "height": "label",
          "text-valign": "center",
          "text-halign": "center",
          "padding": "14px",
          "transition-property": "border-color, border-width, opacity",
          "transition-duration": "0.2s",
        },
      },
      {
        selector: "node.selected",
        style: {
          "border-color": "#5b9cff",
          "border-width": 3,
          "shadow-blur": 12,
          "shadow-color": "rgba(91,156,255,0.3)",
          "shadow-opacity": 1,
        },
      },
      {
        selector: "node.highlight-topo",
        style: { "border-color": "#5b9cff", "border-width": 4 },
      },
      {
        selector: "node.highlight-path",
        style: { "border-color": "#facc15", "border-width": 4 },
      },
      {
        selector: "node.search-dim",
        style: { "opacity": 0.15 },
      },
      {
        selector: "edge",
        style: {
          "curve-style": "bezier",
          "target-arrow-shape": "triangle",
          "width": 2,
          "opacity": 0.7,
          "label": "data(label)",
          "font-size": 9,
          "color": "#8b95a8",
          "text-rotation": "autorotate",
          "text-background-color": "#0c0e13",
          "text-background-opacity": 0.7,
          "text-background-padding": 3,
          "transition-property": "opacity, line-color, width",
          "transition-duration": "0.2s",
        },
      },
      {
        selector: "edge[type = 'depends_on']",
        style: { "line-color": "#94a3b8", "target-arrow-color": "#94a3b8" },
      },
      {
        selector: "edge[type = 'supports']",
        style: {
          "line-color": "#4ade80",
          "target-arrow-color": "#4ade80",
          "line-style": "dashed",
        },
      },
      {
        selector: "edge[type = 'contradicts']",
        style: {
          "line-color": "#f87171",
          "target-arrow-color": "#f87171",
          "line-style": "dashed",
        },
      },
      {
        selector: "edge.highlight-path",
        style: {
          "line-color": "#facc15",
          "target-arrow-color": "#facc15",
          "width": 3.5,
          "opacity": 1,
        },
      },
      {
        selector: "edge.search-dim",
        style: { "opacity": 0.08 },
      },
    ],
    layout: { name: "dagre", rankDir: "TB" },
    wheelSensitivity: 0.2,
    minZoom: 0.3,
    maxZoom: 3,
  });

  const datasetSelect = document.getElementById("dataset-select");
  const messagesEl = document.getElementById("messages");
  const detailEl = document.getElementById("claim-detail");
  const tooltipEl = document.getElementById("tooltip");
  const searchInput = document.getElementById("search-input");

  let state = {
    claims: [],
    evidence: [],
    edges: [],
    confidence: {},
    topo: [],
    levels: {},
    selectedClaim: null,
  };

  // ---------- Helpers -------------------------------------------------- //

  function showMessage(text, kind = "ok") {
    const div = document.createElement("div");
    div.className = `msg ${kind}`;
    div.textContent = text;
    messagesEl.prepend(div);
    setTimeout(() => div.remove(), 5000);
  }

  function confidenceColor(c) {
    const stops = [
      { t: -1, rgb: [185, 28, 28] },
      { t: -0.5, rgb: [248, 113, 113] },
      { t: 0, rgb: [250, 204, 21] },
      { t: 0.5, rgb: [132, 204, 22] },
      { t: 1, rgb: [21, 128, 61] },
    ];
    if (c <= stops[0].t) return rgbCss(stops[0].rgb);
    for (let i = 1; i < stops.length; i++) {
      if (c <= stops[i].t) {
        const a = stops[i - 1];
        const b = stops[i];
        const f = (c - a.t) / (b.t - a.t);
        return rgbCss([
          Math.round(a.rgb[0] + f * (b.rgb[0] - a.rgb[0])),
          Math.round(a.rgb[1] + f * (b.rgb[1] - a.rgb[1])),
          Math.round(a.rgb[2] + f * (b.rgb[2] - a.rgb[2])),
        ]);
      }
    }
    return rgbCss(stops[stops.length - 1].rgb);
  }

  function rgbCss([r, g, b]) {
    return `rgb(${r}, ${g}, ${b})`;
  }

  function shortLabel(text) {
    if (text.length <= 55) return text;
    return text.slice(0, 52) + "...";
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function formatConf(v) {
    if (v === null || v === undefined) return "n/a";
    const sign = v >= 0 ? "+" : "";
    return sign + v.toFixed(2);
  }

  function claimById(id) {
    return state.claims.find((c) => c.id === id);
  }

  function updateStats() {
    document.getElementById("stat-claims").textContent = state.claims.length;
    document.getElementById("stat-edges").textContent = state.edges.length;
    document.getElementById("stat-evidence").textContent = state.evidence.length;
  }

  // ---------- Network -------------------------------------------------- //

  async function api(path, opts = {}) {
    const init = { headers: { "Content-Type": "application/json" }, ...opts };
    const res = await fetch(`/api${path}`, init);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `${res.status} ${res.statusText}`);
    }
    return data;
  }

  async function loadDatasetList() {
    const { datasets } = await api("/datasets");
    datasetSelect.innerHTML = "";
    for (const name of datasets) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      datasetSelect.appendChild(opt);
    }
  }

  async function refreshGraph(serverState = null) {
    const data = serverState || (await api("/graph"));
    state.claims = data.claims;
    state.evidence = data.evidence;
    state.edges = data.edges;
    state.confidence = data.confidence || {};
    state.topo = data.topological_order || [];
    state.levels = data.levels || {};
    renderGraph();
    refreshFormDropdowns();
    updateStats();
    if (state.selectedClaim && !state.claims.find((c) => c.id === state.selectedClaim)) {
      state.selectedClaim = null;
    }
    if (state.selectedClaim) {
      renderClaimDetail(state.selectedClaim);
    } else {
      renderOverview();
    }
  }

  function renderOverview() {
    detailEl.innerHTML = `
      <h2>${state.claims.length} claims loaded</h2>
      <p class="hint">Click any node in the graph to inspect it.</p>
      <h3>Topological order (Kahn)</h3>
      <ol class="topo-list">
        ${state.topo
          .map((id) => `<li>${escapeHtml(claimById(id)?.text || id)}</li>`)
          .join("")}
      </ol>`;
  }

  function renderGraph() {
    const nodes = state.claims.map((c) => {
      const conf = state.confidence[c.id] || { final: 0 };
      return {
        data: {
          id: c.id,
          short: shortLabel(c.text),
          full: c.text,
          color: confidenceColor(conf.final),
          conf: conf.final,
        },
      };
    });
    const edges = state.edges.map((e) => ({
      data: {
        id: `${e.source}_${e.type}_${e.target}`,
        source: e.source,
        target: e.target,
        type: e.type,
        label: e.type,
      },
    }));
    cy.elements().remove();
    cy.add([...nodes, ...edges]);
    runLayout();
  }

  function runLayout() {
    cy.layout({
      name: "dagre",
      rankDir: currentLayout,
      nodeSep: 50,
      rankSep: 70,
      animate: true,
      animationDuration: 300,
      animationEasing: "ease-in-out-cubic",
    }).run();
    setTimeout(() => cy.fit(50), 350);
  }

  // ---------- Claim detail --------------------------------------------- //

  function renderClaimDetail(claimId) {
    const claim = claimById(claimId);
    if (!claim) return;
    const conf = state.confidence[claimId] || { intrinsic: 0, final: 0, prereqs_mean: null };
    const evs = state.evidence.filter((e) => e.claim_id === claimId);
    const directDeps = state.edges
      .filter((e) => e.source === claimId && e.type === "depends_on")
      .map((e) => claimById(e.target));
    const dependents = state.edges
      .filter((e) => e.target === claimId && e.type === "depends_on")
      .map((e) => claimById(e.source));

    detailEl.innerHTML = `
      <h2>${escapeHtml(claim.text)}</h2>
      <div class="tag-row">
        ${(claim.tags || []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("")}
      </div>
      ${claim.context ? `<p class="hint" style="margin-top:4px"><em>${escapeHtml(claim.context)}</em></p>` : ""}

      <div class="conf-block">
        <div class="conf-card">
          <span>Intrinsic</span>
          <strong>${formatConf(conf.intrinsic)}</strong>
          <span class="hint">own evidence only</span>
        </div>
        <div class="conf-card">
          <span>Final</span>
          <strong>${formatConf(conf.final)}</strong>
          <span class="hint">${
            conf.prereqs_mean === null
              ? "no prerequisites"
              : "prereqs mean = " + formatConf(conf.prereqs_mean)
          }</span>
        </div>
      </div>

      <h3>Evidence (${evs.length})</h3>
      <ul class="evidence-list">
        ${evs
          .map(
            (e) => `<li class="${e.direction}">
              <div class="ev-header">
                <strong>${escapeHtml(e.source)}</strong>
                <button class="btn-delete" data-delete-evidence="${e.id}" title="Remove evidence">&times;</button>
              </div>
              <div class="meta">${e.direction} &middot; strength ${e.strength.toFixed(2)} &middot;
              quality ${e.source_quality.toFixed(2)}</div>
              ${e.notes ? `<div class="meta">${escapeHtml(e.notes)}</div>` : ""}
            </li>`
          )
          .join("") || `<li class="hint">No evidence yet.</li>`}
      </ul>

      <h3>Prerequisites (${directDeps.length})</h3>
      <ul class="dep-list">
        ${
          directDeps
            .filter(Boolean)
            .map((c) => `<li data-nav-claim="${c.id}">&rarr; ${escapeHtml(c.text)}</li>`)
            .join("") || `<li class="hint">root claim</li>`
        }
      </ul>

      <h3>Dependents (${dependents.length})</h3>
      <ul class="dep-list">
        ${
          dependents
            .filter(Boolean)
            .map((c) => `<li data-nav-claim="${c.id}">&larr; ${escapeHtml(c.text)}</li>`)
            .join("") || `<li class="hint">no claim depends on this</li>`
        }
      </ul>

      <h3>Reasoning paths</h3>
      <div id="paths-area"><p class="hint">Loading paths&hellip;</p></div>

      <div class="claim-actions">
        <button class="btn-delete-claim" data-delete-claim="${claimId}">Delete this claim</button>
      </div>
    `;

    // Wire delete evidence buttons
    detailEl.querySelectorAll(".btn-delete[data-delete-evidence]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const evId = btn.dataset.deleteEvidence;
        try {
          await api(`/evidence/${evId}`, { method: "DELETE" });
          showMessage("Evidence removed");
          await refreshGraph();
        } catch (err) {
          showMessage(err.message, "error");
        }
      });
    });

    // Wire delete claim button
    const delClaimBtn = detailEl.querySelector(".btn-delete-claim");
    if (delClaimBtn) {
      delClaimBtn.addEventListener("click", async () => {
        const id = delClaimBtn.dataset.deleteClaim;
        try {
          await api(`/claims/${id}`, { method: "DELETE" });
          showMessage("Claim removed");
          state.selectedClaim = null;
          await refreshGraph();
        } catch (err) {
          showMessage(err.message, "error");
        }
      });
    }

    // Wire navigable dependency links
    detailEl.querySelectorAll("[data-nav-claim]").forEach((el) => {
      el.addEventListener("click", () => {
        const navId = el.dataset.navClaim;
        cy.nodes().removeClass("selected");
        const node = cy.getElementById(navId);
        if (node.length) {
          node.addClass("selected");
          cy.animate({ center: { eles: node }, duration: 300 });
        }
        state.selectedClaim = navId;
        renderClaimDetail(navId);
      });
    });

    // Load reasoning paths
    api(`/paths/${claimId}`)
      .then((data) => {
        const area = document.getElementById("paths-area");
        if (!area) return;
        if (!data.paths.length) {
          area.innerHTML = `<p class="hint">No reasoning paths (root claim).</p>`;
          return;
        }
        area.innerHTML = `<ul class="path-list">
          ${data.paths
            .map(
              (path) =>
                `<li>${path
                  .map((id) => escapeHtml(claimById(id)?.text || id))
                  .join(" &rarr; ")}</li>`
            )
            .join("")}
        </ul>`;
      })
      .catch((err) => showMessage(err.message, "error"));
  }

  // ---------- Form dropdowns ------------------------------------------- //

  function refreshFormDropdowns() {
    for (const sel of document.querySelectorAll(
      "select[name='claim_id'], select[name='source'], select[name='target']"
    )) {
      const cur = sel.value;
      sel.innerHTML = state.claims
        .map((c) => `<option value="${c.id}">${escapeHtml(shortLabel(c.text))}</option>`)
        .join("");
      if (cur) sel.value = cur;
    }
  }

  // ---------- Search --------------------------------------------------- //

  function handleSearch() {
    const query = searchInput.value.trim().toLowerCase();
    if (!query) {
      cy.nodes().removeClass("search-dim");
      cy.edges().removeClass("search-dim");
      return;
    }
    cy.nodes().forEach((node) => {
      const text = (node.data("full") || "").toLowerCase();
      if (text.includes(query)) {
        node.removeClass("search-dim");
      } else {
        node.addClass("search-dim");
      }
    });
    cy.edges().forEach((edge) => {
      const src = edge.source();
      const tgt = edge.target();
      if (src.hasClass("search-dim") && tgt.hasClass("search-dim")) {
        edge.addClass("search-dim");
      } else {
        edge.removeClass("search-dim");
      }
    });
  }

  // ---------- Tooltip -------------------------------------------------- //

  function showTooltip(x, y, html) {
    tooltipEl.innerHTML = html;
    tooltipEl.classList.remove("hidden");
    const rect = tooltipEl.getBoundingClientRect();
    const px = Math.min(x + 12, window.innerWidth - rect.width - 12);
    const py = Math.min(y + 12, window.innerHeight - rect.height - 12);
    tooltipEl.style.left = px + "px";
    tooltipEl.style.top = py + "px";
  }

  function hideTooltip() {
    tooltipEl.classList.add("hidden");
  }

  // ---------- Form handlers ------------------------------------------- //

  document.getElementById("form-claim").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = {
      id: fd.get("id") || undefined,
      text: fd.get("text"),
      tags: (fd.get("tags") || "").split(",").map((s) => s.trim()).filter(Boolean),
      context: fd.get("context") || "",
    };
    try {
      await api("/claims", { method: "POST", body: JSON.stringify(payload) });
      showMessage("Claim added");
      e.target.reset();
      await refreshGraph();
    } catch (err) {
      showMessage(err.message, "error");
    }
  });

  document.getElementById("form-evidence").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = {
      claim_id: fd.get("claim_id"),
      source: fd.get("source"),
      direction: fd.get("direction"),
      strength: parseFloat(fd.get("strength")),
      source_quality: parseFloat(fd.get("source_quality")),
      notes: fd.get("notes") || "",
    };
    try {
      await api("/evidence", { method: "POST", body: JSON.stringify(payload) });
      showMessage("Evidence added; confidences propagated");
      e.target.reset();
      await refreshGraph();
    } catch (err) {
      showMessage(err.message, "error");
    }
  });

  document.getElementById("form-edge").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = {
      source: fd.get("source"),
      target: fd.get("target"),
      type: fd.get("type"),
      weight: parseFloat(fd.get("weight")),
    };
    try {
      await api("/edges", { method: "POST", body: JSON.stringify(payload) });
      showMessage("Edge added");
      await refreshGraph();
    } catch (err) {
      showMessage(err.message, "error");
    }
  });

  // ---------- Header buttons ------------------------------------------ //

  document.getElementById("btn-load").addEventListener("click", async () => {
    const name = datasetSelect.value;
    try {
      const data = await api(`/load/${name}`, { method: "POST" });
      showMessage(`Loaded dataset: ${name}`);
      state.selectedClaim = null;
      await refreshGraph(data);
    } catch (err) {
      showMessage(err.message, "error");
    }
  });

  document.getElementById("btn-reset").addEventListener("click", async () => {
    try {
      const data = await api("/reset", { method: "POST" });
      showMessage("Graph reset to empty");
      state.selectedClaim = null;
      await refreshGraph(data);
    } catch (err) {
      showMessage(err.message, "error");
    }
  });

  document.getElementById("btn-topo").addEventListener("click", () => {
    cy.nodes().removeClass("selected highlight-topo highlight-path");
    cy.edges().removeClass("highlight-path");
    state.topo.forEach((id, i) => {
      setTimeout(() => {
        cy.getElementById(id).addClass("highlight-topo");
      }, i * 250);
    });
    showMessage(
      `Topological order (Kahn): ${state.topo
        .map((id) => claimById(id)?.text?.slice(0, 30) || id)
        .join("  ->  ")}`
    );
  });

  document.getElementById("btn-longest").addEventListener("click", async () => {
    if (!state.selectedClaim) {
      showMessage("Select a claim first (click a node).", "error");
      return;
    }
    try {
      const data = await api(`/longest-path/${state.selectedClaim}`);
      cy.nodes().removeClass("selected highlight-topo highlight-path");
      cy.edges().removeClass("highlight-path");
      data.path.forEach((id) => cy.getElementById(id).addClass("highlight-path"));
      for (let i = 1; i < data.path.length; i++) {
        const src = data.path[i - 1];
        const dst = data.path[i];
        cy.edges(`[type = "depends_on"][source = "${src}"][target = "${dst}"]`)
          .addClass("highlight-path");
      }
      showMessage(
        `Longest reasoning chain (${data.length} hops): ${data.path
          .map((id) => claimById(id)?.text?.slice(0, 30) || id)
          .join("  ->  ")}`
      );
    } catch (err) {
      showMessage(err.message, "error");
    }
  });

  // ---------- Graph toolbar ------------------------------------------- //

  document.getElementById("btn-zoom-in").addEventListener("click", () => {
    cy.zoom({ level: cy.zoom() * 1.3, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
  });

  document.getElementById("btn-zoom-out").addEventListener("click", () => {
    cy.zoom({ level: cy.zoom() / 1.3, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
  });

  document.getElementById("btn-fit").addEventListener("click", () => {
    cy.fit(50);
  });

  document.getElementById("btn-layout-tb").addEventListener("click", () => {
    currentLayout = "TB";
    document.getElementById("btn-layout-tb").classList.add("active");
    document.getElementById("btn-layout-lr").classList.remove("active");
    runLayout();
  });

  document.getElementById("btn-layout-lr").addEventListener("click", () => {
    currentLayout = "LR";
    document.getElementById("btn-layout-lr").classList.add("active");
    document.getElementById("btn-layout-tb").classList.remove("active");
    runLayout();
  });

  // ---------- Search handler ------------------------------------------ //

  searchInput.addEventListener("input", handleSearch);
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      searchInput.value = "";
      handleSearch();
      searchInput.blur();
    }
  });

  // ---------- Cytoscape events ---------------------------------------- //

  cy.on("tap", "node", (evt) => {
    cy.nodes().removeClass("selected highlight-topo highlight-path");
    cy.edges().removeClass("highlight-path");
    state.selectedClaim = evt.target.id();
    evt.target.addClass("selected");
    renderClaimDetail(state.selectedClaim);
  });

  cy.on("tap", (evt) => {
    if (evt.target === cy) {
      state.selectedClaim = null;
      cy.nodes().removeClass("selected highlight-topo highlight-path");
      cy.edges().removeClass("highlight-path");
      renderOverview();
    }
  });

  cy.on("mouseover", "node", (evt) => {
    const node = evt.target;
    const conf = state.confidence[node.id()] || { final: 0 };
    const evCount = state.evidence.filter((e) => e.claim_id === node.id()).length;
    const pos = evt.renderedPosition || evt.position;
    const container = document.getElementById("cy").getBoundingClientRect();
    showTooltip(
      container.left + pos.x,
      container.top + pos.y,
      `<div class="tt-label">${escapeHtml(node.data("full"))}</div>
       <div class="tt-conf">Confidence: ${formatConf(conf.final)}</div>
       <div class="tt-meta">${evCount} evidence item${evCount !== 1 ? "s" : ""}</div>`
    );
  });

  cy.on("mouseout", "node", hideTooltip);
  cy.on("mouseover", "edge", (evt) => {
    const edge = evt.target;
    const pos = evt.renderedPosition || evt.position;
    const container = document.getElementById("cy").getBoundingClientRect();
    showTooltip(
      container.left + pos.x,
      container.top + pos.y,
      `<div class="tt-label">${edge.data("type")}</div>
       <div class="tt-meta">${escapeHtml(claimById(edge.data("source"))?.text || edge.data("source"))}<br>&rarr; ${escapeHtml(claimById(edge.data("target"))?.text || edge.data("target"))}</div>`
    );
  });
  cy.on("mouseout", "edge", hideTooltip);

  // ---------- Keyboard shortcuts -------------------------------------- //

  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") return;
    if (e.key === "/" || e.key === "f" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      searchInput.focus();
    }
    if (e.key === "Escape") {
      state.selectedClaim = null;
      cy.nodes().removeClass("selected highlight-topo highlight-path");
      cy.edges().removeClass("highlight-path");
      renderOverview();
    }
  });

  // ---------- Boot ---------------------------------------------------- //

  (async () => {
    try {
      await loadDatasetList();
      await refreshGraph();
    } catch (err) {
      showMessage(err.message, "error");
    }
  })();
})();
