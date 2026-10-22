const typeSelect = document.getElementById("type");
const findInput = document.getElementById("find");
const diffsOnly = document.getElementById("diffs");
const pinnedOnly = document.getElementById("pinned");
const nav = document.getElementById("nav");
const preview = document.getElementById("preview");
const compare = document.getElementById("compare");

let types = [];
let docs = [];
let current = null;
let page = 1;
let tableLimit = 20;
let compareCache = new Map();
const USER_PINS_KEY = "sales-platform-user-pins";
const STATIC = document.documentElement.dataset.mode === "static";

function safeDocId(id) {
  return id.replaceAll("/", "__");
}

function pageSrc(id, pageNumber) {
  if (!STATIC) return `/api/page?id=${encodeURIComponent(id)}&page=${pageNumber}`;
  return `pages/${encodeURIComponent(safeDocId(id))}/page-${pageNumber}.jpg`;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

function loadUserPins() {
  try {
    const saved = JSON.parse(localStorage.getItem(USER_PINS_KEY) || "[]");
    return new Set(Array.isArray(saved) ? saved : []);
  } catch {
    return new Set();
  }
}

let userPins = loadUserPins();

function saveUserPins() {
  localStorage.setItem(USER_PINS_KEY, JSON.stringify([...userPins]));
}

function userPinned(doc) {
  return userPins.has(doc.id);
}

function anyPin(doc) {
  return userPinned(doc) || (doc.pins || []).length > 0;
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function text(value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function pct(value) {
  return typeof value === "number" ? Math.round(value * 100) + "%" : "—";
}

function cell(value, state, confidence) {
  const shown = text(value);
  const valueHtml = shown ? esc(shown) : '<span class="empty">empty</span>';
  let badge = "";
  if (typeof confidence === "number") {
    const band = confidence >= 0.8 ? "high" : confidence >= 0.5 ? "mid" : "low";
    const score = Math.round(confidence * 100);
    const label = band === "mid" ? "medium" : band;
    badge = `<span class="conf ${band}" title="${score}% confidence, ${label}">${score}</span>`;
  }
  return `<td class="val ${state || ""}"><span class="val-line"><span class="val-text">${valueHtml}</span>${badge}</span></td>`;
}

function tokenCount(value) {
  return typeof value === "number" ? value.toLocaleString("en-IN") : "—";
}

function tokenLine(model, pages) {
  if (!model || typeof model.total !== "number") return "—";
  const perPage = pages ? Math.round(model.total / pages) : model.total;
  const parts = [];
  if (typeof model.prompt === "number") parts.push(`${tokenCount(model.prompt)} in`);
  if (typeof model.output === "number") parts.push(`${tokenCount(model.output)} out`);
  if (typeof model.thinking === "number") parts.push(`${tokenCount(model.thinking)} thinking`);
  const detail = parts.length ? ` (${parts.join(" · ")})` : "";
  return `${tokenCount(model.total)} tokens · ${tokenCount(perPage)} / page${detail}`;
}

function usd(value) {
  return typeof value === "number" ? `$${value.toFixed(4)}` : "";
}

function geminiLine(model, pages) {
  const tokens = tokenLine(model, pages);
  if (!model || typeof model.usd !== "number") return tokens;
  const perPage = pages ? model.usd / pages : model.usd;
  return `${tokens} · ${usd(model.usd)} · ${usd(perPage)} / page`;
}

function visibleField(field) {
  if (!diffsOnly.checked) return true;
  return field.differs;
}

function renderTypes() {
  typeSelect.replaceChildren();
  types.forEach((item) => {
    const opt = document.createElement("option");
    opt.value = item.id;
    const fail = item.gemma_failed ? `, ${item.gemma_failed} Gemma missing` : "";
    opt.textContent = `${item.label} (${item.docs}) · Staging ${pct(item.staging_recall)} · Gemma ${pct(item.gemma_recall)}${fail}`;
    typeSelect.append(opt);
  });
}

function renderNav() {
  const query = findInput.value.trim().toLowerCase();
  nav.replaceChildren();
  const shown = docs.filter((doc) => {
    if (pinnedOnly.checked && !anyPin(doc)) return false;
    return !query || doc.filename.toLowerCase().includes(query);
  });
  shown.sort((a, b) => pinRank(a) - pinRank(b) || a.filename.localeCompare(b.filename));
  if (!shown.length) {
    nav.innerHTML = '<p class="placeholder">No files match.</p>';
    return;
  }
  shown.forEach((doc) => {
    const button = document.createElement("button");
    button.classList.toggle("on", current && current.id === doc.id);
    const name = document.createElement("div");
    name.textContent = doc.filename;
    const badges = [];
    if (userPinned(doc)) badges.push(["user", "Pinned"]);
    (doc.pins || []).forEach((pin) => badges.push([pin, pin === "accuracy" ? "Accuracy" : "Pricing"]));
    if (badges.length) {
      const pins = document.createElement("div");
      pins.className = "pins";
      badges.forEach(([kind, label]) => {
        const badge = document.createElement("span");
        badge.className = `pin ${kind}`;
        badge.textContent = label;
        pins.append(badge);
      });
      button.append(pins);
    }
    const meta = document.createElement("small");
    const gemmaBad = !["completed", "partially_completed"].includes(String(doc.gemma_status).toLowerCase());
    meta.innerHTML = `Staging ${pct(doc.staging_recall)} · Gemma ${gemmaBad ? '<span class="bad">failed</span>' : pct(doc.gemma_recall)}`;
    button.append(name, meta);
    button.addEventListener("click", () => selectDoc(doc));
    button.addEventListener("contextmenu", (event) => openPinMenu(event, doc));
    nav.append(button);
  });
}

function pinRank(doc) {
  if (userPinned(doc)) return 0;
  if ((doc.pins || []).includes("accuracy")) return 1;
  if ((doc.pins || []).includes("pricing")) return 2;
  return 3;
}

function openPinMenu(event, doc) {
  event.preventDefault();
  closePinMenu();
  const menu = document.createElement("div");
  menu.className = "context-menu";
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;
  const action = document.createElement("button");
  action.type = "button";
  action.textContent = userPinned(doc) ? "Unpin" : "Pin";
  action.addEventListener("click", () => {
    if (userPinned(doc)) userPins.delete(doc.id);
    else userPins.add(doc.id);
    saveUserPins();
    closePinMenu();
    renderNav();
    const visible = [...nav.querySelectorAll("button")];
    const stillShown = visible.some((button) => button.classList.contains("on"));
    if (!stillShown && visible[0]) visible[0].click();
  });
  menu.append(action);
  document.body.append(menu);
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 8}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 8}px`;
}

function closePinMenu() {
  document.querySelectorAll(".context-menu").forEach((menu) => menu.remove());
}

function renderPreview(doc) {
  preview.replaceChildren();
  const pager = document.createElement("div");
  pager.className = "pager";
  const prev = document.createElement("button");
  prev.textContent = "Previous";
  prev.disabled = page <= 1;
  const label = document.createElement("span");
  label.textContent = `Page ${page} of ${doc.pages}`;
  const next = document.createElement("button");
  next.textContent = "Next";
  next.disabled = page >= doc.pages;
  prev.addEventListener("click", () => { page -= 1; renderPreview(doc); });
  next.addEventListener("click", () => { page += 1; renderPreview(doc); });
  pager.append(prev, label, next);
  const img = document.createElement("img");
  img.alt = `${doc.filename} page ${page}`;
  img.src = pageSrc(doc.id, page);
  preview.append(pager, img);
}

function renderScalar(field) {
  const row = document.createElement("tr");
  row.innerHTML =
    `<td class="field" title="${esc(field.description)}">${esc(field.name)}</td>` +
    cell(field.gemini, "") +
    cell(field.gemma, field.gemma_state) +
    cell(field.staging, field.staging_state, field.staging_confidence);
  return row;
}

function renderTable(field) {
  const wrap = document.createElement("details");
  wrap.className = "table-block";
  wrap.open = field.differs;
  const rows = diffsOnly.checked ? field.rows.filter((row) => row.differs) : field.rows;
  wrap.innerHTML =
    `<summary>${esc(field.name)}<span class="note">Gemini ${field.gemini_rows} rows · Gemma ${field.gemma_rows ?? "—"} · Staging ${field.staging_rows ?? "—"} · ${field.differing_rows} differ</span></summary>`;
  const body = document.createElement("div");
  body.className = "body";
  if (!rows.length) {
    body.innerHTML = '<p class="empty">No differing rows.</p>';
  }
  rows.slice(0, tableLimit).forEach((row) => {
    const cells = diffsOnly.checked ? row.cells.filter((c) => c.differs) : row.cells;
    if (!cells.length) return;
    const head = document.createElement("div");
    head.className = "rowhead";
    head.textContent = `Row ${row.index + 1}`;
    const table = document.createElement("table");
    table.className = "cmp";
    table.innerHTML = "<thead><tr><th>Column</th><th>Gemini 3.8 Flash</th><th>Gemma 31B</th><th>Staging advanced</th></tr></thead>";
    const tbody = document.createElement("tbody");
    cells.forEach((cellRow) => {
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td class="field">${esc(cellRow.name)}</td>` +
        cell(cellRow.gemini, "") +
        cell(cellRow.gemma, cellRow.gemma_state) +
        cell(cellRow.staging, cellRow.staging_state, cellRow.staging_confidence);
      tbody.append(tr);
    });
    table.append(tbody);
    body.append(head, table);
  });
  if (rows.length > tableLimit) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "more";
    more.textContent = `Show more rows (${tableLimit} of ${rows.length})`;
    more.addEventListener("click", () => {
      tableLimit += 20;
      const payload = compareCache.get(current.id);
      if (payload) renderCompare(payload);
    });
    body.append(more);
  }
  wrap.append(body);
  return wrap;
}

function renderCompare(doc) {
  compare.replaceChildren();
  const head = document.createElement("div");
  head.className = "cmp-head";
  const title = document.createElement("h2");
  title.textContent = doc.filename;
  const stats = document.createElement("div");
  stats.className = "stats";
  const chip = (label, value, bad) => {
    const span = document.createElement("span");
    span.className = "chip" + (bad ? " bad" : "");
    span.textContent = `${label} ${value}`;
    return span;
  };
  stats.append(
    chip("Fields differing", `${doc.fields_differing} / ${doc.fields_shown}`),
    chip("Gemma recall", pct(doc.gemma.recall), doc.gemma.status !== "completed"),
    chip("Staging recall", pct(doc.staging.recall), doc.staging.status !== "completed"),
    chip("Gemma time", doc.gemma.e2e_s ? `${doc.gemma.e2e_s}s` : "—"),
    chip("Staging time", doc.staging.e2e_s ? `${doc.staging.e2e_s}s` : "—"),
    chip("Sarvam confidence", pct(doc.staging_confidence)),
  );
  let pricing = null;
  if (doc.pricing) {
    pricing = document.createElement("dl");
    pricing.className = "price-card";
    const pages = doc.pricing.pages || 1;
    const pageLabel = pages === 1 ? "1 page" : `${pages} pages`;
    const rows = [
      ["Gemini 3.8 Flash", geminiLine(doc.pricing.gemini, pages)],
      ["Gemma 31B", tokenLine(doc.pricing.gemma, pages)],
      ["Sarvam", `₹${doc.pricing.sarvam_inr_per_page} / page · ${pageLabel} · ₹${doc.pricing.sarvam_inr}`],
    ];
    rows.forEach(([label, value]) => {
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = value;
      if (label === "Sarvam") dd.className = "rupee";
      pricing.append(dt, dd);
    });
  }
  const legend = document.createElement("p");
  legend.className = "legend";
  legend.textContent = "Green matches Gemini. Red differs. Amber is missing, extra, or a failed run. The square beside each Staging value is the Sarvam confidence: green 80% and above, amber 50–79%, red below 50%. Gemini dollars use the 1 Jan 2027 rate: $1.50 / 1M input tokens, $7.50 / 1M output tokens including thinking.";
  head.append(title, stats);
  if (doc.pricing) head.append(pricing);
  head.append(legend);
  ["gemma", "staging"].forEach((key) => {
    if (doc[key].error) {
      const p = document.createElement("p");
      p.className = "run-error";
      p.textContent = `${key === "gemma" ? "Gemma 31B" : "Staging"}: ${doc[key].error}`;
      head.append(p);
    }
  });
  compare.append(head);

  let any = false;
  doc.groups.forEach((group) => {
    const fields = group.fields.filter(visibleField);
    if (!fields.length) return;
    any = true;
    const section = document.createElement("section");
    section.className = "group";
    const h3 = document.createElement("h3");
    h3.textContent = group.name.replace(/_/g, " ");
    section.append(h3);
    const scalars = fields.filter((field) => field.kind !== "table");
    if (scalars.length) {
      const table = document.createElement("table");
      table.className = "cmp";
      table.innerHTML = "<thead><tr><th>Field</th><th>Gemini 3.8 Flash</th><th>Gemma 31B</th><th>Staging advanced</th></tr></thead>";
      const tbody = document.createElement("tbody");
      scalars.forEach((field) => tbody.append(renderScalar(field)));
      table.append(tbody);
      section.append(table);
    }
    fields.filter((field) => field.kind === "table").forEach((field) => section.append(renderTable(field)));
    compare.append(section);
  });
  if (!any) {
    const p = document.createElement("p");
    p.className = "placeholder";
    p.textContent = diffsOnly.checked ? "No differences on this document." : "No extracted fields.";
    compare.append(p);
  }
}

async function selectDoc(doc) {
  current = doc;
  page = 1;
  location.hash = encodeURIComponent(doc.id);
  renderNav();
  compare.innerHTML = '<p class="placeholder">Loading comparison…</p>';
  preview.innerHTML = "";
  let payload = compareCache.get(doc.id);
  if (!payload) {
    try {
      payload = STATIC
        ? await fetchJson(`data/compare/${encodeURIComponent(safeDocId(doc.id))}.json`)
        : await fetchJson(`/api/compare?id=${encodeURIComponent(doc.id)}`);
    } catch {
      compare.innerHTML = '<p class="placeholder">Could not load this document.</p>';
      return;
    }
    compareCache.set(doc.id, payload);
  }
  if (current !== doc) return;
  renderPreview(payload);
  renderCompare(payload);
}

async function loadType(typeId) {
  const data = STATIC
    ? await fetchJson(`data/docs/${encodeURIComponent(typeId)}.json`)
    : await fetchJson(`/api/docs?type=${encodeURIComponent(typeId)}`);
  docs = data.documents || [];
  const hashed = decodeURIComponent(location.hash.slice(1));
  const picked = docs.find((doc) => doc.id === hashed) || docs[0];
  if (picked) await selectDoc(picked);
  else {
    current = null;
    renderNav();
    compare.innerHTML = '<p class="placeholder">No documents in this type.</p>';
  }
}

document.addEventListener("click", (event) => {
  if (!event.target.closest(".context-menu")) closePinMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closePinMenu();
});
nav.addEventListener("scroll", closePinMenu);

typeSelect.addEventListener("change", () => loadType(typeSelect.value));
findInput.addEventListener("input", renderNav);
pinnedOnly.addEventListener("change", () => {
  renderNav();
  const visible = [...nav.querySelectorAll("button")];
  const stillShown = visible.some((button) => button.classList.contains("on"));
  if (!stillShown && visible[0]) visible[0].click();
});
diffsOnly.addEventListener("change", () => {
  if (current) {
    const payload = compareCache.get(current.id);
    if (payload) renderCompare(payload);
  }
});

async function boot() {
  const data = STATIC ? await fetchJson("data/types.json") : await fetchJson("/api/types");
  types = data.types || [];
  renderTypes();
  const hashed = decodeURIComponent(location.hash.slice(1));
  const fromHash = types.find((item) => hashed.startsWith(item.id + "/"));
  if (fromHash) typeSelect.value = fromHash.id;
  if (types.length) await loadType(typeSelect.value);
}

boot().catch((err) => {
  compare.innerHTML = `<p class="placeholder">Could not reach the server. ${esc(err)}</p>`;
});
