import { Fragment, useEffect, useMemo, useState } from "react";
import { jsPDF } from "jspdf";
import "./App.css";

const API_BASE =
  import.meta.env.VITE_API_BASE_URL || "https://tsec-qjcg.onrender.com";
const tabs = [
  "Overview",
  "Issues",
  "Pull requests",
  "Commits",
  "Contributors",
  "Health",
];

async function parseJsonIfPossible(response) {
  const contentType = response.headers.get("content-type") || "";
  const rawText = await response.text();

  if (!rawText) return null;

  const trimmed = rawText.trim();
  if (
    !contentType.includes("application/json") &&
    !trimmed.startsWith("{") &&
    !trimmed.startsWith("[")
  ) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

async function api(path, options = {}) {
  const url = `${API_BASE}${path}`;
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: "include",
  });

  const body = await parseJsonIfPossible(response);

  if (!response.ok) {
    const errorMessage =
      (body && typeof body === "object" && (body.error || body.message)) ||
      `Request failed (${response.status}) at ${url}`;
    const requestError = new Error(errorMessage);
    requestError.status = response.status;
    throw requestError;
  }

  return body ?? {};
}

async function trendsApi(path, legacyPath) {
  try {
    return await api(path);
  } catch (error) {
    if (error.status !== 404) throw error;
    return api(legacyPath);
  }
}

function formatDate(value) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function Stat({ label, value }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong>{value ?? 0}</strong>
    </div>
  );
}

function generateRepositoryReport(details) {
  const { repo, issues = [], pulls = [], contributors = [], workflowStatuses = {}, escalationDecisions = {} } = details;
  const issueItems = issues.filter((item) => !item.pull_request);
  const openIssues = issueItems.filter((item) => item.state === "open").length;
  const closedIssues = issueItems.filter((item) => item.state === "closed").length;
  const openPulls = pulls.filter((item) => item.state === "open").length;
  const closedPulls = pulls.filter((item) => item.state === "closed").length;
  const mergedPulls = pulls.filter((item) => item.merged_at || item.merged).length;
  const totalComments = issueItems.reduce((total, issue) => total + Number(issue.comments || 0), 0);
  const oldestOpenIssue = issueItems
    .filter((issue) => issue.state === "open" && issue.created_at)
    .sort((first, second) => new Date(first.created_at) - new Date(second.created_at))[0];
  const decisions = Object.values(escalationDecisions || {});
  const attentionCount = decisions.filter((decision) => decision.needsAttention).length;
  const workflowValues = Object.values(workflowStatuses || {});
  const completedWorkflows = workflowValues.filter((status) => status === "complete").length;
  const activeWorkflows = workflowValues.filter((status) => ["running", "waiting_missing_info", "waiting_duplicate_info"].includes(status)).length;
  const codeAdditions = (details.codeFrequency || []).reduce((total, point) => total + Number(point[1] || 0), 0);
  const codeDeletions = (details.codeFrequency || []).reduce((total, point) => total + Math.abs(Number(point[2] || 0)), 0);
  const categoryCounts = issueItems.reduce((counts, issue) => {
    const category = issue.labels?.[0]?.name || "Other";
    counts[category] = (counts[category] || 0) + 1;
    return counts;
  }, {});
  const topCategories = Object.entries(categoryCounts).sort(([, first], [, second]) => second - first).slice(0, 5);
  const document = new jsPDF();
  const margin = 18;
  const pageWidth = document.internal.pageSize.getWidth();
  const pageHeight = document.internal.pageSize.getHeight();
  let y = 22;
  const line = (text, size = 10, color = [65, 61, 56]) => {
    document.setFontSize(size);
    document.setTextColor(...color);
    const wrapped = document.splitTextToSize(String(text), pageWidth - margin * 2);
    wrapped.forEach((part) => {
      if (y > pageHeight - 18) { document.addPage(); y = 22; }
      document.text(part, margin, y);
      y += size * 0.55 + 5;
    });
  };
  const section = (title) => {
    y += 5;
    line(title, 14, [211, 88, 48]);
    document.setDrawColor(225, 217, 207);
    document.line(margin, y - 2, pageWidth - margin, y - 2);
  };
  const card = (x, width, label, value, color) => {
    document.setFillColor(...color);
    document.roundedRect(x, y, width, 25, 3, 3, "F");
    document.setTextColor(255, 255, 255);
    document.setFontSize(17);
    document.text(String(value), x + 5, y + 11);
    document.setFontSize(8);
    document.text(label, x + 5, y + 19);
  };
  const bar = (label, value, total, color) => {
    if (y > pageHeight - 30) { document.addPage(); y = 22; }
    const barWidth = 105;
    const width = total ? Math.max(2, (value / total) * barWidth) : 2;
    document.setFontSize(9);
    document.setTextColor(65, 61, 56);
    document.text(label, margin, y + 4);
    document.setFillColor(235, 230, 223);
    document.roundedRect(margin + 48, y - 2, barWidth, 7, 2, 2, "F");
    document.setFillColor(...color);
    document.roundedRect(margin + 48, y - 2, width, 7, 2, 2, "F");
    document.text(`${value} (${total ? Math.round((value / total) * 100) : 0}%)`, margin + 160, y + 4);
    y += 14;
  };
  const linkLine = (text, url) => {
    if (y > pageHeight - 18) { document.addPage(); y = 22; }
    document.setFontSize(10);
    document.setTextColor(65, 61, 56);
    if (url) document.textWithLink(text, margin, y, { url });
    else document.text(text, margin, y);
    y += 10;
  };
  line("RepoGuardian", 10, [211, 88, 48]);
  line(`${repo.full_name} report`, 22, [35, 32, 29]);
  line(`Generated ${new Date().toLocaleString()}`, 9, [110, 104, 96]);
  if (repo.html_url) document.textWithLink("Open repository on GitHub", margin, y + 2, { url: repo.html_url });
  y += 12;
  card(margin, 41, "Issues", issueItems.length, [211, 88, 48]);
  card(margin + 45, 41, "Open", openIssues, [47, 158, 110]);
  card(margin + 90, 41, "Pull requests", pulls.length, [77, 121, 187]);
  card(margin + 135, 41, "Contributors", contributors.length, [126, 92, 170]);
  y += 35;
  section("Executive summary");
  const attentionText = attentionCount ? `${attentionCount} escalation${attentionCount === 1 ? "" : "s"} require maintainer attention.` : "No persisted escalations currently require maintainer attention.";
  line(`This report summarizes ${repo.full_name} using the repository data available at generation time.`);
  line(`The repository has ${openIssues} open issue${openIssues === 1 ? "" : "s"}, ${openPulls} open pull request${openPulls === 1 ? "" : "s"}, and ${contributors.length} contributor${contributors.length === 1 ? "" : "s"}. ${attentionText}`);
  line(`Automation coverage: ${completedWorkflows} completed workflow${completedWorkflows === 1 ? "" : "s"} and ${activeWorkflows} active or waiting workflow${activeWorkflows === 1 ? "" : "s"}.`);
  section("Repository snapshot");
  line(`Description: ${repo.description || "No description provided."}`);
  line(`Language: ${repo.language || "Not specified"}   Visibility: ${repo.private ? "Private" : "Public"}`);
  line(`Stars: ${repo.stargazers_count || 0}   Forks: ${repo.forks_count || 0}   Watchers: ${repo.subscribers_count || 0}`);
  section("Report scope and method");
  line("This report is a point-in-time operational summary generated from the repository details loaded in RepoGuardian.");
  line("Issue, pull request, contributor, workflow, escalation, and code-activity records are summarized as counts and proportions. Links in the report open the corresponding GitHub records.");
  line(`Coverage includes ${issueItems.length} issues, ${pulls.length} pull requests, ${contributors.length} contributors, and ${totalComments} issue comments.`);
  section("Key metrics");
  line(`Issues: ${issueItems.length} total (${openIssues} open, ${closedIssues} closed)`);
  line(`Pull requests: ${pulls.length} (${openPulls} open, ${closedPulls} closed, ${mergedPulls} merged)   Contributors: ${contributors.length}`);
  line(`Code activity in the loaded window: +${codeAdditions.toLocaleString()} additions / -${codeDeletions.toLocaleString()} deletions.`);
  section("Operational observations");
  if (oldestOpenIssue) line(`Oldest currently open issue: #${oldestOpenIssue.number} ${oldestOpenIssue.title}, opened ${new Date(oldestOpenIssue.created_at).toLocaleDateString()}.`);
  if (totalComments) line(`Discussion activity totals ${totalComments} comments across the loaded issue set.`);
  if (mergedPulls) line(`${mergedPulls} pull request${mergedPulls === 1 ? " has" : "s have"} recorded merge activity.`);
  if (!oldestOpenIssue && !totalComments && !mergedPulls) line("No additional operational observations were available in the loaded data.");
  section("Issue and PR health");
  bar("Open issues", openIssues, issueItems.length, [47, 158, 110]);
  bar("Closed issues", closedIssues, issueItems.length, [145, 137, 128]);
  bar("Open PRs", openPulls, pulls.length, [77, 121, 187]);
  bar("Closed PRs", closedPulls, pulls.length, [126, 92, 170]);
  section("Top issue categories");
  if (topCategories.length) topCategories.forEach(([category, count]) => bar(category, count, issueItems.length, [211, 88, 48]));
  else line("No categorized issues available.");
  section("Workflow and escalation signals");
  bar("Needs attention", attentionCount, Math.max(1, decisions.length), [211, 88, 48]);
  bar("Completed workflows", completedWorkflows, Math.max(1, workflowValues.length), [47, 158, 110]);
  bar("Active or waiting", activeWorkflows, Math.max(1, workflowValues.length), [77, 121, 187]);
  section("Recommended follow-up");
  if (attentionCount) line("Review escalated decisions first and use the linked issue records to approve or correct the agent outcome.");
  if (openIssues > closedIssues) line("Prioritize backlog review because open issues currently exceed closed issues.");
  if (openPulls) line("Review open pull requests alongside the issue queue to keep delivery work moving.");
  if (!attentionCount && openIssues <= closedIssues && !openPulls) line("No immediate operational follow-up was identified from the loaded repository signals.");
  section("Recent issues");
  issueItems.slice(0, 8).forEach((issue) => {
    const text = `#${issue.number} ${issue.title} — ${issue.state}`;
    linkLine(text, issue.html_url);
  });
  section("Recent pull requests");
  pulls.slice(0, 8).forEach((pull) => {
    const text = `#${pull.number} ${pull.title} — ${pull.state}`;
    linkLine(text, pull.html_url);
  });
  const totalPages = document.getNumberOfPages();
  for (let page = 1; page <= totalPages; page += 1) {
    document.setPage(page);
    document.setFontSize(8);
    document.setTextColor(130, 124, 116);
    document.text(`${repo.full_name} | RepoGuardian formal report`, margin, pageHeight - 9);
    document.text(`Page ${page} of ${totalPages}`, pageWidth - margin, pageHeight - 9, { align: "right" });
  }
  document.save(`${repo.name || "repository"}-report.pdf`);
}

function ReportButton({ details }) {
  const [generating, setGenerating] = useState(false);
  function downloadReport() {
    setGenerating(true);
    try {
      generateRepositoryReport(details);
    } finally {
      setGenerating(false);
    }
  }
  return <button className="outline-button report-button" type="button" onClick={downloadReport} disabled={generating}>{generating ? "Generating…" : "Generate PDF report ↓"}</button>;
}

function Avatar({ src, alt = "" }) {
  return src ? (
    <img className="avatar" src={src} alt={alt} />
  ) : (
    <span className="avatar avatar-fallback" aria-hidden="true">
      ?
    </span>
  );
}

function EmptyState({ children }) {
  return <div className="empty-state">{children}</div>;
}

function IssueRow({ item, pull = false, onClick, workflowStatus }) {
  const canOpenAnalysis = Boolean(workflowStatus);
  return (
    <button
      className="activity-row issue-button"
      type="button"
      disabled={!canOpenAnalysis}
      onClick={() => canOpenAnalysis && onClick?.(item)}
    >
      <span
        className={`state-dot ${item.state === "open" ? "open" : "closed"}`}
      >
        {pull ? "↗" : <GitHubMark />}
      </span>
      <div>
        <h3>{item.title}</h3>
        <p>
          #{item.number} opened by {item.user?.login || "unknown"} ·{" "}
          {formatDate(item.created_at)}
        </p>
      </div>
      <span className="row-state">{item.state}</span>
      <span className={`workflow-badge ${workflowStatus || "not-triggered"}`}>
        {workflowStatus ? workflowStatus.replaceAll("_", " ") : "not triggered"}
      </span>
      {canOpenAnalysis && <span className="issue-arrow">→</span>}
    </button>
  );
}

function GitHubMark() {
  return (
    <svg className="github-mark" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82A7.65 7.65 0 0 1 8 4.91c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}
function CommitRow({ commit, owner, repo }) {
  const [expanded, setExpanded] = useState(false);
  const [details, setDetails] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function toggleCommit() {
    setExpanded(!expanded);
    if (!details && !loading) {
      setLoading(true);
      try {
        setDetails(
          await api(`/api/repos/${owner}/${repo}/commits/${commit.sha}`),
        );
      } catch (requestError) {
        setError(requestError.message);
      } finally {
        setLoading(false);
      }
    }
  }

  return (
    <div className="commit-block">
      <button
        className="activity-row commit-button"
        type="button"
        onClick={toggleCommit}
      >
        <Avatar
          src={commit.author?.avatar_url || commit.committer?.avatar_url}
        />
        <div>
          <h3>{commit.commit.message.split("\n")[0]}</h3>
          <p>
            {commit.author?.login ||
              commit.commit.author?.name ||
              "Unknown author"}{" "}
            · {formatDate(commit.commit.author?.date)}
          </p>
        </div>
        <code>{commit.sha.slice(0, 7)}</code>
        <span className="commit-chevron">{expanded ? "⌃" : "⌄"}</span>
      </button>
      {expanded && (
        <div className="commit-details">
          {loading && <p className="detail-muted">Loading changed code...</p>}
          {error && <p className="detail-error">{error}</p>}
          {details && (
            <>
              {
                <div className="change-summary">
                  <span className="additions-text">
                    +{details.stats?.additions || 0}
                  </span>
                  <span className="deletions-text">
                    -{details.stats?.deletions || 0}
                  </span>
                  <span>{details.files?.length || 0} files changed</span>
                </div>
              }
              {details.files?.map((file) => (
                <div className="changed-file" key={file.filename}>
                  <div className="changed-file-heading">
                    <strong>{file.filename}</strong>
                    <span>
                      {file.status} · +{file.additions} -{file.deletions}
                    </span>
                  </div>
                  <pre>{file.patch || "No patch available for this file."}</pre>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ContributorRow({ contributor }) {
  const contributions = Number(contributor.contributions) || 0;
  const login =
    contributor.login || contributor.name || "Anonymous contributor";
  return (
    <article className="contributor-row">
      <Avatar src={contributor.avatar_url} alt={login} />
      <div>
        <h3>{login}</h3>
        <p>{contributions.toLocaleString()} contributions</p>
      </div>
      <div className="contribution-bar">
        <span style={{ width: `${Math.min(100, contributions / 2)}%` }} />
      </div>
    </article>
  );
}

function CodeChanges({ values, pending }) {
  const points = values.slice(-20);
  const max = Math.max(
    ...points.map((point) => Math.max(point[1], point[2])),
    1,
  );
  if (pending)
    return (
      <EmptyState>
        GitHub is still preparing code frequency data. Check again shortly.
      </EmptyState>
    );
  if (!points.length)
    return <EmptyState>No code frequency data available yet.</EmptyState>;
  return (
    <div className="chart">
      <div className="chart-bars">
        {points.map((point) => (
          <div
            className="bar-group"
            key={point[0]}
            title={`${point[1]} additions, ${Math.abs(point[2])} deletions`}
          >
            <span
              className="bar additions"
              style={{ height: `${(point[1] / max) * 100}%` }}
            />
            <span
              className="bar deletions"
              style={{ height: `${(Math.abs(point[2]) / max) * 100}%` }}
            />
          </div>
        ))}
      </div>
      <div className="chart-legend">
        <span>
          <i className="legend-additions" /> Additions
        </span>
        <span>
          <i className="legend-deletions" /> Deletions
        </span>
      </div>
    </div>
  );
}

function RepositoryChat({ owner, repo }) {
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const suggestions = [
    "Which issues are waiting for information?",
    "What problems were solved recently?",
    "Which PRs relate to security?",
  ];

  async function ask(event) {
    event.preventDefault();
    const value = question.trim();
    if (!value || loading) return;
    setQuestion("");
    setError("");
    setMessages((current) => [...current, { role: "user", text: value }]);
    setLoading(true);
    try {
      const result = await api(
        `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/chat`,
        { method: "POST", body: { question: value } },
      );
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          text: result.answer,
          sources: result.sources || [],
        },
      ]);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="repo-chat panel">
      <div className="chat-heading">
        <div>
          <p className="eyebrow">Repository memory</p>
          <h2>Ask about this repository</h2>
          <p>
            Search issues, pull requests, workflow decisions, and solved
            history.
          </p>
        </div>
        <span className="chat-status">RAG enabled</span>
      </div>
      <div className="chat-suggestions">
        {suggestions.map((suggestion) => (
          <button
            type="button"
            key={suggestion}
            onClick={() => setQuestion(suggestion)}
          >
            {suggestion}
          </button>
        ))}
      </div>
      <div className="chat-transcript" aria-live="polite">
        {!messages.length && (
          <EmptyState>
            Ask a repository question to see grounded history.
          </EmptyState>
        )}
        {messages.map((message, index) => (
          <div
            className={`chat-message ${message.role}`}
            key={`${message.role}-${index}`}
          >
            <span className="chat-role">
              {message.role === "user" ? "You" : "RepoGuardian"}
            </span>
            <p>{message.text}</p>
            {message.sources?.length > 0 && (
              <div className="chat-sources">
                {message.sources.map((source) => (
                  <span key={source.source}>{source.source}</span>
                ))}
              </div>
            )}
          </div>
        ))}
        {loading && (
          <div className="chat-message assistant">
            <span className="chat-role">RepoGuardian</span>
            <p className="chat-loading">Searching repository history...</p>
          </div>
        )}
      </div>
      {error && <p className="detail-error">{error}</p>}
      <form className="chat-form" onSubmit={ask}>
        <textarea
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="Ask about issues, PRs, fixes, or workflow history..."
          rows="2"
          maxLength="1200"
        />
        <button
          className="primary-button"
          type="submit"
          disabled={loading || !question.trim()}
        >
          {loading ? "Searching..." : "Ask"}
        </button>
      </form>
    </section>
  );
}

function RepositoryChatButton({ onClick, active }) {
  return (
    <button
      className={`repo-chat-launcher${active ? " active" : ""}`}
      type="button"
      onClick={onClick}
      aria-label="Open repository chatbot"
    >
      <span className="repo-chat-launcher-icon">✦</span>
      <span>
        <strong>Repository chatbot</strong>
        <small>Ask about issues, PRs, and history</small>
      </span>
      <span className="repo-chat-launcher-arrow">→</span>
    </button>
  );
}

const automaticAgents = [
  [
    "missingInfo",
    "Missing information",
    "Checks whether the report is actionable.",
  ],
  [
    "duplicate",
    "Duplicate check",
    "Compares the completed report with open issue history.",
  ],
  [
    "sensitivity",
    "Security sensitivity",
    "Scans for secrets and security concerns.",
  ],
  ["sentiment", "Sentiment", "Measures conversation tone and contention."],
  [
    "backlog",
    "Backlog context",
    "Places the issue in repository-wide work context.",
  ],
];

function statusLabel(status) {
  return status === "failed"
    ? "Error"
    : status === "complete"
      ? "Complete"
      : status === "running"
        ? "Running"
        : status === "waiting_duplicate_info"
          ? "Waiting for duplicate evidence"
          : status === "waiting_missing_info"
            ? "Waiting for reporter"
            : "Waiting";
}

function resultHighlights(result = {}) {
  const highlights = [];
  if (result.danger_score !== undefined)
    highlights.push(`Danger score: ${result.danger_score}/100`);
  if (result.priority_flag)
    highlights.push(`Priority: ${String(result.priority_flag).toLowerCase()}`);
  if (result.is_security_sensitive !== undefined)
    highlights.push(
      result.is_security_sensitive
        ? "Security concern detected"
        : "No security concern detected",
    );
  if (result.private_notification_required)
    highlights.push("Private notification requested");
  if (result.duplicate_confidence !== undefined)
    highlights.push(
      `Confidence: ${Math.round(Number(result.duplicate_confidence) * 100)}%`,
    );
  if (result.missing_fields?.length)
    highlights.push(
      `${result.missing_fields.length} details needed from reporter`,
    );
  if (result.matches?.length)
    highlights.push(`${result.matches.length} related issue matches`);
  if (result.issues_analyzed !== undefined)
    highlights.push(`${result.issues_analyzed} issues analyzed`);
  return highlights;
}

function resultEvidence(result = {}) {
  return (
    result.evidence ||
    result.matched_indicators ||
    result.missing_details ||
    result.evidence_gaps ||
    []
  );
}

function TrendChart({
  title,
  labels,
  values,
  color,
  format,
  markerIndex,
  projection,
  badge,
  releases,
}) {
  const w = 280;
  const h = 88;
  const pad = 8;
  const safe = values.map((v) => Number(v) || 0);
  const proj = projection ? projection.map((v) => Number(v) || 0) : [];
  const max = Math.max(...safe, ...proj, 1);
  const total = Math.max(1, safe.length + proj.length - 1);
  const step = (w - 2 * pad) / total;
  const xOf = (i) => pad + i * step;
  const yOf = (v) => h - pad - (v / max) * (h - 2 * pad);
  const pts = safe.map((v, i) => [xOf(i), yOf(v)]);
  const line = pts
    .map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");
  const last = pts[pts.length - 1];
  const area = `${line} L${last[0].toFixed(1)},${h - pad} L${pts[0][0].toFixed(1)},${h - pad} Z`;
  const projLine =
    proj.length > 0
      ? `M${last[0].toFixed(1)},${last[1].toFixed(1)} ${proj
          .map(
            (v, i) =>
              `L${xOf(safe.length + i).toFixed(1)},${yOf(v).toFixed(1)}`,
          )
          .join(" ")}`
      : "";
  const marker =
    markerIndex != null && markerIndex >= 0 && markerIndex < pts.length
      ? pts[markerIndex]
      : null;
  return (
    <div className="health-chart-card">
      <div className="health-chart-heading">
        <strong>{title}</strong>
        <span>
          {format ? format(safe[safe.length - 1]) : safe[safe.length - 1]}
          {badge && <em className="health-chart-badge">{badge}</em>}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="health-chart"
        role="img"
        aria-label={`${title} trend over ${labels.length} weeks`}
      >
        <path d={area} fill={color} opacity="0.14" />
        <path
          d={line}
          fill="none"
          stroke={color}
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {projLine && (
          <path
            d={projLine}
            fill="none"
            stroke={color}
            strokeWidth="1.6"
            strokeDasharray="3 3"
            opacity="0.7"
          />
        )}
        {pts.map(([x, y], i) => (
          <circle
            key={i}
            cx={x.toFixed(1)}
            cy={y.toFixed(1)}
            r="2.4"
            fill={color}
          >
            <title>{`${labels[i]}: ${format ? format(safe[i]) : safe[i]}`}</title>
          </circle>
        ))}
        {marker && (
          <g>
            <circle
              cx={marker[0].toFixed(1)}
              cy={marker[1].toFixed(1)}
              r="4.5"
              fill="none"
              stroke="#fff"
              strokeWidth="1.4"
            />
            <circle
              cx={marker[0].toFixed(1)}
              cy={marker[1].toFixed(1)}
              r="2.6"
              fill="#e5a13c"
            />
          </g>
        )}
        {(releases || []).map((release, i) => {
          const rx = xOf(release.weekIndex);
          return (
            <line
              key={`rel-${i}`}
              x1={rx.toFixed(1)}
              y1={pad}
              x2={rx.toFixed(1)}
              y2={h - pad}
              stroke="#f5f0eb"
              strokeWidth="1"
              strokeDasharray="2 3"
              opacity="0.55"
            >
              <title>{`release ${release.tag} — ${release.label}`}</title>
            </line>
          );
        })}
      </svg>
      <div className="health-chart-labels">
        <span>{labels[0]}</span>
        <span>{labels[labels.length - 1]}</span>
      </div>
    </div>
  );
}

function HealthScoreGauge({ score, status }) {
  const s = Math.max(0, Math.min(100, Number(score) || 0));
  const label =
    status || (s >= 80 ? "Healthy" : s >= 60 ? "Watch" : "Declining");
  const color =
    label === "Healthy" ? "#2f9e6e" : label === "Watch" ? "#e5a13c" : "#e5484d";
  const r = 34;
  const c = 2 * Math.PI * r;
  return (
    <div className="health-gauge">
      <div className="health-gauge-ring-wrap">
        <svg viewBox="0 0 96 96" className="health-gauge-ring">
          <circle
            cx="48"
            cy="48"
            r={r}
            fill="none"
            stroke="rgba(255,255,255,0.1)"
            strokeWidth="8"
          />
          <circle
            cx="48"
            cy="48"
            r={r}
            fill="none"
            stroke={color}
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={`${(s / 100) * c} ${c}`}
            transform="rotate(-90 48 48)"
          />
        </svg>
        <div className="health-gauge-value">
          <strong style={{ color }}>{s}</strong>
          <span>{label}</span>
        </div>
      </div>
      <div className="health-gauge-caption">
        <strong>Repository health score</strong>
        <span>
          {label === "Healthy"
            ? "All tracked metrics within baseline."
            : label === "Watch"
              ? "One or more metrics degrading — investigate."
              : "Multiple metrics declining — intervention needed."}
        </span>
      </div>
    </div>
  );
}

function projectSeries(values, points = 3) {
  const src = values.slice(-4);
  const n = src.length;
  if (n < 2) return [];
  const meanX = (n - 1) / 2;
  const meanY = src.reduce((a, b) => a + b, 0) / n;
  const denom = src.reduce((acc, v, i) => acc + (i - meanX) ** 2, 0);
  const slope = denom
    ? src.reduce((acc, v, i) => acc + (i - meanX) * (v - meanY), 0) / denom
    : 0;
  const last = src[n - 1];
  return Array.from({ length: points }, (_, i) =>
    Math.max(0, Math.round(last + slope * (i + 1))),
  );
}

function BacklogFlowChart({
  labels,
  opened,
  closed,
  backlog,
  color,
  releases,
}) {
  const w = 280;
  const h = 100;
  const pad = 8;
  const safeOpen = (opened || []).map((v) => Number(v) || 0);
  const safeClosed = (closed || []).map((v) => Number(v) || 0);
  const safeBacklog = (backlog || []).map((v) => Number(v) || 0);
  const net = safeOpen.map((v, i) => v - (safeClosed[i] || 0));
  const proj = projectSeries(safeBacklog);
  const max = Math.max(...safeOpen, ...safeClosed, ...safeBacklog, ...proj, 1);
  const step = (w - 2 * pad) / Math.max(1, safeOpen.length + proj.length - 1);
  const xOf = (i) => pad + i * step;
  const yOf = (v) => h - pad - (v / max) * (h - 2 * pad);
  const bottom = safeClosed.map((v, i) => [xOf(i), yOf(v)]);
  const top = safeOpen.map((v, i) => [xOf(i), yOf(v + (safeClosed[i] || 0))]);
  const stackedArea = `${bottom
    .map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ")} ${top
    .slice()
    .reverse()
    .map(([x, y]) => `L${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ")} Z`;
  const backlogPts = safeBacklog.map((v, i) => [xOf(i), yOf(v)]);
  const backlogLine = backlogPts
    .map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");
  const netPts = net.map((v, i) => [xOf(i), yOf(v)]);
  const netLine = netPts
    .map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");
  const projLine =
    proj.length > 0
      ? `M${backlogPts[backlogPts.length - 1][0].toFixed(1)},${backlogPts[backlogPts.length - 1][1].toFixed(1)} ${proj
          .map(
            (v, i) =>
              `L${xOf(safeOpen.length + i).toFixed(1)},${yOf(v).toFixed(1)}`,
          )
          .join(" ")}`
      : "";
  return (
    <div className="health-chart-card">
      <div className="health-chart-heading">
        <strong>Backlog flow (opened vs. closed)</strong>
        <span>{safeBacklog[safeBacklog.length - 1]} open</span>
      </div>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="health-chart"
        role="img"
        aria-label="Backlog flow: opened vs closed per week with backlog forecast"
      >
        <path d={stackedArea} fill="#2f9e6e" opacity="0.22" />
        <path
          d={stackedArea}
          fill="none"
          stroke="#2f9e6e"
          strokeWidth="1"
          opacity="0.5"
        />
        <path
          d={backlogLine}
          fill="none"
          stroke={color}
          strokeWidth="2"
          strokeLinejoin="round"
        />
        {projLine && (
          <path
            d={projLine}
            fill="none"
            stroke={color}
            strokeWidth="1.6"
            strokeDasharray="3 3"
            opacity="0.7"
          />
        )}
        <path
          d={netLine}
          fill="none"
          stroke="#ffffff"
          strokeWidth="1"
          strokeDasharray="2 4"
          opacity="0.45"
        />
        {netPts.map(([x, y], i) => (
          <circle
            key={`n${i}`}
            cx={x.toFixed(1)}
            cy={y.toFixed(1)}
            r="1.6"
            fill="#ffffff"
            opacity="0.5"
          >
            <title>{`${labels[i]}: net ${net[i] >= 0 ? "+" : ""}${net[i]} issues`}</title>
          </circle>
        ))}
        {(releases || []).map((release, i) => {
          const rx = xOf(release.weekIndex);
          return (
            <line
              key={`rel-${i}`}
              x1={rx.toFixed(1)}
              y1={pad}
              x2={rx.toFixed(1)}
              y2={h - pad}
              stroke="#f5f0eb"
              strokeWidth="1"
              strokeDasharray="2 3"
              opacity="0.55"
            >
              <title>{`release ${release.tag} — ${release.label}`}</title>
            </line>
          );
        })}
        {backlogPts.map(([x, y], i) => (
          <circle
            key={i}
            cx={x.toFixed(1)}
            cy={y.toFixed(1)}
            r="2"
            fill={color}
          >
            <title>{`${labels[i]}: backlog ${safeBacklog[i]}`}</title>
          </circle>
        ))}
      </svg>
      <div className="health-chart-legend">
        <span>
          <i style={{ background: color }} /> backlog size
        </span>
        <span>
          <i style={{ background: "#2f9e6e" }} /> opened
        </span>
        <span>
          <i style={{ background: "#3b82f6" }} /> closed
        </span>
        <span>
          <i style={{ background: "transparent", border: "1px dashed #fff" }} />{" "}
          forecast
        </span>
        <span>
          <i style={{ background: "transparent", border: "1px dotted #fff" }} />{" "}
          net change
        </span>
      </div>
      <div className="health-chart-labels">
        <span>{labels[0]}</span>
        <span>{labels[labels.length - 1]}</span>
      </div>
    </div>
  );
}

function ContributorStackChart({ labels, active, fresh }) {
  const w = 280;
  const h = 100;
  const pad = 8;
  const safeActive = (active || []).map((v) => Number(v) || 0);
  const safeFresh = (fresh || []).map((v) => Number(v) || 0);
  const safeReturning = safeActive.map((v, i) =>
    Math.max(0, v - (safeFresh[i] || 0)),
  );
  const max = Math.max(...safeActive, 1);
  const step = (w - 2 * pad) / Math.max(1, safeActive.length - 1);
  const xOf = (i) => pad + i * step;
  const yOf = (v) => h - pad - (v / max) * (h - 2 * pad);
  const bottom = safeFresh.map((v, i) => [xOf(i), yOf(v)]);
  const top = safeActive.map((v, i) => [xOf(i), yOf(v)]);
  const area = `${bottom
    .map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ")} ${top
    .slice()
    .reverse()
    .map(([x, y]) => `L${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ")} Z`;
  const newLine = safeFresh
    .map((v, i) => `${i ? "L" : "M"}${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`)
    .join(" ");
  return (
    <div className="health-chart-card">
      <div className="health-chart-heading">
        <strong>Contributor activity</strong>
        <span>{safeActive[safeActive.length - 1] ?? 0} active last week</span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="health-chart" role="img">
        <path d={area} fill="#a78bfa" opacity="0.18" />
        <path
          d={area}
          fill="none"
          stroke="#a78bfa"
          strokeWidth="1"
          opacity="0.5"
        />
        <path d={newLine} fill="none" stroke="#34d399" strokeWidth="1.6" />
        {safeActive.map((v, i) => (
          <circle
            key={i}
            cx={xOf(i).toFixed(1)}
            cy={yOf(v).toFixed(1)}
            r="2"
            fill="#a78bfa"
          >
            <title>{`${labels[i]}: ${safeReturning[i]} returning + ${safeFresh[i]} new`}</title>
          </circle>
        ))}
      </svg>
      <div className="health-chart-labels">
        <span>{labels[0]}</span>
        <span>{labels[labels.length - 1]}</span>
      </div>
      <div className="health-chart-labels">
        <span>
          <i style={{ background: "#a78bfa" }} /> returning
        </span>
        <span>
          <i style={{ background: "#34d399" }} /> new
        </span>
      </div>
    </div>
  );
}

function contributorIntensityBucket(count) {
  const value = Number(count) || 0;
  if (value <= 0) return "";
  if (value <= 2) return "low";
  if (value <= 5) return "mid";
  return "high";
}

function ContributorHeatmap({ rows, labels }) {
  if (!Array.isArray(rows) || !rows.length) return null;
  return (
    <div className="health-chart-card heatmap-card">
      <div className="health-chart-heading">
        <strong>Contributor heatmap</strong>
        <span>{rows.length} contributors · comments per week</span>
      </div>
      <div
        className="heatmap-grid"
        style={{
          gridTemplateColumns: `118px repeat(${labels.length}, minmax(0, 1fr))`,
        }}
      >
        <span className="heatmap-cell heatmap-head">contributor</span>
        {labels.map((l) => (
          <span className="heatmap-cell heatmap-head" key={l}>
            {l.length > 10 ? l.slice(0, 10) + "…" : l}
          </span>
        ))}
        {rows.map((row) => (
          <Fragment key={row.login}>
            <span className="heatmap-cell heatmap-user">@{row.login}</span>
            {(row.weeks || []).map((count, i) => (
              <span
                className={`heatmap-cell heatmap-dot ${contributorIntensityBucket(count)}`}
                key={i}
                title={`${row.login} — ${labels[i] || "?"}: ${count || 0} comments`}
              />
            ))}
          </Fragment>
        ))}
      </div>
      <div className="health-chart-labels heatmap-legend">
        <span>
          <i className="heatmap-swatch" /> none
        </span>
        <span>
          <i className="heatmap-swatch low" /> 1-2
        </span>
        <span>
          <i className="heatmap-swatch mid" /> 3-5
        </span>
        <span>
          <i className="heatmap-swatch high" /> 6+
        </span>
      </div>
    </div>
  );
}

const METRIC_CONFIG = [
  {
    key: "time_to_first_response_days",
    label: "Response time (days)",
    higherIsWorse: true,
    threshold: 1.5,
    zeroIsMissing: true,
  },
  {
    key: "backlog_size",
    label: "Backlog",
    higherIsWorse: true,
    threshold: 1.3,
  },
  {
    key: "incoming_volume",
    label: "Opened / week",
    higherIsWorse: true,
    threshold: 1.5,
  },
  {
    key: "issues_closed",
    label: "Closed / week",
    higherIsWorse: false,
    threshold: 0.67,
  },
  {
    key: "close_open_ratio",
    label: "Close/open ratio",
    higherIsWorse: false,
    threshold: 0.67,
  },
  {
    key: "duplicate_rate",
    label: "Duplicate %",
    higherIsWorse: true,
    threshold: 1.5,
  },
  {
    key: "pr_merge_latency_days",
    label: "PR latency (days)",
    higherIsWorse: true,
    threshold: 1.5,
    zeroIsMissing: true,
  },
  {
    key: "active_contributors",
    label: "Active contributors",
    higherIsWorse: false,
    threshold: 0.67,
  },
  {
    key: "new_contributors",
    label: "New contributors",
    higherIsWorse: false,
    threshold: 0.67,
  },
];

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (!n) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function metricStatus(config, series) {
  const values = series[config.key] || [];
  if (values.length < 5) return null;
  let baseline = values.slice(-6, -2);
  let recent = values.slice(-2);
  if (config.zeroIsMissing) {
    baseline = baseline.filter((v) => v > 0);
    recent = recent.filter((v) => v > 0);
    if (!baseline.length || !recent.length) return null;
  }
  const baseMed = median(baseline);
  const recMed = median(recent);
  if (!baseMed && !recMed) return null;
  const ratio =
    baseMed > 0 ? Math.min(recMed / baseMed, 10) : recMed > 0 ? 10 : 0;
  const worse = config.higherIsWorse
    ? ratio >= config.threshold
    : ratio <= config.threshold;
  const moved = config.higherIsWorse ? ratio > 1 : ratio < 1;
  return {
    baseline: Math.round(baseMed * 100) / 100,
    recent: Math.round(recMed * 100) / 100,
    ratio: Math.round(ratio * 100) / 100,
    status: worse ? "declining" : moved ? "watch" : "healthy",
  };
}

function HealthTrafficTable({ labels, series }) {
  const rows = METRIC_CONFIG.filter(
    (config) => Array.isArray(series[config.key]) && series[config.key].length,
  )
    .map((config) => ({ config, check: metricStatus(config, series) }))
    .filter((row) => row.check);
  if (!rows.length) return null;
  return (
    <div className="health-chart-card snapshot-card">
      <div className="health-chart-heading">
        <strong>Metric health</strong>
        <span>
          recent 2 weeks vs prior baseline · {labels[0]} →{" "}
          {labels[labels.length - 1]}
        </span>
      </div>
      <div className="snapshot-table">
        <div className="snapshot-row snapshot-head">
          <span>metric</span>
          <span>baseline</span>
          <span>recent</span>
          <span>trend</span>
        </div>
        {rows.map(({ config, check }) => (
          <div className="snapshot-row" key={config.key}>
            <span>{config.label}</span>
            <span>{check.baseline}</span>
            <span>
              <i className={`traffic-dot ${check.status}`} /> {check.recent}
            </span>
            <span className={`traffic-trend ${check.status}`}>
              {config.higherIsWorse
                ? check.ratio >= 1
                  ? `▲ ${check.ratio}x`
                  : `▼ ${check.ratio}x`
                : check.ratio <= 1
                  ? `▼ ${check.ratio}x`
                  : `▲ ${check.ratio}x`}{" "}
              {check.status}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function MetricDragBars({ series, labels }) {
  const [windowWeeks, setWindowWeeks] = useState(4);
  const handlePointer = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.max(
      0,
      Math.min(1, (event.clientX - rect.left) / rect.width),
    );
    setWindowWeeks(Math.max(2, Math.min(6, Math.round(ratio * 4) + 2)));
  };
  const rows = METRIC_CONFIG.filter(
    (config) =>
      Array.isArray(series[config.key]) && series[config.key].length >= 5,
  )
    .map((config) => {
      const values = series[config.key].map((v) => Number(v) || 0);
      let baseline = values.slice(-windowWeeks - 2, -2);
      let recent = values.slice(-2);
      if (config.zeroIsMissing) {
        baseline = baseline.filter((v) => v > 0);
        recent = recent.filter((v) => v > 0);
      }
      if (!baseline.length || !recent.length) return null;
      return { config, baseline: median(baseline), recent: median(recent) };
    })
    .filter(Boolean);
  const tick = windowWeeks - 2;
  return (
    <div className="health-chart-card drag-bars-card">
      <div className="health-chart-heading">
        <strong>Metric comparison</strong>
        <span>drag the handle to change the baseline window</span>
      </div>
      <div
        className="drag-bars-slider"
        role="slider"
        aria-label="baseline window weeks"
        aria-valuemin={2}
        aria-valuemax={6}
        aria-valuenow={windowWeeks}
        onPointerDown={handlePointer}
        onPointerMove={(event) => {
          if (event.buttons > 0) handlePointer(event);
        }}
      >
        <span className="drag-bars-track" />
        <span
          className="drag-bars-handle"
          style={{ left: `${(tick / 4) * 100}%` }}
        >
          <strong>{windowWeeks}</strong> wk baseline
        </span>
        <span className="drag-bars-range">
          <span>2</span>
          <span>3</span>
          <span>4</span>
          <span>5</span>
          <span>6</span>
        </span>
      </div>
      {rows.map(({ config, baseline, recent }) => {
        const check = metricStatus(config, series);
        const status = check?.status || "healthy";
        const max = Math.max(baseline, recent, 1);
        const colors = {
          healthy: "#2f9e6e",
          watch: "#e5a13c",
          declining: "#e5484d",
        };
        return (
          <div className="drag-bar-row" key={config.key}>
            <span className="drag-bar-label">{config.label}</span>
            <div className="drag-bar-tracks">
              <div className="drag-bar-track">
                <i
                  className="drag-bar baseline"
                  style={{ width: `${(baseline / max) * 100}%` }}
                />
              </div>
              <div className="drag-bar-track">
                <i
                  className="drag-bar recent"
                  style={{
                    width: `${(recent / max) * 100}%`,
                    background: colors[status],
                  }}
                />
              </div>
            </div>
            <span className="drag-bar-values">
              {baseline} → {recent}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function deriveHealthScore(trends) {
  let score = 100;
  (trends || []).forEach((trend) => {
    const ratio = Number(trend.change_ratio) || 0;
    if (trend.metric === "time_to_first_response_days")
      score -= ratio >= 3 ? 30 : 15;
    else if (trend.metric === "backlog_size") score -= ratio >= 1.5 ? 15 : 8;
    else if (trend.metric === "duplicate_rate") score -= 10;
    else if (trend.metric === "incoming_volume") score -= 5;
    else if (trend.metric === "active_contributors")
      score -= ratio <= 0.67 ? 15 : 8;
  });
  return Math.max(0, Math.min(100, Math.round(score)));
}

function isoWeekKey(isoString) {
  if (!isoString) return "";
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return "";
  const date = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function HealthOverviewChart({ series, labels }) {
  const metricConfigs = [
    { key: "time_to_first_response_days", label: "Response time", color: "#d66b61", suffix: " days" },
    { key: "backlog_size", label: "Backlog size", color: "#4d79bb", suffix: " issues" },
    { key: "incoming_volume", label: "Open issues", color: "#d99a32", suffix: " issues" },
    { key: "close_open_ratio", label: "Close rate", color: "#38a89d", suffix: "" },
  ];
  const metrics = metricConfigs
    .map((config) => ({ ...config, values: Array.isArray(series[config.key]) ? series[config.key] : [] }))
    .filter((config) => config.values.length > 1);
  if (!metrics.length || !labels.length) return null;

  const width = 760;
  const height = 260;
  const padding = { top: 20, right: 18, bottom: 38, left: 38 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const pointCount = Math.min(labels.length, ...metrics.map((metric) => metric.values.length));
  const visibleLabels = labels.slice(-pointCount);
  const x = (index) => padding.left + (pointCount === 1 ? plotWidth / 2 : (index / (pointCount - 1)) * plotWidth);
  const normalized = metrics.map((metric) => {
    const values = metric.values.slice(-pointCount);
    const max = Math.max(...values.map((value) => Number(value) || 0), 1);
    return { ...metric, values, max, points: values.map((value) => padding.top + plotHeight - ((Number(value) || 0) / max) * plotHeight) };
  });
  const labelsEvery = Math.max(1, Math.ceil(pointCount / 6));
  return (
    <section className="health-overview-chart-card">
      <div className="health-chart-heading">
        <div>
          <strong>Health over time</strong>
          <span>weekly metric movement · indexed to each metric&apos;s range</span>
        </div>
        <span>{visibleLabels[0]} → {visibleLabels[visibleLabels.length - 1]}</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="health-overview-chart" role="img" aria-label="Repository health metrics over time">
        {[0, 25, 50, 75, 100].map((value) => {
          const y = padding.top + plotHeight - (value / 100) * plotHeight;
          return <g key={value}><line className="health-overview-grid-line" x1={padding.left} x2={width - padding.right} y1={y} y2={y} /><text className="health-overview-axis-label" x={padding.left - 8} y={y + 4} textAnchor="end">{value}</text></g>;
        })}
        {normalized.map((metric) => (
          <g key={metric.key}>
            <polyline className="health-overview-line" points={metric.points.map((y, index) => `${x(index)},${y}`).join(" ")} stroke={metric.color} />
            {metric.points.map((y, index) => <circle key={`${metric.key}-${index}`} cx={x(index)} cy={y} r="2.6" fill={metric.color}><title>{`${visibleLabels[index]} · ${metric.label}: ${metric.values[index]}${metric.suffix}`}</title></circle>)}
          </g>
        ))}
        {visibleLabels.map((label, index) => index % labelsEvery === 0 ? <text className="health-overview-date-label" key={label} x={x(index)} y={height - 12} textAnchor="middle">{label}</text> : null)}
      </svg>
      <div className="health-overview-legend">
        {normalized.map((metric) => <span key={metric.key}><i style={{ background: metric.color }} />{metric.label}</span>)}
      </div>
    </section>
  );
}

function HealthTrendDetail({ result }) {
  const series = result.series || {};
  const labels = result.week_labels || [];
  const contributors = result.contributor_activity || [];
  const has = (key) => Array.isArray(series[key]) && series[key].length > 1;
  const last = (key) => {
    const values = series[key];
    return Array.isArray(values) && values.length
      ? values[values.length - 1]
      : 0;
  };
  const healthScore =
    result.health_score !== undefined
      ? result.health_score
      : deriveHealthScore(result.trends || []);
  const healthStatus =
    result.health_status ||
    (healthScore >= 80 ? "Healthy" : healthScore >= 60 ? "Watch" : "Declining");
  const responseTrend = (result.trends || []).find(
    (t) => t.metric === "time_to_first_response_days",
  );
  const responseMarker = responseTrend
    ? labels.indexOf(responseTrend.change_week)
    : undefined;
  const prLatency = series.pr_merge_latency_days || [];
  const showPr = has("pr_merge_latency_days") && prLatency.some((v) => v > 0);
  const releaseMarks = (result.releases || [])
    .map((release) => {
      const weekIndex = labels.indexOf(isoWeekKey(release.published_at));
      return weekIndex >= 0
        ? {
            tag: release.tag,
            label: isoWeekKey(release.published_at),
            weekIndex,
          }
        : null;
    })
    .filter(Boolean);
  const kpis = [
    {
      label: "Response time (latest)",
      value: has("time_to_first_response_days")
        ? `${last("time_to_first_response_days")} days`
        : "—",
    },
    {
      label: "Open backlog",
      value: has("backlog_size") ? `${Math.round(last("backlog_size"))}` : "—",
    },
    {
      label: "Opened / closed last week",
      value:
        has("incoming_volume") || has("issues_closed")
          ? `${Math.round(last("incoming_volume"))} / ${Math.round(last("issues_closed"))}`
          : "—",
    },
    {
      label: "Duplicate rate",
      value: has("duplicate_rate") ? `${last("duplicate_rate")}%` : "—",
    },
    {
      label: "Contributors (new last week)",
      value: has("active_contributors")
        ? `${Math.round(last("active_contributors"))} (${Math.round(last("new_contributors"))})`
        : "—",
    },
    {
      label: "PR merge latency",
      value: showPr ? `${last("pr_merge_latency_days")} days` : "—",
    },
  ];
  return (
    <div className="health-trend-detail">
      <div className="health-overview">
        <HealthScoreGauge score={healthScore} status={healthStatus} />
        <div className="health-kpis">
          {kpis.map((kpi) => (
            <div className="health-kpi" key={kpi.label}>
              <strong>{kpi.value}</strong>
              <span>{kpi.label}</span>
            </div>
          ))}
        </div>
      </div>
      {(result.causes?.length > 0 || result.trends?.length > 0) && (
        <div className="health-callout">
          <div className="health-callout-heading">Root-cause analysis</div>
          {result.causes?.length > 0 && (
            <div className="health-callout-causes">
              {result.causes.map((cause, i) => (
                <div className="health-callout-cause" key={i}>
                  <div>
                    <strong>{cause.cause}</strong>
                    <span className={`confidence ${cause.confidence || "low"}`}>
                      {cause.confidence || "low"}
                    </span>
                  </div>
                  {cause.evidence?.map((item) => (
                    <Markdown text={item} key={String(item)} />
                  ))}
                </div>
              ))}
            </div>
          )}
          {result.trends?.length > 0 && (
            <div className="health-trend-list">
              {result.trends.map((trend) => (
                <span className="health-trend-chip" key={trend.metric}>
                  {trend.display}: {trend.baseline_value} → {trend.recent_value}
                  {trend.change_week
                    ? ` (inflection ${trend.change_week})`
                    : ""}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      <HealthOverviewChart series={series} labels={labels} />
      <div className="health-chart-grid">
        {has("time_to_first_response_days") && (
          <TrendChart
            title="Median time-to-first-response"
            labels={labels}
            values={series.time_to_first_response_days}
            color="#e5484d"
            format={(v) => `${v} days`}
            markerIndex={responseMarker}
            badge={
              responseTrend &&
              responseTrend.recent_value > responseTrend.baseline_value
                ? `degrading since ${responseTrend.change_week}`
                : undefined
            }
            releases={releaseMarks}
          />
        )}
        {has("backlog_size") && (
          <BacklogFlowChart
            labels={labels}
            opened={series.incoming_volume}
            closed={series.issues_closed}
            backlog={series.backlog_size}
            color="#8e4ec6"
            releases={releaseMarks}
          />
        )}
        {has("duplicate_rate") && (
          <TrendChart
            title="Duplicate rate"
            labels={labels}
            values={series.duplicate_rate}
            color="#e5a13c"
            format={(v) => `${v}%`}
            projection={projectSeries(series.duplicate_rate)}
            releases={releaseMarks}
          />
        )}
        {showPr && (
          <TrendChart
            title="PR merge latency"
            labels={labels}
            values={series.pr_merge_latency_days}
            color="#0ea5e9"
            format={(v) => `${v} days`}
            projection={projectSeries(series.pr_merge_latency_days)}
            releases={releaseMarks}
          />
        )}
        {has("active_contributors") && (
          <ContributorStackChart
            labels={labels}
            active={series.active_contributors}
            fresh={series.new_contributors}
          />
        )}
        {has("close_open_ratio") && (
          <TrendChart
            title="Close rate / open rate"
            labels={labels}
            values={series.close_open_ratio}
            color="#14b8a6"
            format={(v) => `${v}`}
            projection={projectSeries(series.close_open_ratio)}
            releases={releaseMarks}
          />
        )}
        {has("incoming_volume") && (
          <TrendChart
            title="Incoming issues / week"
            labels={labels}
            values={series.incoming_volume}
            color="#2f9e6e"
            format={(v) => `${v}`}
            releases={releaseMarks}
          />
        )}
      </div>
      <MetricDragBars series={series} labels={labels} />
      <ContributorHeatmap
        rows={result.contributor_matrix || []}
        labels={labels}
      />
      <HealthTrafficTable labels={labels} series={series} />
      {contributors.length > 0 && (
        <div className="result-list">
          <strong>Contributor activity</strong>
          {contributors.slice(0, 8).map((contributor) => (
            <div className="evidence-row" key={contributor.login}>
              <span
                className={`evidence-mark ${contributor.inactive ? "inactive" : ""}`}
              >
                {contributor.inactive ? "◌" : "✓"}
              </span>
              <span>
                @{contributor.login} · {contributor.comments} comments ·{" "}
                {contributor.inactive
                  ? `inactive ~${contributor.last_active_days_ago} days`
                  : `active ${contributor.last_active_days_ago} days ago`}
                {contributor.last_comment_url ? (
                  <a
                    href={contributor.last_comment_url}
                    target="_blank"
                    rel="noreferrer"
                    className="last-comment-link"
                  >
                    last comment
                  </a>
                ) : null}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function HealthPanel({ owner, repo }) {
  const [run, setRun] = useState(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");

  const fetchRun = () => {
    api(
      `/api/agents/health-run?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}`,
    )
      .then((data) => setRun(data))
      .catch(() => setRun(null));
  };

  useEffect(() => {
    fetchRun();
  }, [owner, repo]);

  useEffect(() => {
    if (run?.status !== "running") return undefined;
    const timer = setInterval(fetchRun, 3000);
    return () => clearInterval(timer);
  }, [run?.status, owner, repo]);

  const runHealth = async () => {
    setStarting(true);
    setError("");
    try {
      await api("/api/agents/health-run", {
        method: "POST",
        body: { owner, repo },
      });
      fetchRun();
    } catch {
      setError("Failed to start the health sweep.");
    }
    setStarting(false);
  };

  const result = run?.result;
  return (
    <div className="panel health-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Scheduled agent</p>
          <h2>Health-Trend Investigator</h2>
        </div>
        <span className="count-label">
          weekly sweep · response time · backlog · contributors
        </span>
      </div>
      <div className="health-panel-toolbar">
        <span className={`agent-status ${run?.status || "idle"}`}>
          {run?.status || "idle"}
        </span>
        <button
          className="outline-button"
          type="button"
          onClick={runHealth}
          disabled={starting || run?.status === "running"}
        >
          {run?.status === "running" || starting
            ? "Running…"
            : "Run health sweep"}
        </button>
      </div>
      {error && <p className="detail-error">{error}</p>}
      {run?.status === "running" && (
        <div className="waiting-detail">
          <span className="waiting-orbit">◌</span>
          <strong>Running weekly health sweep…</strong>
          <p>
            Fetching issues, pull requests, and contributor activity across the
            repository. This can take a minute.
          </p>
        </div>
      )}
      {run?.status === "complete" && result && (
        <div className="health-panel-result">
          {result.health_summary && (
            <div className="result-recommendation health-narrative">
              <Markdown text={result.health_summary} />
            </div>
          )}
          <HealthTrendDetail result={result} />
        </div>
      )}
      {run?.status === "failed" && (
        <div className="waiting-detail">
          <span className="waiting-orbit">✕</span>
          <strong>Health sweep failed</strong>
          <p>{run.error}</p>
        </div>
      )}
      {(run?.status === "idle" || !run) && (
        <div className="waiting-detail">
          <span className="waiting-orbit">♥</span>
          <strong>No health sweep run yet</strong>
          <p>
            Run the Health-Trend Investigator to see the repository health
            dashboard with trend charts and root-cause analysis.
          </p>
        </div>
      )}
    </div>
  );
}

function SweepsPanel({ owner, repo }) {
  const [data, setData] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const fetchStatus = () => {
    api("/api/agents/sweeps")
      .then(setData)
      .catch(() => setData(null));
  };
  useEffect(() => {
    fetchStatus();
  }, [owner, repo]);
  const runNow = async () => {
    setRunning(true);
    setError("");
    try {
      await api("/api/agents/sweeps/run", {
        method: "POST",
        body: { owner, repo },
      });
      fetchStatus();
    } catch {
      setError("Failed to run the staleness sweep.");
    }
    setRunning(false);
  };
  const myRun = data?.staleness_runs?.find(
    (run) => run.owner === owner && run.repo === repo,
  );
  const history = data?.history || [];
  return (
    <div className="panel health-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Scheduled sweeps</p>
          <h2>Staleness monitor</h2>
        </div>
        <span className="count-label">
          {data?.tracked_repos ?? 0} tracked repos · every 6h
        </span>
      </div>
      <div className="health-panel-toolbar">
        <span className={`agent-status ${myRun?.status || "idle"}`}>
          {myRun?.status || "idle"}
        </span>
        <button
          className="outline-button"
          type="button"
          onClick={runNow}
          disabled={running || myRun?.status === "running"}
        >
          {running || myRun?.status === "running"
            ? "Sweeping…"
            : "Run staleness sweep"}
        </button>
      </div>
      {error && <p className="detail-error">{error}</p>}
      {myRun && (
        <div className="staleness-run">
          <div className="staleness-run-heading">
            <strong>
              Last sweep{" "}
              {myRun.completedAt
                ? `finished ${new Date(myRun.completedAt).toLocaleString()}`
                : "in progress"}
            </strong>
            {myRun.error && <p className="detail-error">{myRun.error}</p>}
          </div>
          {myRun.crossers?.length > 0 ? (
            <table className="staleness-table">
              <thead>
                <tr>
                  <th>Issue</th>
                  <th>Reason</th>
                  <th>Days open</th>
                </tr>
              </thead>
              <tbody>
                {myRun.crossers.map((crosser) => (
                  <tr key={crosser.number}>
                    <td>
                      <strong>#{crosser.number}</strong> {crosser.title}
                    </td>
                    <td>
                      <span className={`agent-status ${crosser.reason}`}>
                        {crosser.reason}
                      </span>
                    </td>
                    <td>{crosser.days_open}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="staleness-clean">
              No issues crossed the staleness threshold in the latest sweep.
            </p>
          )}
        </div>
      )}
      {history.length > 0 && (
        <div className="sweep-history">
          <strong>Recent sweeps</strong>
          <ul>
            {history.slice(0, 6).map((sweep, index) => (
              <li key={`${sweep.owner}/${sweep.repo}-${index}`}>
                <span className={`agent-status ${sweep.status}`}>
                  {sweep.status}
                </span>
                <span>
                  {sweep.owner}/{sweep.repo} · {sweep.type} ·{" "}
                  {sweep.crossers.length} crossers
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

const BACKLOG_ACTIONS = {
  auto_close: { label: "Auto-Close", icon: "⚠️", cls: "danger" },
  nudge_reporter: { label: "Nudge Reporter", icon: "💬", cls: "warning" },
  escalate: { label: "Escalate", icon: "🚨", cls: "danger" },
  keep_open: { label: "Keep Open", icon: "✅", cls: "ok" },
};

function BacklogDetail({ result }) {
  const items = result.analysis_results || [];
  return (
    <div className="backlog-detail">
      {items.length > 0 && (
        <div className="backlog-action-list">
          {items.map((item) => {
            const action = BACKLOG_ACTIONS[item.action_recommendation] || {
              label: item.action_recommendation || "Unknown",
              icon: "•",
              cls: "ok",
            };
            return (
              <div className="backlog-action-card" key={item.issue_number}>
                <div className="backlog-action-heading">
                  <span className="issue-number">#{item.issue_number}</span>
                  <span className={`backlog-action-badge ${action.cls}`}>
                    {action.icon} {action.label}
                  </span>
                </div>
                <p>
                  {item.is_blocked
                    ? `Blocked by ${item.blocked_by}`
                    : "Not blocked"}{" "}
                  — {item.reasoning}
                </p>
                {item.suggested_comment && (
                  <pre className="suggested-comment">
                    {item.suggested_comment}
                  </pre>
                )}
              </div>
            );
          })}
        </div>
      )}
      {result.report && (
        <details className="backlog-report">
          <summary>Sweep report (markdown)</summary>
          <Markdown text={result.report} />
        </details>
      )}
    </div>
  );
}

function renderInline(text) {
  const tokens = String(text).split(
    /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g,
  );
  return tokens.map((token, i) => {
    if (token.startsWith("**") && token.endsWith("**") && token.length > 4)
      return <strong key={i}>{token.slice(2, -2)}</strong>;
    if (token.startsWith("`") && token.endsWith("`") && token.length > 2)
      return <code key={i}>{token.slice(1, -1)}</code>;
    const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link)
      return (
        <a key={i} href={link[2]} target="_blank" rel="noreferrer">
          {link[1]}
        </a>
      );
    return token;
  });
}

function Markdown({ text }) {
  if (!text) return null;
  const lines = String(text).replace(/\r/g, "").split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const code = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) {
        code.push(lines[i]);
        i += 1;
      }
      i += 1;
      blocks.push(
        <pre className="md-code" key={blocks.length}>
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    if (/^\s*(?:\.{3}|…+)\s*$/.test(line)) {
      i += 1;
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const Tag = level === 1 ? "h4" : level === 2 ? "h5" : "h6";
      blocks.push(
        <Tag className="md-heading" key={blocks.length}>
          {renderInline(heading[2])}
        </Tag>,
      );
      i += 1;
      continue;
    }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      blocks.push(<hr className="md-rule" key={blocks.length} />);
      i += 1;
      continue;
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        items.push(
          <li key={items.length}>
            {renderInline(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, ""))}
          </li>,
        );
        i += 1;
      }
      blocks.push(
        <ul className="md-list" key={blocks.length}>
          {items}
        </ul>,
      );
      continue;
    }
    if (!line.trim()) {
      i += 1;
      continue;
    }
    blocks.push(
      <p className="md-paragraph" key={blocks.length}>
        {renderInline(line)}
      </p>,
    );
    i += 1;
  }
  return <div className="md-block">{blocks}</div>;
}

function AgentCardSummary({ agent }) {
  const result = agent.result || {};
  const highlights = resultHighlights(result);
  const evidence = resultEvidence(result);
  const recommendation =
    result.recommendation ||
    result.summary ||
    result.reasoning ||
    result.draft_comment ||
    result.report;
  return (
    <div className="agent-card-summary">
      {highlights.length > 0 && (
        <div className="result-highlights">
          {highlights.map((highlight) => (
            <span key={highlight}>{highlight}</span>
          ))}
        </div>
      )}
      {recommendation && <Markdown text={recommendation} />}
      {evidence.length > 0 && (
        <ul className="md-list">
          {evidence.slice(0, 3).map((item, i) => (
            <li key={i}>{renderInline(String(item))}</li>
          ))}
        </ul>
      )}
      {agent.key === "backlog" && Array.isArray(result.analysis_results) && (
        <p className="card-note">
          {result.analysis_results.length} issues analyzed — open the agent
          detail for recommended actions.
        </p>
      )}
    </div>
  );
}

function AgentResultDetail({ agent }) {
  const result = agent.result || {};
  const evidence = resultEvidence(result);
  const highlights = resultHighlights(result);
  const recommendation =
    agent.key === "backlog"
      ? result.summary || result.reasoning || ""
      : result.recommendation ||
        result.draft_comment ||
        result.report ||
        result.summary ||
        result.reasoning;
  const matches = result.matches?.slice(0, 4) || [];
  return (
    <div className="agent-detail-body">
      {highlights.length > 0 && (
        <div className="result-highlights">
          {highlights.map((highlight) => (
            <span key={highlight}>{highlight}</span>
          ))}
        </div>
      )}
      {recommendation && (
        <div className="result-recommendation">
          <Markdown text={recommendation} />
        </div>
      )}
      {agent.key === "health" && result.health_summary && (
        <div className="result-recommendation health-narrative">
          <Markdown text={result.health_summary} />
        </div>
      )}
      {agent.key === "backlog" &&
        (result.analysis_results || result.report) && (
          <BacklogDetail result={result} />
        )}
      {agent.key === "health" &&
        (result.series || result.contributor_activity) && (
          <HealthTrendDetail result={result} />
        )}
      {matches.length > 0 && (
        <div className="result-list">
          <strong>Related issues</strong>
          {matches.map((match) => (
            <div
              className="result-list-row"
              key={match.issue_number || match.url || match.title}
            >
              <span>
                #{match.issue_number || "—"} {match.title || "Issue match"}
              </span>
              <em>
                {match.classification?.replaceAll("_", " ") ||
                  `${Math.round((match.similarity_score || 0) * 100)}% match`}
              </em>
            </div>
          ))}
        </div>
      )}
      {evidence.length > 0 && (
        <div className="result-list">
          <strong>Evidence and signals</strong>
          {evidence.slice(0, 6).map((item) => (
            <div className="evidence-row" key={String(item)}>
              <span className="evidence-mark">✓</span>
              <span>
                {typeof item === "string" ? (
                  renderInline(item)
                ) : (
                  <Markdown text={JSON.stringify(item)} />
                )}
              </span>
            </div>
          ))}
        </div>
      )}
      {!highlights.length &&
        !recommendation &&
        !matches.length &&
        !evidence.length && (
          <p className="detail-muted">
            The agent completed without additional findings.
          </p>
        )}
    </div>
  );
}

function CentralAnalysisDashboard({
  owner,
  repo,
  issue,
  analysis,
  agents,
  complete,
  failed,
  error,
  notTriggered,
  escalation,
  moderator,
  onModeratorAction,
  onFeedback,
  onClose,
}) {
  const [activeAgent, setActiveAgent] = useState("sensitivity");
  const [showContributor, setShowContributor] = useState(false);
  const active = agents.find((agent) => agent.key === activeAgent) || agents[0];
  const running = agents.filter((agent) => agent.status === "running").length;
  const security =
    agents.find((agent) => agent.key === "sensitivity")?.result || {};
  const dangerScore = Math.max(
    0,
    Math.min(100, Number(security.danger_score || 0)),
  );
  const status =
    analysis?.status === "complete"
      ? "Ready"
      : analysis?.status === "waiting_missing_info"
        ? "Waiting for reporter"
        : analysis?.status === "waiting_duplicate_info"
          ? "Waiting for duplicate evidence"
          : "Running";
  return (
    <div
      className="analysis-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`Triage dashboard for issue ${issue.number}`}
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div className="analysis-workspace">
        <header className="analysis-workspace-header">
          <div className="analysis-brand">
            <span className="brand-symbol">◈</span>
            <div>
              <strong>RepoGuardian</strong>
              <span>Automatic triage workspace</span>
            </div>
          </div>
          <div className="analysis-header-actions">
            <span className={`live-indicator ${running ? "is-running" : ""}`}>
              <i />
              {running ? "Live analysis" : "Analysis updated"}
            </span>
            <button
              className="close-button"
              type="button"
              onClick={onClose}
              aria-label="Close analysis"
            >
              ×
            </button>
          </div>
        </header>
        <div className="analysis-workspace-layout">
          <aside className="analysis-sidebar">
            <button className="analysis-back" type="button" onClick={onClose}>
              ← Back to issues
            </button>
            <div className="analysis-issue-nav">
              <span className="issue-number">#{issue.number}</span>
              <strong>{issue.title}</strong>
              <span>{issue.user?.login || "Issue reporter"}</span>
              {escalation && !escalation.pending && (
                <span
                  className={`escalation-sidebar-badge ${escalation.needsAttention ? "attention" : "handled"}`}
                >
                  {escalation.needsAttention
                    ? "Needs attention"
                    : "Auto-handled"}
                </span>
              )}
            </div>
            <nav className="analysis-agent-nav" aria-label="Agent analyses">
              {agents.map((agent) => (
                <button
                  className={active?.key === agent.key ? "active" : ""}
                  type="button"
                  key={agent.key}
                  onClick={() => {
                    setShowContributor(false);
                    setActiveAgent(agent.key);
                  }}
                >
                  <span className={`nav-agent-icon ${agent.status}`}>
                    {agent.status === "complete"
                      ? "✓"
                      : agent.status === "failed"
                        ? "!"
                        : agent.status === "running"
                          ? "·"
                          : "○"}
                  </span>
                  <span>
                    <strong>{agent.label}</strong>
                    <small>{statusLabel(agent.status)}</small>
                  </span>
                </button>
              ))}
              <button
                className={showContributor ? "active" : ""}
                type="button"
                onClick={() => setShowContributor(true)}
              >
                <span className="nav-agent-icon contributor">◎</span>
                <span>
                  <strong>Contributor match</strong>
                  <small>on demand</small>
                </span>
              </button>
            </nav>
          </aside>
          <main className="analysis-main">
            <div className="analysis-main-heading">
              <div>
                <p className="eyebrow">Issue triage</p>
                <h1>
                  #{issue.number} {issue.title}
                </h1>
                <p>
                  Centralized view of every automated decision and live workflow
                  signal.
                </p>
              </div>
              <span className="analysis-status-chip">{status}</span>
            </div>
            {notTriggered ? (
              <div className="not-triggered-panel">
                <h3>Automatic analysis was not triggered</h3>
                <p>
                  This issue was created before automatic analysis was enabled.
                  Agents will run automatically for newly created issues and
                  future issue changes.
                </p>
              </div>
            ) : (
              <>
                <section className="analysis-overview-grid">
                  <article className="issue-summary-card">
                    <p className="eyebrow">Issue summary</p>
                    <h2>{issue.title}</h2>
                    <p>{issue.body || "No description provided."}</p>
                    <div className="issue-meta">
                      <span>#{issue.number}</span>
                      <span>{issue.state || "open"}</span>
                      <span>{issue.user?.login || "Unknown reporter"}</span>
                    </div>
                  </article>
                  <article className="risk-card">
                    <div className="risk-card-heading">
                      <div>
                        <p className="eyebrow">Security risk</p>
                        <h2>
                          {dangerScore}
                          <small>/100</small>
                        </h2>
                      </div>
                      <span
                        className={`risk-dot ${dangerScore >= 70 ? "high" : dangerScore >= 30 ? "medium" : "low"}`}
                      />
                    </div>
                    <div className="risk-meter">
                      <span style={{ width: `${dangerScore}%` }} />
                    </div>
                    <p>
                      {security.private_notification_required
                        ? "Private notification requested"
                        : security.is_security_sensitive
                          ? "Security concern detected"
                          : "No security concern detected"}
                    </p>
                  </article>
                  <article
                    className={`escalation-card ${escalation?.needsAttention ? "attention" : escalation?.pending === false ? "handled" : "pending"}`}
                  >
                    <p className="eyebrow">Escalation status</p>
                    {escalation?.pending !== false ? (
                      <>
                        <h2>
                          Waiting on{" "}
                          {escalation?.missingCategories?.length ||
                            agents.filter(
                              (agent) => agent.status !== "complete",
                            ).length}{" "}
                          more agents
                        </h2>
                        <p>
                          Maintainer attention will be evaluated after all six
                          agent reports arrive.
                        </p>
                      </>
                    ) : escalation.needsAttention ? (
                      <>
                        <h2>Needs Maintainer Attention</h2>
                        <p>
                          Triggered by:{" "}
                          {escalation.triggeringCategories
                            .join(", ")
                            .replaceAll("_", " ")}{" "}
                          · {Math.round(escalation.aggregateConfidence * 100)}%
                          aggregate confidence
                        </p>
                        {escalation.notificationSent && (
                          <small className="notification-confirmation">
                            ✓ Maintainers notified via email
                          </small>
                        )}
                      </>
                    ) : (
                      <>
                        <h2>Auto-handled</h2>
                        <p>
                          No action needed ·{" "}
                          {Math.round(escalation.aggregateConfidence * 100)}%
                          aggregate confidence
                        </p>
                      </>
                    )}
                  </article>
                </section>
                <section className="analysis-metric-strip">
                  <div>
                    <strong>
                      {complete}/{agents.length}
                    </strong>
                    <span>agents complete</span>
                  </div>
                  <div>
                    <strong>{running}</strong>
                    <span>running right now</span>
                  </div>
                  <div>
                    <strong>{failed}</strong>
                    <span>errors</span>
                  </div>
                  <div>
                    <strong>{analysis?.step || 0}</strong>
                    <span>workflow step</span>
                  </div>
                </section>
                {escalation?.pending === false && (
                  <section className="escalation-evidence-card">
                    <div className="escalation-evidence-heading">
                      <div>
                        <p className="eyebrow">Escalation evidence</p>
                        <h2>Urgency {Number(escalation.urgency || 0)}/100</h2>
                      </div>
                      {escalation.isDuplicateHotspot && (
                        <span className="hotspot-badge">Duplicate hotspot</span>
                      )}
                    </div>
                    <p>
                      {(escalation.urgencyReasons || []).join(" · ") ||
                        "Urgency is based on completed agent signals."}
                    </p>
                    {Number(escalation.threshold || 0.6) > 0.6 && (
                      <p className="calibration-notice">
                        Repo calibration raised the auto-action threshold to{" "}
                        {Math.round(Number(escalation.threshold) * 100)}% after
                        maintainer corrections.
                      </p>
                    )}
                    <div className="escalation-thread">
                      <strong>Issue and user discussion</strong>
                      <p>
                        {escalation.issue?.body ||
                          issue.body ||
                          "No issue description."}
                      </p>
                      {(escalation.timelines || []).map((timeline, index) => (
                        <div key={`${timeline.eventType}-${index}`}>
                          <b>{timeline.actor || "user"}:</b> {timeline.body}
                        </div>
                      ))}
                    </div>
                    <details className="escalation-agent-details">
                      <summary>Agent reasons and evidence</summary>
                      {(escalation.agentRuns || []).map((run) => (
                        <DecisionRecord
                          key={run.id}
                          run={run}
                          onFeedback={onFeedback}
                        />
                      ))}
                    </details>
                  </section>
                )}
                {showContributor ? (
                  <section className="contributor-section">
                    <ContributorMatchPanel
                      owner={owner}
                      repo={repo}
                      issue={issue}
                      fallbackCandidates={moderator?.suggestions}
                      onAction={onModeratorAction}
                    />
                    {moderator && (
                      <ModeratorPanel
                        context={moderator}
                        onAction={onModeratorAction}
                      />
                    )}
                  </section>
                ) : (
                  <>
                    {error && <p className="detail-error">{error}</p>}
                    <section className="analysis-content-grid">
                      <article className="selected-agent-card">
                        <div className="selected-agent-heading">
                          <div>
                            <p className="eyebrow">Selected analysis</p>
                            <h2>{active?.label}</h2>
                            <p>{active?.hint}</p>
                          </div>
                          <span className={`agent-status ${active?.status}`}>
                            {statusLabel(active?.status)}
                          </span>
                        </div>
                        {active?.status === "running" && (
                          <div className="agent-progress">
                            <span />
                          </div>
                        )}
                        {active?.error && (
                          <p className="detail-error">{active.error}</p>
                        )}
                        {active?.result && <AgentResultDetail agent={active} />}
                        {!active?.result && !active?.error && (
                          <div className="waiting-detail">
                            <span className="waiting-orbit">◌</span>
                            <strong>Waiting for this agent to report</strong>
                            <p>
                              The workflow will surface its findings here as
                              soon as they arrive.
                            </p>
                          </div>
                        )}
                      </article>
                      <aside className="workflow-card">
                        <div className="panel-heading">
                          <div>
                            <p className="eyebrow">Workflow</p>
                            <h2>Agent activity</h2>
                          </div>
                          <span className="count-label">
                            {complete} of {agents.length}
                          </span>
                        </div>
                        <div className="workflow-rail">
                          {agents.map((agent, index) => (
                            <button
                              className={`workflow-step ${active?.key === agent.key ? "selected" : ""}`}
                              type="button"
                              key={agent.key}
                              onClick={() => setActiveAgent(agent.key)}
                            >
                              <span
                                className={`workflow-step-marker ${agent.status}`}
                              >
                                {agent.status === "complete" ? "✓" : index + 1}
                              </span>
                              <span>
                                <strong>{agent.label}</strong>
                                <small>{statusLabel(agent.status)}</small>
                              </span>
                            </button>
                          ))}
                        </div>
                      </aside>
                    </section>
                  </>
                )}
              </>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}

function DecisionRecord({ run, onFeedback }) {
  const [correcting, setCorrecting] = useState(false);
  const [correctionType, setCorrectionType] = useState("evidence_weighting");
  const [correctionDetail, setCorrectionDetail] = useState("");
  const [busy, setBusy] = useState(false);
  const savedFeedback = run.feedbacks?.[run.feedbacks.length - 1];
  async function submit(verdict) {
    if (verdict === "corrected" && !correctionDetail.trim()) return;
    setBusy(true);
    try {
      await onFeedback({
        agentRunId: run.id,
        verdict,
        correctionType,
        correctionDetail,
      });
      setCorrecting(false);
      setCorrectionDetail("");
    } finally {
      setBusy(false);
    }
  }
  const evidence = Array.isArray(run.citedEvidence) ? run.citedEvidence : [];
  return (
    <article className={`decision-record ${savedFeedback?.verdict || ""}`}>
      <div className="decision-record-heading">
        <div>
          <b>{run.agentName}</b>
          <span>
            {run.finalAction || run.suggestedAction || "no action"} ·{" "}
            {Math.round(Number(run.confidence || 0) * 100)}% confidence
          </span>
        </div>
        <span className="decision-status">
          {savedFeedback?.verdict || run.status}
        </span>
      </div>
      {run.reasoning && <Markdown text={run.reasoning} />}
      {Array.isArray(run.reasoningTrace) && run.reasoningTrace.length > 0 && (
        <ol className="reasoning-steps">
          {run.reasoningTrace.map((step, index) => <li key={`${run.id}-step-${index}`}><Markdown text={String(step)} /></li>)}
        </ol>
      )}
      {evidence.length > 0 && (
        <div className="decision-evidence">
          {evidence.map((item, index) => {
            const url = item.url || item.html_url;
            const label =
              item.source || item.title || item.issue_number
                ? `${item.source || "Issue"}${item.issue_number ? ` #${item.issue_number}` : ""}`
                : String(item);
            return url ? (
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                key={`${run.id}-evidence-${index}`}
              >
                {label} →
              </a>
            ) : (
              <span key={`${run.id}-evidence-${index}`}>{label}</span>
            );
          })}
        </div>
      )}
      {!savedFeedback && (
        <div className="decision-feedback-actions">
          <button
            type="button"
            className="primary-button"
            disabled={busy}
            onClick={() => submit("approved")}
          >
            Approve
          </button>
          <button
            type="button"
            className="outline-button"
            disabled={busy}
            onClick={() => setCorrecting(true)}
          >
            Correct
          </button>
        </div>
      )}
      {correcting && (
        <div className="correction-form">
          <select
            value={correctionType}
            onChange={(event) => setCorrectionType(event.target.value)}
          >
            <option value="evidence_weighting">Wrong evidence weighting</option>
            <option value="threshold">Wrong threshold/action</option>
            <option value="category">Wrong category</option>
          </select>
          <textarea
            value={correctionDetail}
            onChange={(event) => setCorrectionDetail(event.target.value)}
            placeholder="What should the agent have understood?"
            rows="3"
          />
          <button
            type="button"
            className="primary-button"
            disabled={busy || !correctionDetail.trim()}
            onClick={() => submit("corrected")}
          >
            Save correction
          </button>
        </div>
      )}
    </article>
  );
}

function ModeratorPanel({ context, onAction }) {
  const [assignee, setAssignee] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  if (!context) return null;
  async function act(payload) {
    setBusy(true);
    setMessage("");
    try {
      await onAction(payload);
      setMessage(payload.accept ? "Pull request accepted and merged; linked issues were updated." : `Assigned to @${payload.assignee}.`);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }
  const reporter = context.issue?.user?.login;
  const isPullRequest = Boolean(context.issue?.pull_request);
  return (
    <section className="moderator-panel">
      <div className="escalation-evidence-heading">
        <div>
          <p className="eyebrow">Manual assignment</p>
          <h3>Choose ownership yourself</h3>
        </div>
        <span className="count-label">GitHub source of truth</span>
      </div>
      <div className="moderator-actions">
        {isPullRequest && (
          <button
            type="button"
            className="primary-button"
            disabled={busy}
            onClick={() => act({ accept: true })}
          >
            Accept and merge PR
          </button>
        )}
        <select
          value={assignee}
          onChange={(event) => setAssignee(event.target.value)}
          disabled={busy}
        >
          <option value="">Choose collaborator</option>
          {(context.collaborators || []).map((person) => (
            <option value={person.login} key={person.login}>
              @{person.login}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="primary-button"
          disabled={busy || !assignee}
          onClick={() => act({ assignee })}
        >
          Assign task
        </button>
        {reporter && (
          <button
            type="button"
            className="outline-button"
            disabled={busy}
            onClick={() => act({ assignee: reporter })}
          >
            Assign issue creator
          </button>
        )}
      </div>
      {message && <p className="detail-muted">{message}</p>}
    </section>
  );
}

function ContributorMatchPanel({
  owner,
  repo,
  issue,
  fallbackCandidates,
  onAction,
}) {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [assignedLogin, setAssignedLogin] = useState("");

  async function findMatches() {
    setLoading(true);
    setError("");
    try {
      const response = await api("/api/agents/contributor-match", {
        method: "POST",
        body: { owner, repo, issueNumber: issue.number },
      });
      setResult(response);
    } catch (requestError) {
      const fallback = (fallbackCandidates || []).map((candidate) => ({
        login: candidate.login,
        fit_score: candidate.score,
        confidence: 0,
        tech_stack_match: "Repository contributor suggestion",
        past_similar_work: (candidate.reasons || []).join(", "),
        median_turnaround_days: null,
        current_load: "Live contributor history unavailable",
        sentiment_flag: "Fallback suggestion",
        reasoning:
          "The deployed Contributor Agent is unavailable, so this recommendation uses the existing repository contributor signals.",
      }));
      if (fallback.length) {
        setResult({
          candidates: fallback,
          recommended: fallback[0].login,
          fallback: true,
        });
        setError(
          "Live Contributor Agent unavailable; showing repository suggestions.",
        );
      } else {
        setError(requestError.message);
      }
    } finally {
      setLoading(false);
    }
  }

  async function assign(login) {
    setAssignedLogin(login);
    setError("");
    try {
      await onAction({ assignee: login });
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setAssignedLogin("");
    }
  }

  const candidates = Array.isArray(result?.candidates) ? result.candidates : [];
  return (
    <section className="contributor-match-panel">
      <div className="escalation-evidence-heading">
        <div>
          <p className="eyebrow">Contributor recommendations</p>
          <h3>AI-ranked ownership options</h3>
        </div>
        <button
          type="button"
          className="primary-button"
          disabled={loading}
          onClick={findMatches}
        >
          {loading
            ? "Analyzing history..."
            : result
              ? "Refresh recommendations"
              : "Find contributors"}
        </button>
      </div>
      <p className="contributor-match-intro">
        Ranks repository contributors using matching paths, merged work,
        turnaround, discussion tone, and current workload.
      </p>
      {result?.recommended && (
        <p className="contributor-match-recommended">
          Top recommendation: <strong>@{result.recommended}</strong>
        </p>
      )}
      {result?.fallback && (
        <p className="contributor-match-fallback">
          Using existing repository suggestions until the Contributor Agent
          deployment is available.
        </p>
      )}
      {candidates.length > 0 && (
        <div className="contributor-match-list">
          {candidates.map((candidate) => (
            <article className="contributor-match-card" key={candidate.login}>
              <div className="contributor-match-heading">
                <div>
                  <strong>@{candidate.login}</strong>
                  <span>
                    {candidate.fit_score}/100 fit
                    {candidate.confidence
                      ? ` · ${Math.round(Number(candidate.confidence) * 100)}% confidence`
                      : ""}
                  </span>
                </div>
                <button
                  type="button"
                  className="outline-button"
                  disabled={Boolean(assignedLogin)}
                  onClick={() => assign(candidate.login)}
                >
                  {assignedLogin === candidate.login
                    ? "Assigning..."
                    : "Assign"}
                </button>
              </div>
              <p>{candidate.reasoning}</p>
              <div className="contributor-match-evidence">
                <span>{candidate.tech_stack_match}</span>
                <span>{candidate.past_similar_work}</span>
                <span>
                  {candidate.median_turnaround_days == null
                    ? "No measured turnaround"
                    : `${candidate.median_turnaround_days} day median turnaround`}
                </span>
                <span>{candidate.current_load}</span>
                <span>{candidate.sentiment_flag}</span>
              </div>
            </article>
          ))}
        </div>
      )}
      {result && !candidates.length && (
        <p className="detail-muted">
          No contributor history was available for this issue.
        </p>
      )}
      {error && !result?.fallback && <p className="detail-error">{error}</p>}
      {error && result?.fallback && (
        <p className="contributor-match-fallback">{error}</p>
      )}
    </section>
  );
}

function PlannerPanel({ planner }) {
  const decision = planner.decision || {};
  const routing = planner.routing || {};
  const trace = planner.trace || [];
  return (
    <section className="decision-panel planner-panel">
      <p className="eyebrow">Planner</p>
      <h3>Investigation plan</h3>
      <div className="planner-verdict">
        <span className={`agent-status ${decision.verdict || "analyzing"}`}>
          {decision.verdict || "analyzing"}
        </span>
        {decision.confidence != null && (
          <span className="planner-confidence">
            {Math.round(decision.confidence * 100)}% confidence
          </span>
        )}
      </div>
      {decision.summary && <Markdown text={decision.summary} />}
      {routing.agents?.length > 0 && (
        <div className="planner-routing">
          <strong>Routed agents</strong>
          <ul>
            {routing.agents.map((name, index) => (
              <li key={name}>
                <span className="routing-chip">{name}</span>
                <span className="routing-reason">
                  {routing.rationale?.[index] || "selected for investigation"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {trace.length > 0 && (
        <div className="planner-trace">
          <strong>Tool trace</strong>
          <ol>
            {trace.map((step) => (
              <li key={step.step} className="planner-trace-step">
                <span className="trace-tool">{step.tool}</span>
                {step.note && <span className="trace-note">{step.note}</span>}
                {step.input && (
                  <code className="trace-input" title={String(step.input)}>
                    {String(step.input).slice(0, 90)}
                    {String(step.input).length > 90 ? "…" : ""}
                  </code>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
      {planner.suggested_actions?.length > 0 && (
        <div className="planner-actions">
          <strong>Suggested actions (require approval)</strong>
          <ul>
            {planner.suggested_actions.map((action, index) => (
              <li key={`${action.kind}-${index}`}>
                <code>{action.kind}</code>
                <span>{action.preview}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function AgentAnalysisView({ owner, repo, issue, onClose }) {
  const [analysis, setAnalysis] = useState(null);
  const [error, setError] = useState("");
  const [notTriggered, setNotTriggered] = useState(false);
  const [escalation, setEscalation] = useState(null);
  const [moderator, setModerator] = useState(null);

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    let active = true;
    async function load() {
      try {
        const result = await api(
          `/api/webhooks/analysis/${owner}/${repo}/${issue.number}`,
        );
        if (active) {
          setAnalysis(result);
          setError("");
          setNotTriggered(false);
          if (result.issue?.id) {
            api(`/api/issues/${result.issue.id}/escalation`)
              .then(setEscalation)
              .catch(() => setEscalation(null));
          }
          api(`/api/issues/${owner}/${repo}/moderation/${issue.number}`)
            .then(setModerator)
            .catch(() => setModerator(null));
        }
      } catch (requestError) {
        if (
          active &&
          requestError.message.startsWith("No automatic analysis")
        ) {
          setNotTriggered(true);
          setError(
            "This issue was created before automatic analysis was enabled.",
          );
        } else if (active) {
          setError(requestError.message);
        }
      }
    }
    load();
    const timer = setInterval(() => {
      if (!notTriggered) load();
    }, 4000);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [owner, repo, issue.number, notTriggered, onClose]);

  const agents = automaticAgents.map(([key, label, hint]) => {
    const status = analysis?.agents?.[key]?.status || "waiting";
    return { key, label, hint, ...(analysis?.agents?.[key] || { status }) };
  });
  const activeAgents = agents.filter((agent) => agent.status !== "skipped");
  const complete = activeAgents.filter(
    (agent) => agent.status === "complete",
  ).length;
  const failed = activeAgents.filter(
    (agent) => agent.status === "failed",
  ).length;

  const duplicate = agents.find((agent) => agent.key === "duplicate")?.result;
  const duplicateMatches =
    duplicate?.matches?.filter(
      (match) => match.classification === "direct_duplicate",
    ) || [];
  const missing = agents.find((agent) => agent.key === "missingInfo")?.result;
  const sensitivity = agents.find(
    (agent) => agent.key === "sensitivity",
  )?.result;
  if (typeof onClose === "function")
    return (
      <CentralAnalysisDashboard
        owner={owner}
        repo={repo}
        issue={issue}
        analysis={analysis}
        agents={activeAgents}
        complete={complete}
        failed={failed}
        error={error}
        notTriggered={notTriggered}
        escalation={escalation}
        moderator={moderator}
        onModeratorAction={async (payload) => {
          const result = await api(
            `/api/issues/${owner}/${repo}/moderation/${issue.number}`,
            { method: "POST", body: payload },
          );
          setModerator((current) =>
            current ? { ...current, issue: result.issue } : current,
          );
        }}
        onFeedback={async (payload) => {
          await api(
            `/api/issues/${escalation?.issue?.id || issue.id}/feedback`,
            { method: "POST", body: payload },
          );
          const updated = await api(
            `/api/issues/${escalation?.issue?.id || issue.id}/escalation`,
          );
          setEscalation(updated);
        }}
        onClose={onClose}
      />
    );
  return (
    <div className="analysis-overlay">
      <div className="analysis-drawer">
        <div className="analysis-header">
          <div>
            <p className="eyebrow">Automatic triage</p>
            <h2>Issue #{issue.number}</h2>
            <p>{issue.title}</p>
          </div>
          <button className="close-button" type="button" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="analysis-issue">
          <span className="issue-number">#{issue.number}</span>
          <div>
            <strong>{issue.title}</strong>
            <p>{issue.body || "No description provided."}</p>
          </div>
        </div>
        {notTriggered ? (
          <div className="not-triggered-panel">
            <h3>Automatic analysis was not triggered</h3>
            <p>
              This issue was created before automatic analysis was enabled.
              Agents will run automatically for newly created issues and future
              issue changes.
            </p>
          </div>
        ) : (
          <>
            <div className="analysis-summary">
              <div>
                <strong>
                  {complete}/{agents.length}
                </strong>
                <span>agents complete</span>
              </div>
              <div>
                <strong>
                  {analysis?.status === "complete"
                    ? "Ready"
                    : analysis?.status === "waiting_missing_info"
                      ? "Waiting for reporter"
                      : analysis?.status === "waiting_duplicate_info"
                        ? "Waiting for duplicate evidence"
                        : "Running"}
                </strong>
                <span>analysis status</span>
              </div>
              <div>
                <strong>{failed}</strong>
                <span>errors</span>
              </div>
            </div>
            {analysis?.planner && <PlannerPanel planner={analysis.planner} />}
            {duplicateMatches.length > 0 && (
              <section className="decision-panel duplicate-panel">
                <p className="eyebrow">Duplicate flow</p>
                <h3>Matched open issues</h3>
                <p>
                  This issue has been mapped to the existing issue below and the
                  workflow stopped.
                </p>
                {duplicateMatches.map((match) => (
                  <a
                    href={match.url}
                    target="_blank"
                    rel="noreferrer"
                    className="match-card"
                    key={match.issue_number}
                  >
                    <strong>
                      #{match.issue_number} · {match.title}
                    </strong>
                    <span>
                      {Math.round((match.similarity_score || 0) * 100)}%
                      similarity ↗
                    </span>
                  </a>
                ))}
              </section>
            )}
            {missing?.missing_fields?.length > 0 && (
              <section className="decision-panel missing-panel">
                <p className="eyebrow">Missing information</p>
                <h3>Waiting for reporter details</h3>
                <Markdown
                  text={
                    missing.draft_comment || missing.missing_details?.join(", ")
                  }
                />
              </section>
            )}
            {sensitivity && (
              <section className="decision-panel sensitivity-panel">
                <p className="eyebrow">Security sensitivity</p>
                <h3>
                  {sensitivity.severity ||
                    sensitivity.risk_level ||
                    "Security scan complete"}
                </h3>
                <Markdown
                  text={
                    sensitivity.recommendation ||
                    sensitivity.summary ||
                    "No additional security escalation was reported."
                  }
                />
              </section>
            )}
            {error && <p className="detail-error">{error}</p>}
            <div className="agent-result-grid">
              {activeAgents.map((agent) => (
                <article className="agent-result-card" key={agent.key}>
                  <div className="agent-card-heading">
                    <div>
                      <h3>{agent.label}</h3>
                      <p>{agent.hint}</p>
                    </div>
                    <span className={`agent-status ${agent.status}`}>
                      {agent.status}
                    </span>
                  </div>
                  {agent.status === "running" && (
                    <div className="agent-progress">
                      <span />
                    </div>
                  )}
                  {agent.error && <p className="detail-error">{agent.error}</p>}
                  {agent.result && <AgentCardSummary agent={agent} />}
                </article>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function RepositoryOverviewDashboard({
  details,
  activeTab,
  setActiveTab,
  onBack,
  workflowStatuses,
  escalationDecisions,
}) {
  const {
    repo,
    issues = [],
    pulls = [],
    contributors = [],
    contributorsPending = false,
    codeFrequency = [],
  } = details;
  const [selectedIssue, setSelectedIssue] = useState(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [escalationFilter, setEscalationFilter] = useState("all");
  const openIssues = issues.filter(
    (issue) => !issue.pull_request && issue.state === "open",
  );
  const workflowIssues = issues.filter(
    (issue) =>
      workflowStatuses[issue.number] &&
      workflowStatuses[issue.number] !== "complete",
  );
  const escalationIssues = issues.filter((issue) =>
    Boolean(escalationDecisions[issue.number]),
  );
  const resolvedIssues = issues.filter(
    (issue) =>
      workflowStatuses[issue.number] === "stopped_duplicate" ||
      issue.state === "closed",
  );
  const priorityCounts = {
    High: workflowIssues.filter(
      (issue) => workflowStatuses[issue.number] === "running",
    ).length,
    Medium: workflowIssues.filter(
      (issue) => workflowStatuses[issue.number] === "waiting_missing_info",
    ).length,
    Low: Math.max(0, openIssues.length - workflowIssues.length),
  };
  const priorityTotal = Math.max(
    1,
    priorityCounts.High + priorityCounts.Medium + priorityCounts.Low,
  );
  const categoryNames = [
    "Bug",
    "Documentation",
    "Feature Request",
    "Question",
    "Other",
  ];
  const categoryAliases = {
    bug: "Bug",
    documentation: "Documentation",
    docs: "Documentation",
    "feature request": "Feature Request",
    feature_request: "Feature Request",
    question: "Question",
  };
  const trackedIssues = issues.filter((issue) => !issue.pull_request);
  const categoryCounts = trackedIssues.reduce((counts, issue) => {
    const labels = (issue.labels || [])
      .map((label) => String(label.name || label).trim().toLowerCase())
      .map((label) => categoryAliases[label])
      .filter(Boolean);
    const category = labels[0] || "Other";
    counts[category] += 1;
    return counts;
  }, Object.fromEntries(categoryNames.map((category) => [category, 0])));
  const topCategories = categoryNames.map((category) => ({
    name: category,
    percentage: trackedIssues.length
      ? Math.round((categoryCounts[category] / trackedIssues.length) * 100)
      : 0,
  }));
  const chartPoints = codeFrequency.slice(-12);
  const chartMax = Math.max(
    ...chartPoints.map((point) =>
      Math.max(point[1] || 0, Math.abs(point[2] || 0)),
    ),
    1,
  );
  return (
    <div className="repo-dashboard-page">
      <div className="repo-dashboard-shell">
        <aside className="repo-dashboard-sidebar">
          <button className="back-button" type="button" onClick={onBack}>
            ← All repositories
          </button>
          <div className="repo-dashboard-brand">
            <span className="brand-symbol">◈</span>
            <div>
              <strong>{repo.name}</strong>
              <span>Repository workspace</span>
            </div>
          </div>
          <nav aria-label="Repository dashboard sections">
            {tabs.map((tab) => (
              <button
                className={activeTab === tab ? "active" : ""}
                type="button"
                key={tab}
                onClick={() => setActiveTab(tab)}
              >
                <span className="repo-nav-icon">
                  {tab === "Overview"
                    ? "⌂"
                    : tab === "Issues"
                      ? "⊙"
                      : tab === "Pull requests"
                        ? "⑂"
                        : tab === "Commits"
                          ? "↗"
                          : tab === "Contributors"
                            ? "◎"
                            : tab === "Health"
                              ? "♥"
                              : "▥"}
                </span>
                {tab}
                {tab === "Issues" && <small>{issues.length}</small>}
                {tab === "Pull requests" && <small>{pulls.length}</small>}
              </button>
            ))}
            <button
              className={activeTab === "Escalations" ? "active" : ""}
              type="button"
              onClick={() => setActiveTab("Escalations")}
            >
              <span className="repo-nav-icon">⚠</span>
              Escalations
              <small>{escalationIssues.length}</small>
            </button>
          </nav>
          <RepositoryChatButton
            onClick={() => setChatOpen((open) => !open)}
            active={chatOpen}
          />
        </aside>
        <main className="repo-dashboard-main">
          {chatOpen && (
            <RepositoryChat owner={repo.owner.login} repo={repo.name} />
          )}
          <header className="repo-dashboard-topbar">
            <div>
              <p className="eyebrow">Repository overview</p>
              <h1>{repo.full_name}</h1>
            </div>
            <a
              className="outline-button"
              href={repo.html_url}
              target="_blank"
              rel="noreferrer"
            >
              Open on GitHub ↗
            </a>
            <ReportButton details={{ ...details, workflowStatuses, escalationDecisions }} />
          </header>
          <section className="repo-kpi-grid">
            <Stat
              label="Total issues"
              value={issues.filter((issue) => !issue.pull_request).length}
            />
            <Stat label="Escalations" value={escalationIssues.length} />
            <Stat label="Auto resolved" value={resolvedIssues.length} />
            <Stat label="Contributors" value={contributors.length} />
          </section>
          <section className="repo-chart-grid">
            <article className="repo-dashboard-card priority-card">
              <div className="dashboard-card-heading">
                <div>
                  <p className="eyebrow">Workflow signal</p>
                  <h2>Issues by priority</h2>
                </div>
                <span>{priorityTotal} total</span>
              </div>
              <div className="priority-visual">
                <div
                  className="priority-donut"
                  style={{
                    background: `conic-gradient(var(--danger) 0 ${(priorityCounts.High / priorityTotal) * 360}deg, var(--warning) ${(priorityCounts.High / priorityTotal) * 360}deg ${((priorityCounts.High + priorityCounts.Medium) / priorityTotal) * 360}deg, var(--success) ${((priorityCounts.High + priorityCounts.Medium) / priorityTotal) * 360}deg 360deg)`,
                  }}
                >
                  <strong>{priorityTotal}</strong>
                  <small>Total</small>
                </div>
                <div className="priority-legend">
                  <span>
                    <i className="high-dot" />
                    High <b>{priorityCounts.High}</b>
                  </span>
                  <span>
                    <i className="medium-dot" />
                    Medium <b>{priorityCounts.Medium}</b>
                  </span>
                  <span>
                    <i className="low-dot" />
                    Low <b>{priorityCounts.Low}</b>
                  </span>
                </div>
              </div>
            </article>
            <article className="repo-dashboard-card activity-card">
              <div className="dashboard-card-heading">
                <div>
                  <p className="eyebrow">Repository activity</p>
                  <h2>Code changes</h2>
                </div>
                <span>Latest {chartPoints.length || 0} weeks</span>
              </div>
              {chartPoints.length ? (
                <div className="activity-chart">
                  <div className="activity-bars">
                    {chartPoints.map((point) => (
                      <div
                        className="activity-bar-group"
                        key={point[0]}
                        title={`${point[1]} additions, ${Math.abs(point[2])} deletions`}
                      >
                        <span
                          className="activity-bar additions"
                          style={{
                            height: `${Math.max(4, (point[1] / chartMax) * 100)}%`,
                          }}
                        />
                        <span
                          className="activity-bar deletions"
                          style={{
                            height: `${Math.max(4, (Math.abs(point[2]) / chartMax) * 100)}%`,
                          }}
                        />
                      </div>
                    ))}
                  </div>
                  <div className="chart-legend">
                    <span>
                      <i className="legend-additions" />
                      Additions
                    </span>
                    <span>
                      <i className="legend-deletions" />
                      Deletions
                    </span>
                  </div>
                </div>
              ) : (
                <EmptyState>No activity data available yet.</EmptyState>
              )}
            </article>
          </section>
          <section className="repo-lower-grid">
            <article className="repo-dashboard-card category-card">
              <div className="dashboard-card-heading">
                <div>
                  <p className="eyebrow">Issue taxonomy</p>
                  <h2>Top categories</h2>
                </div>
                <span>{issues.length} tracked</span>
              </div>
              <div className="category-list">
                {topCategories.map(({ name, percentage }) => (
                    <div className="category-row" key={name}>
                      <strong>{name}</strong>
                      <div>
                        <span
                          style={{
                            width: `${percentage}%`,
                          }}
                        />
                      </div>
                      <b>{percentage}%</b>
                    </div>
                ))}
              </div>
            </article>
            <OverviewInbox issues={issues} pulls={pulls} onSelectIssue={setSelectedIssue} />
          </section>
        </main>
      </div>
      {selectedIssue && (
        <AgentAnalysisView
          owner={repo.owner.login}
          repo={repo.name}
          issue={selectedIssue}
          onClose={() => setSelectedIssue(null)}
        />
      )}
    </div>
  );
}

function OverviewInbox({ issues, pulls, onSelectIssue }) {
  const [activeType, setActiveType] = useState("issues");
  const issueItems = issues.filter((item) => !item.pull_request);
  const commentItems = issueItems.filter((item) => Number(item.comments || 0) > 0);
  const tabs = [
    { key: "issues", label: "Issues", count: issueItems.length },
    { key: "pulls", label: "PRs", count: pulls.length },
    { key: "comments", label: "Comments", count: commentItems.reduce((total, item) => total + Number(item.comments || 0), 0) },
  ];
  const items = activeType === "issues" ? issueItems : activeType === "pulls" ? pulls : commentItems;
  const sortedItems = [...items]
    .sort((first, second) => new Date(second.updated_at || second.created_at) - new Date(first.updated_at || first.created_at))
    .slice(0, 5);
  return (
    <article className="repo-dashboard-card inbox-card">
      <div className="dashboard-card-heading">
        <div>
          <p className="eyebrow">Inbox</p>
          <h2>All new events</h2>
        </div>
        <span>{issueItems.length + pulls.length} tracked</span>
      </div>
      <div className="inbox-tabs" role="tablist" aria-label="Inbox event types">
        {tabs.map((tab) => (
          <button className={activeType === tab.key ? "active" : ""} type="button" role="tab" aria-selected={activeType === tab.key} key={tab.key} onClick={() => setActiveType(tab.key)}>
            {tab.label} <b>{tab.count}</b>
          </button>
        ))}
      </div>
      <div className="inbox-table-head"><span>Title</span><span>Type</span><span>Author</span><span>Time</span></div>
      <div className="inbox-event-list">
        {sortedItems.map((item) => {
          const isPull = activeType === "pulls";
          const isComment = activeType === "comments";
          const eventDate = item.updated_at || item.created_at;
          return (
            <button className="inbox-event-row" type="button" key={`${activeType}-${item.id}`} onClick={() => !isComment && onSelectIssue(item)}>
              <strong>{isComment ? `Comment on ${item.title}` : item.title}</strong>
              <span>{isPull ? "PR" : isComment ? "Comment" : "Issue"}</span>
              <span>@{item.user?.login || item.author || "unknown"}</span>
              <time dateTime={eventDate}>{eventDate ? formatDate(eventDate) : "—"}</time>
            </button>
          );
        })}
        {!sortedItems.length && <EmptyState>No {activeType} found.</EmptyState>}
      </div>
    </article>
  );
}

function EscalationTrendChart({ decisions }) {
  const records = Object.values(decisions || {})
    .map((decision) => ({ ...decision, recordedAt: decision.createdAt || decision.updatedAt }))
    .filter((decision) => decision.recordedAt)
    .sort((first, second) => new Date(first.recordedAt) - new Date(second.recordedAt));
  const dates = [...new Set(records.map((decision) => new Date(decision.recordedAt).toISOString().slice(0, 10)))];
  if (!dates.length) {
    return <EmptyState>No escalation history available yet.</EmptyState>;
  }

  const start = new Date(`${dates[0]}T00:00:00Z`);
  const end = new Date(`${dates[dates.length - 1]}T00:00:00Z`);
  const points = [];
  for (let cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    points.push(cursor.toISOString().slice(0, 10));
  }
  const visibleDates = points.length > 14 ? points.slice(-14) : points;
  const series = visibleDates.map((date) => {
    const dayRecords = records.filter((decision) => new Date(decision.recordedAt).toISOString().slice(0, 10) === date);
    return {
      date,
      high: dayRecords.filter((decision) => Number(decision.urgency || 0) >= 70).length,
      medium: dayRecords.filter((decision) => Number(decision.urgency || 0) >= 40 && Number(decision.urgency || 0) < 70).length,
      low: dayRecords.filter((decision) => Number(decision.urgency || 0) < 40).length,
    };
  });
  const width = 720;
  const height = 220;
  const padding = { top: 18, right: 18, bottom: 34, left: 34 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const maximum = Math.max(...series.flatMap((point) => [point.high, point.medium, point.low]), 1);
  const x = (index) => padding.left + (series.length === 1 ? plotWidth / 2 : (index / (series.length - 1)) * plotWidth);
  const y = (value) => padding.top + plotHeight - (value / maximum) * plotHeight;
  const linePoints = (key) => series.map((point, index) => `${x(index)},${y(point[key])}`).join(" ");
  const labelEvery = Math.max(1, Math.ceil(series.length / 5));
  return (
    <div className="escalation-trend-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Escalations over time">
        {[0, 0.5, 1].map((ratio) => (
          <g key={ratio}>
            <line className="escalation-grid-line" x1={padding.left} x2={width - padding.right} y1={y(maximum * ratio)} y2={y(maximum * ratio)} />
            <text className="escalation-axis-label" x={padding.left - 8} y={y(maximum * ratio) + 4} textAnchor="end">{Math.round(maximum * ratio)}</text>
          </g>
        ))}
        {["high", "medium", "low"].map((key) => (
          <polyline className={`escalation-line ${key}`} key={key} points={linePoints(key)} fill="none" />
        ))}
        {series.map((point, index) => (
          <g key={point.date}>
            {index % labelEvery === 0 && <text className="escalation-date-label" x={x(index)} y={height - 10} textAnchor="middle">{new Date(`${point.date}T00:00:00Z`).toLocaleDateString("en", { month: "short", day: "numeric" })}</text>}
            {[
              ["high", point.high],
              ["medium", point.medium],
              ["low", point.low],
            ].map(([key, value]) => <circle className={`escalation-point ${key}`} key={key} cx={x(index)} cy={y(value)} r="3"><title>{`${point.date}: ${key} ${value}`}</title></circle>)}
          </g>
        ))}
      </svg>
      <div className="chart-legend escalation-legend">
        <span><i className="escalation-legend-high" />High</span>
        <span><i className="escalation-legend-medium" />Medium</span>
        <span><i className="escalation-legend-low" />Low</span>
      </div>
    </div>
  );
}

function RepositoryTabDashboard({
  details,
  activeTab,
  setActiveTab,
  onBack,
  workflowStatuses,
  escalationDecisions,
}) {
  const {
    repo,
    issues = [],
    pulls = [],
    commits = [],
    contributors = [],
    contributorsPending = false,
    codeFrequency = [],
    codeFrequencyPending,
  } = details;
  const [selectedIssue, setSelectedIssue] = useState(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [escalationFilter, setEscalationFilter] = useState("all");
  const openIssues = issues.filter(
    (issue) => !issue.pull_request && issue.state === "open",
  );
  const openPulls = pulls.filter((pull) => pull.state === "open");
  const escalationIssues = issues.filter(
    (issue) =>
      !issue.pull_request &&
      escalationDecisions[issue.number]?.needsAttention === true,
  );
  const filteredEscalationIssues = escalationIssues.filter((issue) => {
    const decision = escalationDecisions[issue.number] || {};
    if (escalationFilter === "hotspot") return decision.isDuplicateHotspot;
    if (escalationFilter === "security")
      return (decision.triggeringCategories || []).includes("security");
    if (escalationFilter === "failed")
      return (decision.urgencyReasons || []).some((reason) =>
        reason.includes("failed"),
      );
    return true;
  });
  const highPriorityIssues = [...filteredEscalationIssues].sort(
    (first, second) =>
      Number(escalationDecisions[second.number]?.urgency || 0) -
      Number(escalationDecisions[first.number]?.urgency || 0),
  );
  const content = {
    Health: (
      <>
        <HealthPanel owner={repo.owner.login} repo={repo.name} />
        <SweepsPanel owner={repo.owner.login} repo={repo.name} />
      </>
    ),
    Issues: (
      <div className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Work tracking</p>
            <h2>Issues</h2>
          </div>
          <span className="count-label">
            {issues.length} total · new issues analyze automatically
          </span>
        </div>
        {issues
          .filter((issue) => !issue.pull_request)
          .map((issue) => (
            <IssueRow
              item={issue}
              workflowStatus={workflowStatuses[issue.number]}
              onClick={setSelectedIssue}
              key={issue.id}
            />
          ))}
        {!issues.filter((issue) => !issue.pull_request).length && (
          <EmptyState>No issues found.</EmptyState>
        )}
      </div>
    ),
    Escalations: (
      <div className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">High priority</p>
            <h2>Escalation outcomes</h2>
          </div>
          <span className="count-label">{highPriorityIssues.length}</span>
        </div>
        <section className="escalation-trend-card">
          <div className="dashboard-card-heading">
            <div>
              <p className="eyebrow">Decision history</p>
              <h3>Escalations over time</h3>
            </div>
            <span>Daily urgency</span>
          </div>
          <EscalationTrendChart decisions={escalationDecisions} />
        </section>
        <div className="escalation-filters">
          <label>
            Filter{" "}
            <select
              value={escalationFilter}
              onChange={(event) => setEscalationFilter(event.target.value)}
            >
              <option value="all">All attention</option>
              <option value="hotspot">Duplicate hotspots</option>
              <option value="security">Security</option>
              <option value="failed">Agent failures</option>
            </select>
          </label>
        </div>
        {highPriorityIssues.length ? (
          <div className="high-priority-list">
            {highPriorityIssues.map((issue) => {
              const decision = escalationDecisions[issue.number];
              const categories = (decision.triggeringCategories || [])
                .map((category) => category.replaceAll("_", " "))
                .join(", ");
              return (
                <div className="high-priority-item" key={issue.id}>
                  <IssueRow
                    item={issue}
                    workflowStatus={workflowStatuses[issue.number]}
                    onClick={setSelectedIssue}
                  />
                  <div className="high-priority-meta">
                    <span>Flagged by: {categories || "escalation"}</span>
                    <strong>
                      Urgency {Number(decision.urgency || 0)}/100 ·{" "}
                      {Math.round(
                        Number(decision.aggregateConfidence || 0) * 100,
                      )}
                      % confidence
                    </strong>
                    <span>
                      {decision.needsAttention
                        ? "Needs maintainer attention"
                        : "Auto-handled"}
                    </span>
                    {decision.isDuplicateHotspot && (
                      <span className="hotspot-badge">
                        Hotspot · {decision.duplicateHotspotCount}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState>Nothing needs attention right now.</EmptyState>
        )}
      </div>
    ),
    "Pull requests": (
      <div className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Code review</p>
            <h2>Pull requests</h2>
          </div>
          <span className="count-label">{openPulls.length} open</span>
        </div>
        {pulls.map((pull) => (
          <IssueRow item={pull} pull key={pull.id} />
        ))}
        {!pulls.length && <EmptyState>No pull requests found.</EmptyState>}
      </div>
    ),
    Commits: (
      <div className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Repository history</p>
            <h2>Recent commits</h2>
          </div>
          <span className="count-label">Latest 30</span>
        </div>
        {commits.map((commit) => (
          <CommitRow
            commit={commit}
            owner={repo.owner.login}
            repo={repo.name}
            key={commit.sha}
          />
        ))}
        {!commits.length && <EmptyState>No commits found.</EmptyState>}
      </div>
    ),
    Contributors: (
      <div className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">People behind the code</p>
            <h2>Contributors</h2>
          </div>
          <span className="count-label">
            {contributors.length} people
            {contributorsPending ? " · syncing" : ""}
          </span>
        </div>
        {contributors.map((contributor, index) => (
          <ContributorRow
            contributor={contributor}
            key={contributor.id || contributor.login || `contributor-${index}`}
          />
        ))}
        {!contributors.length && (
          <EmptyState>
            {contributorsPending
              ? "GitHub is preparing contributor statistics. Check again shortly."
              : "No contributor data found."}
          </EmptyState>
        )}
      </div>
    ),
    "Code changes": (
      <div className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Repository activity</p>
            <h2>Code changes</h2>
          </div>
          <span className="count-label">Weekly view</span>
        </div>
        <CodeChanges values={codeFrequency} pending={codeFrequencyPending} />
      </div>
    ),
  }[activeTab];
  return (
    <div className="repo-dashboard-page">
      <div className="repo-dashboard-shell">
        <aside className="repo-dashboard-sidebar">
          <button className="back-button" type="button" onClick={onBack}>
            ← All repositories
          </button>
          <div className="repo-dashboard-brand">
            <span className="brand-symbol">◈</span>
            <div>
              <strong>{repo.name}</strong>
              <span>Repository workspace</span>
            </div>
          </div>
          <nav aria-label="Repository dashboard sections">
            {tabs.map((tab) => (
              <button
                className={activeTab === tab ? "active" : ""}
                type="button"
                key={tab}
                onClick={() => setActiveTab(tab)}
              >
                <span className="repo-nav-icon">
                  {tab === "Overview"
                    ? "⌂"
                    : tab === "Issues"
                      ? "⊙"
                      : tab === "Pull requests"
                        ? "⑂"
                        : tab === "Commits"
                          ? "↗"
                          : tab === "Contributors"
                            ? "◎"
                            : tab === "Health"
                              ? "♥"
                              : "▥"}
                </span>
                {tab}
                {tab === "Issues" && <small>{issues.length}</small>}
                {tab === "Pull requests" && <small>{pulls.length}</small>}
              </button>
            ))}
            <button
              className={activeTab === "Escalations" ? "active" : ""}
              type="button"
              onClick={() => setActiveTab("Escalations")}
            >
              <span className="repo-nav-icon">⚠</span>
              Escalations
              <small>{escalationIssues.length}</small>
            </button>
          </nav>
          <RepositoryChatButton
            onClick={() => setChatOpen((open) => !open)}
            active={chatOpen}
          />
        </aside>
        <main className="repo-dashboard-main">
          {chatOpen && (
            <RepositoryChat owner={repo.owner.login} repo={repo.name} />
          )}
          <header className="repo-dashboard-topbar">
            <div>
              <p className="eyebrow">Repository workspace</p>
              <h1>{repo.full_name}</h1>
            </div>
            <a
              className="outline-button"
              href={repo.html_url}
              target="_blank"
              rel="noreferrer"
            >
              Open on GitHub ↗
            </a>
            <ReportButton details={{ ...details, workflowStatuses, escalationDecisions }} />
          </header>
          <section className="repo-kpi-grid">
            <Stat
              label="Total issues"
              value={issues.filter((issue) => !issue.pull_request).length}
            />
            <Stat label="Open issues" value={openIssues.length} />
            <Stat label="Pull requests" value={openPulls.length} />
            <Stat label="Contributors" value={contributors.length} />
          </section>
          <section className="repo-tab-content">{content}</section>
        </main>
      </div>
      {selectedIssue && (
        <AgentAnalysisView
          owner={repo.owner.login}
          repo={repo.name}
          issue={selectedIssue}
          onClose={() => setSelectedIssue(null)}
        />
      )}
    </div>
  );
}

function RepositoryDetail({ details, activeTab, setActiveTab, onBack }) {
  const {
    repo,
    issues = [],
    pulls = [],
    commits = [],
    contributors = [],
    codeFrequency = [],
    codeFrequencyPending,
  } = details;
  const openIssues = issues.filter(
    (issue) => !issue.pull_request && issue.state === "open",
  );
  const openPulls = pulls.filter((pull) => pull.state === "open");
  const languages = Object.keys(repo.language ? { [repo.language]: true } : {});
  const [selectedIssue, setSelectedIssue] = useState(null);
  const [workflowStatuses, setWorkflowStatuses] = useState({});
  const [escalationDecisions, setEscalationDecisions] = useState({});

  useEffect(() => {
    api(`/api/webhooks/analysis/${repo.owner.login}/${repo.name}`)
      .then(({ statuses }) => {
        setWorkflowStatuses(
          Object.fromEntries(
            statuses.map((item) => [item.number, item.status]),
          ),
        );
      })
      .catch(() => setWorkflowStatuses({}));
    api(`/api/issues/${repo.owner.login}/${repo.name}/escalations`)
      .then(({ decisions }) => {
        setEscalationDecisions(
          Object.fromEntries(
            (decisions || []).map((decision) => [
              decision.issue.number,
              decision,
            ]),
          ),
        );
      })
      .catch(() => setEscalationDecisions({}));
  }, [repo.owner.login, repo.name]);

  if (activeTab === "Overview")
    return (
      <RepositoryOverviewDashboard
        details={details}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        onBack={onBack}
        workflowStatuses={workflowStatuses}
        escalationDecisions={escalationDecisions}
      />
    );
  if (activeTab !== "Overview" && typeof onBack === "function")
    return (
      <RepositoryTabDashboard
        details={details}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        onBack={onBack}
        workflowStatuses={workflowStatuses}
        escalationDecisions={escalationDecisions}
      />
    );

  return (
    <div className="detail-page">
      <button className="back-button" type="button" onClick={onBack}>
        ← All repositories
      </button>
      <section className="repo-hero">
        <div className="repo-identity">
          <span className="repo-mark">◈</span>
          <div>
            <p className="eyebrow">Repository</p>
            <h1>{repo.full_name}</h1>
            <p>{repo.description || "No description provided."}</p>
          </div>
        </div>
        <a
          className="outline-button"
          href={repo.html_url}
          target="_blank"
          rel="noreferrer"
        >
          Open on GitHub ↗
        </a>
      </section>
      <div className="stats">
        <Stat
          label="Stars"
          value={(repo.stargazers_count || 0).toLocaleString()}
        />
        <Stat label="Forks" value={(repo.forks_count || 0).toLocaleString()} />
        <Stat label="Open issues" value={openIssues.length} />
        <Stat
          label="Watchers"
          value={(repo.subscribers_count || 0).toLocaleString()}
        />
      </div>
      <nav className="tabs" aria-label="Repository sections">
        {tabs.map((tab) => (
          <button
            className={activeTab === tab ? "active" : ""}
            type="button"
            key={tab}
            onClick={() => setActiveTab(tab)}
          >
            {tab}
            {tab === "Issues" && <small>{issues.length}</small>}
            {tab === "Pull requests" && <small>{pulls.length}</small>}
          </button>
        ))}
      </nav>
      <section className="tab-content">
        {activeTab === "Overview" && (
          <div className="overview-grid">
            <div className="panel">
              <p className="eyebrow">About this repository</p>
              <h2>Project snapshot</h2>
              <dl className="details-list">
                <div>
                  <dt>Default branch</dt>
                  <dd>{repo.default_branch}</dd>
                </div>
                <div>
                  <dt>License</dt>
                  <dd>{repo.license?.name || "Not specified"}</dd>
                </div>
                <div>
                  <dt>Created</dt>
                  <dd>{formatDate(repo.created_at)}</dd>
                </div>
                <div>
                  <dt>Last updated</dt>
                  <dd>{formatDate(repo.updated_at)}</dd>
                </div>
              </dl>
            </div>
            <div className="panel">
              <p className="eyebrow">Project signals</p>
              <h2>At a glance</h2>
              <div className="signal-list">
                <div>
                  <span>Primary language</span>
                  <strong>{languages[0] || "Not specified"}</strong>
                </div>
                <div>
                  <span>Repository size</span>
                  <strong>{Math.round(repo.size / 1024)} MB</strong>
                </div>
                <div>
                  <span>Visibility</span>
                  <strong>{repo.private ? "Private" : "Public"}</strong>
                </div>
              </div>
            </div>
          </div>
        )}
        {activeTab === "Issues" && (
          <div className="panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Work tracking</p>
                <h2>Issues</h2>
              </div>
              <span className="count-label">
                {issues.length} total · new issues analyze automatically
              </span>
            </div>
            {issues
              .filter((issue) => !issue.pull_request)
              .map((issue) => (
                <IssueRow
                  item={issue}
                  workflowStatus={workflowStatuses[issue.number]}
                  onClick={setSelectedIssue}
                  key={issue.id}
                />
              ))}
            {!issues.filter((issue) => !issue.pull_request).length && (
              <EmptyState>No issues found.</EmptyState>
            )}
          </div>
        )}
        {activeTab === "Pull requests" && (
          <div className="panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Code review</p>
                <h2>Pull requests</h2>
              </div>
              <span className="count-label">{openPulls.length} open</span>
            </div>
            {pulls.map((pull) => (
              <IssueRow item={pull} pull key={pull.id} />
            ))}
            {!pulls.length && <EmptyState>No pull requests found.</EmptyState>}
          </div>
        )}
        {activeTab === "Commits" && (
          <div className="panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Repository history</p>
                <h2>Recent commits</h2>
              </div>
              <span className="count-label">Latest 30</span>
            </div>
            {commits.map((commit) => (
              <CommitRow
                commit={commit}
                owner={repo.owner.login}
                repo={repo.name}
                key={commit.sha}
              />
            ))}
            {!commits.length && <EmptyState>No commits found.</EmptyState>}
          </div>
        )}
        {activeTab === "Contributors" && (
          <div className="panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">People behind the code</p>
                <h2>Contributors</h2>
              </div>
              <span className="count-label">{contributors.length} people</span>
            </div>
            {contributors.map((contributor, index) => (
              <ContributorRow
                contributor={contributor}
                key={
                  contributor.id || contributor.login || `contributor-${index}`
                }
              />
            ))}
            {!contributors.length && (
              <EmptyState>No contributor data found.</EmptyState>
            )}
          </div>
        )}
        {activeTab === "Code changes" && (
          <div className="panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Repository activity</p>
                <h2>Code changes</h2>
              </div>
              <span className="count-label">Weekly view</span>
            </div>
            <CodeChanges
              values={codeFrequency}
              pending={codeFrequencyPending}
            />
          </div>
        )}
      </section>
      {selectedIssue && (
        <AgentAnalysisView
          owner={repo.owner.login}
          repo={repo.name}
          issue={selectedIssue}
          onClose={() => setSelectedIssue(null)}
        />
      )}
    </div>
  );
}

function TrendsSection() {
  const [windowDays, setWindowDays] = useState(30);
  const [data, setData] = useState(null);
  const [summary, setSummary] = useState(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setPending(true);
    setError("");
    Promise.all([
      trendsApi(`/api/trends?window=${windowDays}`, `/api/trends/trends?window=${windowDays}`),
      trendsApi(`/api/trends/summary?window=${windowDays}`, `/api/trends/trends/summary?window=${windowDays}`),
    ])
      .then(([trends, digest]) => {
        if (cancelled) return;
        setData(trends);
        setSummary(digest);
      })
      .catch((requestError) => {
        if (!cancelled) setError(requestError.message);
      })
      .finally(() => {
        if (!cancelled) setPending(false);
      });
    return () => {
      cancelled = true;
    };
  }, [windowDays]);

  const totals = data?.totals;
  const maxBar = Math.max(
    totals?.openPulls || 0,
    totals?.mergedPulls || 0,
    totals?.openIssues || 0,
    1,
  );
  return (
    <section className="trends-section">
      <div className="trends-header">
        <div>
          <p className="eyebrow">Scalable insights</p>
          <h2>Cross-repository trends</h2>
          <p>
            Time-windowed, metadata-first aggregation across every tracked
            repository.
          </p>
        </div>
        <label className="window-selector">
          Window
          <select
            value={windowDays}
            onChange={(event) => setWindowDays(Number(event.target.value))}
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        </label>
      </div>
      {error && <p className="error-banner">{error}</p>}
      {pending ? (
        <div className="trends-pending">
          <span className="loader" />
          Aggregating {windowDays}-day window
        </div>
      ) : data ? (
        <>
          <div className="trends-kpi-grid">
            <Stat label="Open PRs" value={totals.openPulls} />
            <Stat label="Merged PRs" value={totals.mergedPulls} />
            <Stat label="Open issues" value={totals.openIssues} />
            <Stat label="Commits" value={totals.commits} />
            <Stat label="Contributors" value={totals.contributors} />
            <Stat label="Risky changes" value={data.risk?.count} />
            <Stat label="Late merges (>7d)" value={totals.lateMerges} />
          </div>
          <div className="trends-chart-row">
            <article className="trend-card">
              <div className="dashboard-card-heading">
                <div>
                  <p className="eyebrow">Open vs merged</p>
                  <h3>Pull request flow</h3>
                </div>
                <span>{windowDays}d</span>
              </div>
              <div className="trend-bars">
                {["openPulls", "mergedPulls", "openIssues"].map((key) => (
                  <div className="trend-bar-group" key={key}>
                    <span
                      className={
                        key === "openPulls"
                          ? "trend-bar open"
                          : key === "mergedPulls"
                            ? "trend-bar merged"
                            : "trend-bar issues"
                      }
                      style={{
                        height: `${Math.max(
                          4,
                          ((totals?.[key] || 0) / maxBar) * 100,
                        )}%`,
                      }}
                    />
                    <small>
                      {key === "openPulls"
                        ? "open PRs"
                        : key === "mergedPulls"
                          ? "merged"
                          : "open issues"}
                    </small>
                    <b>{totals?.[key] || 0}</b>
                  </div>
                ))}
              </div>
            </article>
            <article className="trend-card trend-table-card">
              <div className="dashboard-card-heading">
                <div>
                  <p className="eyebrow">Per repository</p>
                  <h3>Activity matrix</h3>
                </div>
                <span>{data.generated_ms}ms · cached 5min</span>
              </div>
              <table className="trend-table">
                <thead>
                  <tr>
                    <th>Repository</th>
                    <th>Open</th>
                    <th>Merged</th>
                    <th>Issues</th>
                    <th>Commits</th>
                    <th>People</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.repos || []).map((row) => (
                    <tr key={`${row.owner}/${row.repo}`}>
                      <td>
                        {row.owner}/{row.repo}
                      </td>
                      <td>{row.pulls?.open ?? 0}</td>
                      <td>{row.pulls?.merged ?? 0}</td>
                      <td>{row.issues?.open ?? 0}</td>
                      <td>{row.commits ?? 0}</td>
                      <td>{row.contributors ?? 0}</td>
                    </tr>
                  ))}
                  {!(data.repos || []).length && (
                    <tr>
                      <td colSpan={6}>
                        <EmptyState>
                          No repositories tracked yet — open an issue or PR to
                          track one.
                        </EmptyState>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              {(data.errors || []).length > 0 && (
                <p className="trend-errors">
                  {data.errors.length} repo(s) unavailable — isolated and
                  skipped.
                </p>
              )}
            </article>
          </div>
        </>
      ) : null}
      {summary && <SummaryTree summary={summary} windowDays={windowDays} />}
    </section>
  );
}

function SummaryRow({ label, value, depth = 0 }) {
  return (
    <div className="summary-row" style={{ paddingLeft: `${depth * 16}px` }}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

function FileLevel({ owner, repo, windowDays }) {
  const [files, setFiles] = useState(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function expand() {
    if (files || pending) return;
    setPending(true);
    setError("");
    try {
      setFiles(
        await trendsApi(`/api/trends/files/${owner}/${repo}?window=${windowDays}`, `/api/trends/trends/files/${owner}/${repo}?window=${windowDays}`),
      );
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="file-level">
      <button className="file-expand" type="button" onClick={expand}>
        <span>{files ? "▾" : "▸"}</span>
        Files changed
        <small>
          {pending
            ? "querying meta tier…"
            : files
              ? `${files.file_count} files`
              : "metadata-first (no diffs)"}
        </small>
      </button>
      {error && <p className="error-banner">{error}</p>}
      {files && (
        <div className="file-grid">
          {files.files.map((file) => (
            <div className="file-chip" key={file.file} title={file.file}>
              <span className="file-path">{file.file}</span>
              <small>
                {file.prs} PRs · +{file.additions}/-{file.deletions}
              </small>
            </div>
          ))}
          {!files.files.length && (
            <EmptyState>
              No file records in the meta tier for this window (indexed as PRs
              arrive).
            </EmptyState>
          )}
        </div>
      )}
    </div>
  );
}

function RepoDigest({ repo, windowDays }) {
  const [open, setOpen] = useState(false);
  const [showPrs, setShowPrs] = useState(false);
  const [showIssues, setShowIssues] = useState(false);
  return (
    <div className="digest-repo">
      <button
        className="digest-repo-head"
        type="button"
        onClick={() => setOpen(!open)}
      >
        <span>{open ? "▾" : "▸"}</span>
        <strong>
          {repo.owner}/{repo.repo}
        </strong>
        <small>
          {repo.commits.count} commits · {repo.prs.total} PRs ({repo.prs.merged}{" "}
          merged) · {repo.issues.open} open issues
          {repo.risk.count > 0 ? ` · ${repo.risk.count} risky` : ""}
        </small>
      </button>
      {open && (
        <div className="digest-repo-body">
          <div className="digest-grid">
            <div className="digest-card">
              <h4>Commits</h4>
              <SummaryRow label="Total" value={repo.commits.count} />
              <SummaryRow label="Top authors" value={""} />
              {repo.commits.top_authors.map((author) => (
                <SummaryRow
                  key={author.login}
                  label={`  ${author.login}`}
                  value={author.count}
                  depth={1}
                />
              ))}
              <ul className="digest-list">
                {repo.commits.recent.slice(0, 5).map((commit) => (
                  <li key={commit.sha}>
                    <span>{commit.message}</span>
                    <small>
                      {commit.sha} · {commit.author} ·{" "}
                      {commit.date ? formatDate(commit.date) : ""}
                    </small>
                  </li>
                ))}
              </ul>
            </div>
            <div className="digest-card">
              <button
                className="digest-card-toggle"
                type="button"
                onClick={() => setShowPrs(!showPrs)}
              >
                <h4>
                  Pull requests ({repo.prs.open} open / {repo.prs.merged}{" "}
                  merged)
                </h4>
                <span>{showPrs ? "▾" : "▸"}</span>
              </button>
              {showPrs && (
                <ul className="digest-list">
                  {repo.prs.list.map((pr) => (
                    <li key={pr.number}>
                      <span>
                        #{pr.number} {pr.title}
                      </span>
                      <small>
                        {pr.author} · {pr.state}
                        {pr.merged ? " · merged" : ""}
                      </small>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="digest-card">
              <button
                className="digest-card-toggle"
                type="button"
                onClick={() => setShowIssues(!showIssues)}
              >
                <h4>Unresolved issues ({repo.issues.unresolved})</h4>
                <span>{showIssues ? "▾" : "▸"}</span>
              </button>
              {showIssues && (
                <ul className="digest-list">
                  {repo.issues.list.map((issue) => (
                    <li key={issue.number}>
                      <span>
                        #{issue.number} {issue.title}
                      </span>
                      <small>
                        {issue.author} · {issue.state}
                      </small>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="digest-card">
              <h4>Risky changes ({repo.risk.count})</h4>
              <ul className="digest-list">
                {repo.risk.items.slice(0, 5).map((item, index) => (
                  <li key={`${item.number}-${index}`}>
                    <span>
                      #{item.number} {item.title}
                    </span>
                    <small>
                      {item.category} · {Math.round(item.confidence * 100)}% —{" "}
                      {item.reasoning}
                    </small>
                  </li>
                ))}
                {!repo.risk.items.length && (
                  <li>
                    <span>
                      No high-confidence security flags in this window.
                    </span>
                  </li>
                )}
              </ul>
            </div>
          </div>
          <FileLevel
            owner={repo.owner}
            repo={repo.repo}
            windowDays={windowDays}
          />
        </div>
      )}
    </div>
  );
}

function SummaryTree({ summary, windowDays }) {
  const [orgOpen, setOrgOpen] = useState(true);
  const org = summary.org;
  return (
    <section className="summary-section">
      <div className="summary-head">
        <p className="eyebrow">Hierarchical digest</p>
        <h3>Repository intelligence digest</h3>
        <small>
          {summary.window_days}-day window · generated in {summary.generated_ms}
          ms · expand a level only when needed
        </small>
      </div>
      <div className="digest-org">
        <button
          className="digest-org-head"
          type="button"
          onClick={() => setOrgOpen(!orgOpen)}
        >
          <span>{orgOpen ? "▾" : "▸"}</span>
          <strong>Organization</strong>
          <small>
            {org.repos} repos · {org.totals.commits} commits · {org.totals.prs}{" "}
            PRs ({org.totals.mergedPrs} merged, {org.totals.openPrs} open) ·{" "}
            {org.totals.openIssues} open issues · {org.totals.risky} risky
          </small>
        </button>
        {orgOpen && (
          <div className="digest-org-body">
            <div className="digest-grid org-grid">
              <div className="digest-card">
                <h4>Open vs merged</h4>
                <SummaryRow label="Open PRs" value={org.open_vs_merged.open} />
                <SummaryRow
                  label="Merged PRs"
                  value={org.open_vs_merged.merged}
                />
                <SummaryRow
                  label="Open/merged ratio"
                  value={org.open_vs_merged.ratio ?? "—"}
                />
              </div>
              <div className="digest-card">
                <h4>Top contributors</h4>
                {org.top_contributors.map((contributor) => (
                  <SummaryRow
                    key={contributor.login}
                    label={contributor.login}
                    value={contributor.count}
                  />
                ))}
              </div>
              <div className="digest-card">
                <h4>Risky changes</h4>
                <ul className="digest-list">
                  {org.risky_items.slice(0, 10).map((item, index) => (
                    <li key={`${item.repo}-${item.number}-${index}`}>
                      <span>
                        {item.repo} #{item.number} {item.title}
                      </span>
                      <small>
                        {item.category} · {Math.round(item.confidence * 100)}%
                      </small>
                    </li>
                  ))}
                  {!org.risky_items.length && (
                    <li>
                      <span>No high-confidence flags.</span>
                    </li>
                  )}
                </ul>
              </div>
            </div>
            <div className="digest-repos">
              {(summary.repos || []).map((repo) => (
                <RepoDigest
                  repo={repo}
                  windowDays={windowDays}
                  key={`${repo.owner}/${repo.repo}`}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function App() {
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem("repoguardian-theme");
    return (
      saved ||
      (window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light")
    );
  });
  const [user, setUser] = useState(null);
  const [repos, setRepos] = useState([]);
  const [selectedRepo, setSelectedRepo] = useState(null);
  const [details, setDetails] = useState(null);
  const [activeTab, setActiveTab] = useState("Overview");
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const filteredRepos = useMemo(
    () =>
      repos.filter((repo) =>
        `${repo.full_name} ${repo.description || ""}`
          .toLowerCase()
          .includes(search.toLowerCase()),
      ),
    [repos, search],
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("repoguardian-theme", theme);
  }, [theme]);

  useEffect(() => {
    async function load() {
      try {
        const currentUser = await api("/auth/me");
        setUser(currentUser);
        setRepos(await api("/api/repos"));
      } catch {
        setUser(null);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  async function selectRepo(repo) {
    setSelectedRepo(repo);
    setDetails(null);
    setActiveTab("Overview");
    setDetailLoading(true);
    setError("");
    try {
      setDetails(
        await api(`/api/repos/${repo.owner.login}/${repo.name}/details`),
      );
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setDetailLoading(false);
    }
  }

  async function logout() {
    try {
      await api("/auth/logout?format=json");
    } finally {
      setUser(null);
      setSelectedRepo(null);
      setDetails(null);
    }
  }

  if (loading)
    return (
      <div className="loading-screen">
        <span className="loader" />
        Loading your workspace
      </div>
    );
  if (!user)
    return (
      <main className="auth-shell">
        <button
          className="theme-toggle auth-theme-toggle"
          type="button"
          onClick={() => setTheme(theme === "light" ? "dark" : "light")}
          aria-label={`Switch to ${theme === "light" ? "dark" : "light"} theme`}
        >
          {theme === "light" ? "☾" : "☀"}
        </button>
        <section className="auth-card">
          <span className="brand-symbol">◈</span>
          <p className="eyebrow">RepoGuardian</p>
          <h1>Your repositories, clearly understood.</h1>
          <p>
            Explore activity, people, and progress across every GitHub
            repository in one calm workspace.
          </p>
          <div className="auth-actions">
            <a className="primary-button" href={`${API_BASE}/auth/github`}>
              Continue with GitHub <span>↗</span>
            </a>
            <a
              className="secondary-button"
              href={`${API_BASE}/auth/github/install`}
            >
              Install GitHub App <span>↗</span>
            </a>
          </div>
        </section>
      </main>
    );

  return (
    <div className="app-shell">
      <header className="app-header">
        <a
          className="brand"
          href="/"
          onClick={(event) => {
            event.preventDefault();
            setSelectedRepo(null);
          }}
        >
          <span className="brand-symbol">◈</span>
          <span>RepoGuardian</span>
        </a>
        <div className="header-actions">
          <button
            className="theme-toggle"
            type="button"
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
            aria-label={`Switch to ${theme === "light" ? "dark" : "light"} theme`}
          >
            {theme === "light" ? "☾" : "☀"}
          </button>
          <div className="account">
            <Avatar src={user.avatar_url} alt={user.login} />
            <span>{user.login}</span>
            <button className="logout-button" type="button" onClick={logout}>
              Log out
            </button>
          </div>
        </div>
      </header>
      {selectedRepo ? (
        detailLoading ? (
          <div className="loading-screen">
            <span className="loader" />
            Loading repository details
          </div>
        ) : details ? (
          <RepositoryDetail
            details={details}
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            onBack={() => setSelectedRepo(null)}
          />
        ) : (
          <div className="error-page">
            {error || "Unable to load this repository."}
            <button
              className="outline-button"
              type="button"
              onClick={() => selectRepo(selectedRepo)}
            >
              Try again
            </button>
          </div>
        )
      ) : (
        <main className="dashboard">
          <section className="dashboard-heading">
            <div>
              <p className="eyebrow">Workspace</p>
              <h1>Good to see you, {user.name || user.login}.</h1>
              <p>
                Select a repository to inspect its health, activity, and
                contributors.
              </p>
            </div>
            <div className="repo-total">
              <strong>{repos.length}</strong>
              <span>repositories</span>
            </div>
          </section>
          <div className="toolbar">
            <label className="search-box">
              <span>⌕</span>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search repositories"
              />
            </label>
          </div>
          {error && <p className="error-banner">{error}</p>}
          <section className="repo-grid">
            {filteredRepos.map((repo) => (
              <button
                className="repo-tile"
                type="button"
                key={repo.id}
                onClick={() => selectRepo(repo)}
              >
                <div className="tile-top">
                  <span className="repo-mark">◈</span>
                  <span
                    className={
                      repo.private ? "visibility private" : "visibility"
                    }
                  >
                    {repo.private ? "Private" : "Public"}
                  </span>
                </div>
                <h2>{repo.name}</h2>
                <p>{repo.description || "No description provided."}</p>
                <div className="tile-footer">
                  <span>{repo.language || "Repository"}</span>
                  <span>Updated {formatDate(repo.updated_at)}</span>
                </div>
                <span className="tile-arrow">↗</span>
              </button>
            ))}
            {!filteredRepos.length && (
              <EmptyState>No repositories match your search.</EmptyState>
            )}
          </section>
          <TrendsSection />
        </main>
      )}
    </div>
  );
}

export default App;
