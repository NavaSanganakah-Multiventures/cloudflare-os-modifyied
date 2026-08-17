
const api = async (path, opts = {}) => {
  const res = await fetch(path, { ...opts, headers: { "Content-Type": "application/json", ...(opts.headers || {}) } });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.json();
};

function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else e.setAttribute(k, v);
  }
  for (const c of children) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  return e;
}

async function loadInstructions(panel) {
  panel.innerHTML = "";
  const data = await api("/admin/system-instructions");
  const ta = el("textarea", { class: "input", rows: 8 });
  ta.value = data.instructions;
  const btn = el("button", { class: "btn", text: "Save" });
  btn.addEventListener("click", async () => { await api("/admin/system-instructions", { method: "POST", body: JSON.stringify({ instructions: ta.value }) }); btn.textContent = "Saved!"; });
  panel.appendChild(el("h2", { text: "System Instructions" }));
  panel.appendChild(ta);
  panel.appendChild(btn);
}

async function loadKeys(panel) {
  panel.innerHTML = "";
  panel.appendChild(el("h2", { text: "API Keys" }));
  const name = el("input", { class: "input", placeholder: "Key name" });
  const create = el("button", { class: "btn", text: "Create" });
  const keyBox = el("div", { class: "keybox" });
  create.addEventListener("click", async () => {
    const d = await api("/admin/api-keys", { method: "POST", body: JSON.stringify({ name: name.value }) });
    keyBox.innerHTML = `<strong>New key:</strong> <code>${d.key}</code> (copy now)`;
    await loadKeys(panel);
  });
  panel.appendChild(el("div", { class: "row" }, [name, create]));
  panel.appendChild(keyBox);
  const d = await api("/admin/api-keys");
  const ul = el("ul");
  for (const k of d.keys) {
    const revoke = el("button", { class: "btn-small", text: "Revoke" });
    if (!k.active) revoke.disabled = true;
    revoke.addEventListener("click", async () => { await api("/admin/api-keys/revoke", { method: "POST", body: JSON.stringify({ hash: k.hash }) }); await loadKeys(panel); });
    ul.appendChild(el("li", {}, [el("span", { text: `${k.name} - ${k.active ? "active" : "revoked"} ` }), revoke]));
  }
  panel.appendChild(ul);
}

async function loadRepos(panel) {
  panel.innerHTML = "";
  panel.appendChild(el("h2", { text: "Connected Repos" }));
  const d = await api("/admin/repos");
  const ul = el("ul");
  for (const r of d.repos) ul.appendChild(el("li", { text: r }));
  panel.appendChild(ul);
}

async function loadDocs(panel) {
  panel.innerHTML = "";
  panel.appendChild(el("h2", { text: "API Docs" }));
  const pre = el("pre", { text: `fetch("/api/v1/query", {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-API-Key": "YOUR_KEY" },
  body: JSON.stringify({ query: "...", repoOwner: "owner", repoName: "repo" })
}).then(r => r.json());` });
  panel.appendChild(pre);
}

function init() {
  document.head.innerHTML = '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Developer API</title>';
  const style = document.createElement("style");
  style.textContent = `body { font-family: system-ui, sans-serif; margin: 0; background: #f4f6f8; } header { background: #111827; color: white; padding: 1rem; } .wrap { max-width: 900px; margin: 0 auto; padding: 1rem; } nav { display: flex; gap: 0.5rem; margin-bottom: 1rem; } nav button { padding: 0.5rem 1rem; border: none; background: white; border-radius: 6px; cursor: pointer; } nav button.active { background: #2563eb; color: white; } .panel { background: white; border-radius: 8px; padding: 1rem; } .input { width: 100%; padding: 0.5rem; margin: 0.5rem 0; border: 1px solid #d1d5db; border-radius: 6px; } .btn { padding: 0.5rem 1rem; background: #2563eb; color: white; border: none; border-radius: 6px; cursor: pointer; } .btn-small { padding: 0.25rem 0.5rem; background: #fee2e2; color: #991b1b; border: none; border-radius: 4px; cursor: pointer; } .row { display: flex; gap: 0.5rem; } .keybox { background: #f0fdf4; padding: 0.5rem; margin: 0.5rem 0; border-radius: 6px; } pre { background: #1f2937; color: #e5e7eb; padding: 0.75rem; overflow-x: auto; }`;
  document.head.appendChild(style);
  document.body.innerHTML = "";
  document.body.appendChild(el("header", {}, [el("h1", { text: "Developer API Gateway" }), el("p", { text: "System instructions · API keys · Connected repos · Docs" })]));
  const wrap = el("div", { class: "wrap" });
  const nav = el("nav");
  const panel = el("div", { class: "panel" });
  const tabs = [["instructions", "Instructions", loadInstructions], ["keys", "API Keys", loadKeys], ["repos", "Repos", loadRepos], ["docs", "Docs", loadDocs]];
  let active = "instructions";
  async function switchTab(id) {
    active = id;
    for (const b of nav.children) b.classList.toggle("active", b.dataset.tab === id);
    panel.innerHTML = "<p>Loading...</p>";
    await tabs.find(t => t[0] === id)[2](panel);
  }
  for (const [id, label, loader] of tabs) {
    const btn = el("button", { text: label });
    btn.dataset.tab = id;
    btn.addEventListener("click", () => switchTab(id));
    nav.appendChild(btn);
  }
  wrap.appendChild(nav);
  wrap.appendChild(panel);
  document.body.appendChild(wrap);
  switchTab(active);
}

init();
