const API_BASE = window.API_BASE_URL || "";

const loginView = document.getElementById("login-view");
const appView = document.getElementById("app-view");
const userArea = document.getElementById("user-area");
const repoList = document.getElementById("repo-list");

async function api(url, options = {}) {
  const res = await fetch(`${API_BASE}${url}`, {
    credentials: "include",
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.json();
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function renderUser(user) {
  userArea.innerHTML = `
    <div class="user-chip">
      <img src="${escapeHtml(user.avatar_url)}" alt="avatar" width="28" height="28" />
      <span>${escapeHtml(user.login)}</span>
      <a class="btn small" href="${API_BASE}/auth/logout">Logout</a>
    </div>
  `;
}

function buildTree(entries) {
  const root = { children: {} };
  for (const entry of entries) {
    const parts = entry.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const isLast = i === parts.length - 1;
      if (!node.children[name]) {
        node.children[name] = {
          name,
          type: isLast ? entry.type : "tree",
          path: parts.slice(0, i + 1).join("/"),
          children: {},
        };
      }
      node = node.children[name];
    }
  }
  return root.children;
}

function sortEntries(nodes) {
  return Object.values(nodes).sort((a, b) => {
    if (a.type !== b.type) return a.type === "tree" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function renderTree(nodes, depth = 0) {
  const ul = document.createElement("ul");
  ul.className = "tree";
  ul.style.marginLeft = depth === 0 ? "0" : "1.1em";

  for (const node of sortEntries(nodes)) {
    const li = document.createElement("li");
    li.className = "tree-item";

    if (node.type === "tree") {
      const toggle = document.createElement("span");
      toggle.className = "folder-toggle";
      toggle.textContent = "▸";
      toggle.addEventListener("click", () => {
        const child = li.querySelector(":scope > ul");
        const isOpen = child.style.display !== "none";
        child.style.display = isOpen ? "none" : "block";
        toggle.textContent = isOpen ? "▸" : "▾";
      });

      const icon = document.createElement("span");
      icon.className = "icon folder-icon";
      icon.textContent = "📁";

      const label = document.createElement("span");
      label.className = "folder-name";
      label.textContent = node.name;
      label.addEventListener("click", () => toggle.click());

      li.append(toggle, icon, label);
      const childUl = renderTree(node.children, depth + 1);
      childUl.style.display = "none";
      li.appendChild(childUl);
    } else {
      const icon = document.createElement("span");
      icon.className = "icon";
      icon.textContent = "📄";
      const name = document.createElement("span");
      name.className = "file-name";
      name.textContent = node.name;
      li.append(icon, name);
    }
    ul.appendChild(li);
  }
  return ul;
}

function renderTreeView(owner, repoName, data) {
  const container = document.createElement("div");
  container.className = "tree-view";

  const header = document.createElement("div");
  header.className = "tree-header";
  header.textContent = `${owner}/${repoName} (${data.default_branch})`;
  container.appendChild(header);

  const nodes = buildTree(data.tree.tree);
  const rootUl = renderTree(nodes);
  const rootItems = rootUl.querySelectorAll(":scope > li");
  if (rootItems.length > 0) {
    const firstFolder = rootUl.querySelector(":scope > li.tree-item");
    const childUl = firstFolder.querySelector(":scope > ul");
    if (childUl) {
      childUl.style.display = "block";
      firstFolder.querySelector(".folder-toggle").textContent = "▾";
    }
  }
  container.appendChild(rootUl);

  return container;
}

async function loadTree(repo, toggleBtn) {
  const existing = repo.nextElementSibling;
  if (existing && existing.classList.contains("tree-view")) {
    existing.remove();
    toggleBtn.textContent = "Show structure";
    return;
  }

  toggleBtn.textContent = "Loading...";
  try {
    const data = await api(`/api/repos/${repo.dataset.owner}/${repo.dataset.name}/tree`);
    repo.insertAdjacentElement("afterend", renderTreeView(repo.dataset.owner, repo.dataset.name, data));
    toggleBtn.textContent = "Hide structure";
  } catch (err) {
    toggleBtn.textContent = "Show structure";
    alert(err.message);
  }
}

function renderRepos(repos) {
  repoList.innerHTML = "";
  if (repos.length === 0) {
    repoList.innerHTML = '<p class="empty">No repositories found.</p>';
    return;
  }

  for (const repo of repos) {
    const card = document.createElement("div");
    card.className = "repo-card";
    card.dataset.owner = repo.owner.login;
    card.dataset.name = repo.name;

    const badge = repo.private
      ? '<span class="badge private">Private</span>'
      : '<span class="badge public">Public</span>';

    card.innerHTML = `
      <div class="repo-info">
        <div class="repo-title">
          <span class="repo-name">${escapeHtml(repo.full_name)}</span>
          ${badge}
        </div>
        ${repo.description ? `<p class="repo-desc">${escapeHtml(repo.description)}</p>` : ""}
        <div class="repo-meta">
          ${repo.language ? `<span>${escapeHtml(repo.language)}</span>` : ""}
          <span>⭐ ${repo.stargazers_count}</span>
          <span>${escapeHtml(repo.default_branch || "")}</span>
        </div>
      </div>
      <button class="btn small tree-btn">Show structure</button>
    `;

    card.querySelector(".tree-btn").addEventListener("click", (e) => {
      loadTree(card, e.currentTarget);
    });

    repoList.appendChild(card);
  }
}

async function init() {
  if (!window.API_BASE_URL) {
    document.body.insertAdjacentHTML(
      "afterbegin",
      '<div class="config-error">config.js not loaded — copy backend/public/config.example.js to backend/public/config.js and set window.API_BASE_URL to your deployed backend URL.</div>'
    );
    return;
  }
  document.getElementById("login-btn").href = `${API_BASE}/auth/github`;
  try {
    const user = await api("/auth/me");
    renderUser(user);
    loginView.classList.add("hidden");
    appView.classList.remove("hidden");
    const repos = await api("/api/repos");
    renderRepos(repos);
  } catch {
    appView.classList.add("hidden");
    loginView.classList.remove("hidden");
  }
}

init();
