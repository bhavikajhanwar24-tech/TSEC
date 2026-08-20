import { useEffect, useMemo, useState } from "react";
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
  "Code changes",
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
    throw new Error(errorMessage);
  }

  return body ?? {};
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
        {pull ? "↗" : "#"}
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
    "duplicate",
    "Duplicate check",
    "Compares this issue with open issue history.",
  ],
  [
    "missingInfo",
    "Missing information",
    "Checks whether the report is actionable.",
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

function BacklogFlowChart({ labels, opened, closed, backlog, color }) {
  const w = 280;
  const h = 100;
  const pad = 8;
  const safeOpen = opened.map((v) => Number(v) || 0);
  const safeClosed = closed.map((v) => Number(v) || 0);
  const safeBacklog = backlog.map((v) => Number(v) || 0);
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
      </div>
      <div className="health-chart-labels">
        <span>{labels[0]}</span>
        <span>{labels[labels.length - 1]}</span>
      </div>
    </div>
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
  const responseTrend = (result.trends || []).find(
    (t) => t.metric === "time_to_first_response_days",
  );
  const responseMarker = responseTrend
    ? labels.indexOf(responseTrend.change_week)
    : undefined;
  const prLatency = series.pr_merge_latency_days || [];
  const showPr = has("pr_merge_latency_days") && prLatency.some((v) => v > 0);
  const kpis = [
    {
      label: "Response time (latest)",
      value: `${last("time_to_first_response_days")} days`,
    },
    { label: "Open backlog", value: `${Math.round(last("backlog_size"))}` },
    {
      label: "Opened / closed last week",
      value: `${Math.round(last("incoming_volume"))} / ${Math.round(last("issues_closed"))}`,
    },
    { label: "Duplicate rate", value: `${last("duplicate_rate")}%` },
    {
      label: "Contributors (new last week)",
      value: `${Math.round(last("active_contributors"))} (${Math.round(last("new_contributors"))})`,
    },
    {
      label: "PR merge latency",
      value: showPr ? `${last("pr_merge_latency_days")} days` : "—",
    },
  ];
  return (
    <div className="health-trend-detail">
      <div className="health-overview">
        <HealthScoreGauge
          score={result.health_score}
          status={result.health_status}
        />
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
      <div className="health-chart-grid">
        {has("time_to_first_response_days") && (
          <TrendChart
            title="Median time-to-first-response"
            labels={labels}
            values={series.time_to_first_response_days}
            color="#e5484d"
            format={(v) => `${v} days`}
            markerIndex={responseMarker}
          />
        )}
        {has("backlog_size") && (
          <BacklogFlowChart
            labels={labels}
            opened={series.incoming_volume}
            closed={series.issues_closed}
            backlog={series.backlog_size}
            color="#8e4ec6"
          />
        )}
        {has("duplicate_rate") && (
          <TrendChart
            title="Duplicate rate"
            labels={labels}
            values={series.duplicate_rate}
            color="#e5a13c"
            format={(v) => `${v}%`}
          />
        )}
        {showPr && (
          <TrendChart
            title="PR merge latency"
            labels={labels}
            values={series.pr_merge_latency_days}
            color="#0ea5e9"
            format={(v) => `${v} days`}
          />
        )}
        {has("active_contributors") && (
          <TrendChart
            title="Active contributors / week"
            labels={labels}
            values={series.active_contributors}
            color="#3b82f6"
            format={(v) => `${v}`}
          />
        )}
        {has("incoming_volume") && (
          <TrendChart
            title="Incoming issues / week"
            labels={labels}
            values={series.incoming_volume}
            color="#2f9e6e"
            format={(v) => `${v}`}
          />
        )}
      </div>
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, repo }),
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
      {!run && (
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
  issue,
  analysis,
  agents,
  complete,
  failed,
  error,
  notTriggered,
  escalation,
  onClose,
}) {
  const [activeAgent, setActiveAgent] = useState("sensitivity");
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
                  onClick={() => setActiveAgent(agent.key)}
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
                          The workflow will surface its findings here as soon as
                          they arrive.
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
          </main>
        </div>
      </div>
    </div>
  );
}

function AgentAnalysisView({ owner, repo, issue, onClose }) {
  const [analysis, setAnalysis] = useState(null);
  const [error, setError] = useState("");
  const [notTriggered, setNotTriggered] = useState(false);
  const [escalation, setEscalation] = useState(null);

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

  const agents = automaticAgents.map(([key, label, hint]) => ({
    key,
    label,
    hint,
    ...(analysis?.agents?.[key] || { status: "waiting" }),
  }));
  const complete = agents.filter((agent) => agent.status === "complete").length;
  const failed = agents.filter((agent) => agent.status === "failed").length;

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
        issue={issue}
        analysis={analysis}
        agents={agents}
        complete={complete}
        failed={failed}
        error={error}
        notTriggered={notTriggered}
        escalation={escalation}
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
                      : "Running"}
                </strong>
                <span>analysis status</span>
              </div>
              <div>
                <strong>{failed}</strong>
                <span>errors</span>
              </div>
            </div>
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
              {agents.map((agent) => (
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
    codeFrequency = [],
  } = details;
  const [selectedIssue, setSelectedIssue] = useState(null);
  const [chatOpen, setChatOpen] = useState(false);
  const openIssues = issues.filter(
    (issue) => !issue.pull_request && issue.state === "open",
  );
  const workflowIssues = issues.filter(
    (issue) =>
      workflowStatuses[issue.number] &&
      workflowStatuses[issue.number] !== "complete",
  );
  const escalationIssues = issues.filter(
    (issue) => escalationDecisions[issue.number]?.needsAttention,
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
  const categoryCounts = issues.reduce((counts, issue) => {
    const label = issue.labels?.[0]?.name || "Other";
    counts[label] = (counts[label] || 0) + 1;
    return counts;
  }, {});
  const topCategories = Object.entries(categoryCounts)
    .sort(([, first], [, second]) => second - first)
    .slice(0, 5);
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
              {topCategories.length ? (
                <div className="category-list">
                  {topCategories.map(([category, count]) => (
                    <div className="category-row" key={category}>
                      <strong>{category}</strong>
                      <div>
                        <span
                          style={{
                            width: `${(count / Math.max(1, topCategories[0][1])) * 100}%`,
                          }}
                        />
                      </div>
                      <b>
                        {Math.round((count / Math.max(1, issues.length)) * 100)}
                        %
                      </b>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState>No issue categories yet.</EmptyState>
              )}
            </article>
            <article className="repo-dashboard-card recent-card">
              <div className="dashboard-card-heading">
                <div>
                  <p className="eyebrow">Live queue</p>
                  <h2>Recent issues</h2>
                </div>
                <span>{openIssues.length} open</span>
              </div>
              <div className="recent-issue-list">
                {issues
                  .filter((issue) => !issue.pull_request)
                  .slice(0, 5)
                  .map((issue) => (
                    <button
                      className="recent-issue-row"
                      type="button"
                      key={issue.id}
                      onClick={() => setSelectedIssue(issue)}
                    >
                      <span
                        className={`state-dot ${issue.state === "open" ? "open" : "closed"}`}
                      >
                        #
                      </span>
                      <span>
                        <strong>{issue.title}</strong>
                        <small>
                          #{issue.number} · {formatDate(issue.created_at)}
                        </small>
                      </span>
                      <em>{issue.state}</em>
                      <span className="issue-arrow">→</span>
                    </button>
                  ))}
                {!openIssues.length && (
                  <EmptyState>No issues found.</EmptyState>
                )}
              </div>
            </article>
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
    codeFrequency = [],
    codeFrequencyPending,
  } = details;
  const [selectedIssue, setSelectedIssue] = useState(null);
  const [chatOpen, setChatOpen] = useState(false);
  const openIssues = issues.filter(
    (issue) => !issue.pull_request && issue.state === "open",
  );
  const openPulls = pulls.filter((pull) => pull.state === "open");
  const escalationIssues = issues.filter(
    (issue) =>
      !issue.pull_request && escalationDecisions[issue.number]?.needsAttention,
  );
  const highPriorityIssues = [...escalationIssues].sort(
    (first, second) =>
      Number(escalationDecisions[second.number]?.aggregateConfidence || 0) -
      Number(escalationDecisions[first.number]?.aggregateConfidence || 0),
  );
  const content = {
    Health: <HealthPanel owner={repo.owner.login} repo={repo.name} />,
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
            <h2>Needs Your Attention</h2>
          </div>
          <span className="count-label">{highPriorityIssues.length}</span>
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
                      {Math.round(
                        Number(decision.aggregateConfidence || 0) * 100,
                      )}
                      % confidence
                    </strong>
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
          <span className="count-label">{contributors.length} people</span>
        </div>
        {contributors.map((contributor, index) => (
          <ContributorRow
            contributor={contributor}
            key={contributor.id || contributor.login || `contributor-${index}`}
          />
        ))}
        {!contributors.length && (
          <EmptyState>No contributor data found.</EmptyState>
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
        </main>
      )}
    </div>
  );
}

export default App;
