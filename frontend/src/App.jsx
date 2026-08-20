import { useEffect, useMemo, useState } from 'react'
import './App.css'

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'https://tsec-qjcg.onrender.com'
const tabs = ['Overview', 'Issues', 'Pull requests', 'Commits', 'Contributors', 'Code changes', 'AI Agents']

async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: 'include',
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(body.error || `Request failed (${response.status})`)
  }
  return response.json()
}

function formatDate(value) {
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(value))
}

function Stat({ label, value }) {
  return <div className="stat"><span>{label}</span><strong>{value ?? 0}</strong></div>
}

function Avatar({ src, alt = '' }) {
  return src ? <img className="avatar" src={src} alt={alt} /> : <span className="avatar avatar-fallback" aria-hidden="true">?</span>
}

function EmptyState({ children }) {
  return <div className="empty-state">{children}</div>
}

function IssueRow({ item, pull = false }) {
  return <article className="activity-row"><span className={`state-dot ${item.state === 'open' ? 'open' : 'closed'}`}>{pull ? '↗' : '#'}</span><div><h3>{item.title}</h3><p>#{item.number} opened by {item.user?.login || 'unknown'} · {formatDate(item.created_at)}</p></div><span className="row-state">{item.state}</span></article>
}

function CommitRow({ commit, owner, repo }) {
  const [expanded, setExpanded] = useState(false)
  const [details, setDetails] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function toggleCommit() {
    setExpanded(!expanded)
    if (!details && !loading) {
      setLoading(true)
      try {
        setDetails(await api(`/api/repos/${owner}/${repo}/commits/${commit.sha}`))
      } catch (requestError) {
        setError(requestError.message)
      } finally {
        setLoading(false)
      }
    }
  }

  return <div className="commit-block"><button className="activity-row commit-button" type="button" onClick={toggleCommit}><Avatar src={commit.author?.avatar_url || commit.committer?.avatar_url} /><div><h3>{commit.commit.message.split('\n')[0]}</h3><p>{commit.author?.login || commit.commit.author?.name || 'Unknown author'} · {formatDate(commit.commit.author?.date)}</p></div><code>{commit.sha.slice(0, 7)}</code><span className="commit-chevron">{expanded ? '⌃' : '⌄'}</span></button>{expanded && <div className="commit-details">{loading && <p className="detail-muted">Loading changed code...</p>}{error && <p className="detail-error">{error}</p>}{details && <>{<div className="change-summary"><span className="additions-text">+{details.stats?.additions || 0}</span><span className="deletions-text">-{details.stats?.deletions || 0}</span><span>{details.files?.length || 0} files changed</span></div>}{details.files?.map((file) => <div className="changed-file" key={file.filename}><div className="changed-file-heading"><strong>{file.filename}</strong><span>{file.status} · +{file.additions} -{file.deletions}</span></div><pre>{file.patch || 'No patch available for this file.'}</pre></div>)}</>}</div>}</div>
}

function ContributorRow({ contributor }) {
  return <article className="contributor-row"><Avatar src={contributor.avatar_url} alt={contributor.login} /><div><h3>{contributor.login}</h3><p>{contributor.contributions.toLocaleString()} contributions</p></div><div className="contribution-bar"><span style={{ width: `${Math.min(100, contributor.contributions / 2)}%` }} /></div></article>
}

function CodeChanges({ values, pending }) {
  const points = values.slice(-20)
  const max = Math.max(...points.map((point) => Math.max(point[1], point[2])), 1)
  if (pending) return <EmptyState>GitHub is still preparing code frequency data. Check again shortly.</EmptyState>
  if (!points.length) return <EmptyState>No code frequency data available yet.</EmptyState>
  return <div className="chart"><div className="chart-bars">{points.map((point) => <div className="bar-group" key={point[0]} title={`${point[1]} additions, ${Math.abs(point[2])} deletions`}><span className="bar additions" style={{ height: `${(point[1] / max) * 100}%` }} /><span className="bar deletions" style={{ height: `${(Math.abs(point[2]) / max) * 100}%` }} /></div>)}</div><div className="chart-legend"><span><i className="legend-additions" /> Additions</span><span><i className="legend-deletions" /> Deletions</span></div></div>
}

function AgentResult({ result }) {
  const highlight = typeof result?.summary === 'string' ? result.summary
    : typeof result?.conclusion === 'string' ? result.conclusion
    : typeof result?.report === 'string' ? result.report
    : typeof result?.verdict === 'string' ? result.verdict : null
  return <div className="agent-result">
    {highlight && <p className="agent-summary">{highlight}</p>}
    <pre>{JSON.stringify(result, null, 2)}</pre>
  </div>
}

function AgentRunner({ label, hint, run, disabled = false }) {
  const [status, setStatus] = useState('idle')
  const [result, setResult] = useState(null)
  const [message, setMessage] = useState('')
  const running = status === 'running'

  async function onClick() {
    if (running || disabled) return
    setStatus('running')
    setResult(null)
    setMessage('')
    try {
      setResult(await run())
      setStatus('done')
    } catch (err) {
      setMessage(err.message)
      setStatus('error')
    }
  }

  return <div className="agent-runner">
    <div className="agent-runner-head">
      <div>
        <h3>{label}</h3>
        {hint && <p>{hint}</p>}
      </div>
      <button className="outline-button" type="button" disabled={running || disabled} onClick={onClick}>
        {running ? <span className="loader loader-small" /> : 'Run agent'}
      </button>
    </div>
    {message && <p className="detail-error">{message}</p>}
    {result && <AgentResult result={result} />}
  </div>
}

function AgentsPanel({ owner, repo, issues }) {
  const openIssues = issues.filter((issue) => !issue.pull_request && issue.state === 'open')
  const [issueNumber, setIssueNumber] = useState(openIssues[0]?.number || '')

  return <div className="agents-panel">
    <div className="panel">
      <div className="panel-heading">
        <div><p className="eyebrow">Repository-wide</p><h2>Insight agents</h2></div>
        <span className="count-label">Runs against the whole repository</span>
      </div>
      <div className="agent-grid">
        <AgentRunner label="Backlog sweep" hint="Finds stale, forgotten issues and untriaged work." run={() => api('/api/agents/backlog-sweep', { method: 'POST', body: { owner, repo } })} />
        <AgentRunner label="Health report" hint="Tracks activity trends and flags declining contributors." run={() => api('/api/agents/health-report', { method: 'POST', body: { owner, repo } })} />
      </div>
    </div>
    <div className="panel">
      <div className="panel-heading">
        <div><p className="eyebrow">Issue-level</p><h2>Triage agents</h2></div>
        <span className="count-label">Analyze a single open issue</span>
      </div>
      <label className="agent-issue-picker">
        <span>Issue</span>
        <select value={issueNumber} onChange={(event) => setIssueNumber(Number(event.target.value))}>
          {openIssues.map((issue) => <option key={issue.id} value={issue.number}>#{issue.number} · {issue.title}</option>)}
        </select>
      </label>
      {!openIssues.length && <p className="detail-muted">No open issues to analyze.</p>}
      <div className="agent-grid">
        <AgentRunner label="Duplicate check" hint="Finds existing issues that this one duplicates." disabled={!issueNumber} run={() => api('/api/agents/duplicate-check', { method: 'POST', body: { owner, repo, issueNumber } })} />
        <AgentRunner label="Missing info" hint="Lists missing details that block triage." disabled={!issueNumber} run={() => api('/api/agents/missing-info', { method: 'POST', body: { owner, repo, issueNumber } })} />
        <AgentRunner label="Sensitivity check" hint="Flags sensitive or security-related content." disabled={!issueNumber} run={() => api('/api/agents/sensitivity-check', { method: 'POST', body: { owner, repo, issueNumber } })} />
        <AgentRunner label="Sentiment analysis" hint="Reads the tone of issue and pull request discussions." disabled={!issueNumber} run={() => api('/api/agents/sentiment-analysis', { method: 'POST', body: { owner, repo, issueNumber } })} />
      </div>
    </div>
  </div>
}

function RepositoryDetail({ details, activeTab, setActiveTab, onBack }) {
  const { repo, issues, pulls, commits, contributors, codeFrequency, codeFrequencyPending } = details
  const openIssues = issues.filter((issue) => !issue.pull_request && issue.state === 'open')
  const openPulls = pulls.filter((pull) => pull.state === 'open')
  const languages = Object.keys(repo.language ? { [repo.language]: true } : {})

  return <div className="detail-page">
    <button className="back-button" type="button" onClick={onBack}>← All repositories</button>
    <section className="repo-hero">
      <div className="repo-identity"><span className="repo-mark">◈</span><div><p className="eyebrow">Repository</p><h1>{repo.full_name}</h1><p>{repo.description || 'No description provided.'}</p></div></div>
      <a className="outline-button" href={repo.html_url} target="_blank" rel="noreferrer">Open on GitHub ↗</a>
    </section>
    <div className="stats"><Stat label="Stars" value={repo.stargazers_count.toLocaleString()} /><Stat label="Forks" value={repo.forks_count.toLocaleString()} /><Stat label="Open issues" value={openIssues.length} /><Stat label="Watchers" value={repo.subscribers_count?.toLocaleString()} /></div>
    <nav className="tabs" aria-label="Repository sections">{tabs.map((tab) => <button className={activeTab === tab ? 'active' : ''} type="button" key={tab} onClick={() => setActiveTab(tab)}>{tab}{tab === 'Issues' && <small>{issues.length}</small>}{tab === 'Pull requests' && <small>{pulls.length}</small>}</button>)}</nav>
    <section className="tab-content">
      {activeTab === 'Overview' && <div className="overview-grid"><div className="panel"><p className="eyebrow">About this repository</p><h2>Project snapshot</h2><dl className="details-list"><div><dt>Default branch</dt><dd>{repo.default_branch}</dd></div><div><dt>License</dt><dd>{repo.license?.name || 'Not specified'}</dd></div><div><dt>Created</dt><dd>{formatDate(repo.created_at)}</dd></div><div><dt>Last updated</dt><dd>{formatDate(repo.updated_at)}</dd></div></dl></div><div className="panel"><p className="eyebrow">Project signals</p><h2>At a glance</h2><div className="signal-list"><div><span>Primary language</span><strong>{languages[0] || 'Not specified'}</strong></div><div><span>Repository size</span><strong>{Math.round(repo.size / 1024)} MB</strong></div><div><span>Visibility</span><strong>{repo.private ? 'Private' : 'Public'}</strong></div></div></div></div>}
      {activeTab === 'Issues' && <div className="panel"><div className="panel-heading"><div><p className="eyebrow">Work tracking</p><h2>Issues</h2></div><span className="count-label">{issues.length} total</span></div>{issues.filter((issue) => !issue.pull_request).map((issue) => <IssueRow item={issue} key={issue.id} />)}{!issues.filter((issue) => !issue.pull_request).length && <EmptyState>No issues found.</EmptyState>}</div>}
      {activeTab === 'Pull requests' && <div className="panel"><div className="panel-heading"><div><p className="eyebrow">Code review</p><h2>Pull requests</h2></div><span className="count-label">{openPulls.length} open</span></div>{pulls.map((pull) => <IssueRow item={pull} pull key={pull.id} />)}{!pulls.length && <EmptyState>No pull requests found.</EmptyState>}</div>}
      {activeTab === 'Commits' && <div className="panel"><div className="panel-heading"><div><p className="eyebrow">Repository history</p><h2>Recent commits</h2></div><span className="count-label">Latest 30</span></div>{commits.map((commit) => <CommitRow commit={commit} owner={repo.owner.login} repo={repo.name} key={commit.sha} />)}{!commits.length && <EmptyState>No commits found.</EmptyState>}</div>}
      {activeTab === 'Contributors' && <div className="panel"><div className="panel-heading"><div><p className="eyebrow">People behind the code</p><h2>Contributors</h2></div><span className="count-label">{contributors.length} people</span></div>{contributors.map((contributor) => <ContributorRow contributor={contributor} key={contributor.id} />)}{!contributors.length && <EmptyState>No contributor data found.</EmptyState>}</div>}
      {activeTab === 'Code changes' && <div className="panel"><div className="panel-heading"><div><p className="eyebrow">Repository activity</p><h2>Code changes</h2></div><span className="count-label">Weekly view</span></div><CodeChanges values={codeFrequency} pending={codeFrequencyPending} /></div>}
      {activeTab === 'AI Agents' && <AgentsPanel owner={repo.owner.login} repo={repo.name} issues={issues} />}
    </section>
  </div>
}

function App() {
  const [user, setUser] = useState(null)
  const [repos, setRepos] = useState([])
  const [selectedRepo, setSelectedRepo] = useState(null)
  const [details, setDetails] = useState(null)
  const [activeTab, setActiveTab] = useState('Overview')
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const filteredRepos = useMemo(() => repos.filter((repo) => `${repo.full_name} ${repo.description || ''}`.toLowerCase().includes(search.toLowerCase())), [repos, search])

  useEffect(() => {
    async function load() {
      try {
        const currentUser = await api('/auth/me')
        setUser(currentUser)
        setRepos(await api('/api/repos'))
      } catch {
        setUser(null)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  async function selectRepo(repo) {
    setSelectedRepo(repo)
    setDetails(null)
    setActiveTab('Overview')
    setDetailLoading(true)
    setError('')
    try {
      setDetails(await api(`/api/repos/${repo.owner.login}/${repo.name}/details`))
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setDetailLoading(false)
    }
  }

  async function logout() {
    try {
      await api('/auth/logout?format=json')
    } finally {
      setUser(null)
      setSelectedRepo(null)
      setDetails(null)
    }
  }

  if (loading) return <div className="loading-screen"><span className="loader" />Loading your workspace</div>
  if (!user) return <main className="auth-shell"><section className="auth-card"><span className="brand-symbol">◈</span><p className="eyebrow">RepoGuardian</p><h1>Your repositories, clearly understood.</h1><p>Explore activity, people, and progress across every GitHub repository in one calm workspace.</p><div className="auth-actions"><a className="primary-button" href={`${API_BASE}/auth/github`}>Continue with GitHub <span>↗</span></a><a className="secondary-button" href={`${API_BASE}/auth/github/install`}>Install GitHub App <span>↗</span></a></div></section></main>

  return <div className="app-shell"><header className="app-header"><a className="brand" href="/" onClick={(event) => { event.preventDefault(); setSelectedRepo(null) }}><span className="brand-symbol">◈</span><span>RepoGuardian</span></a><div className="account"><Avatar src={user.avatar_url} alt={user.login} /><span>{user.login}</span><button className="logout-button" type="button" onClick={logout}>Log out</button></div></header>{selectedRepo ? (detailLoading ? <div className="loading-screen"><span className="loader" />Loading repository details</div> : details ? <RepositoryDetail details={details} activeTab={activeTab} setActiveTab={setActiveTab} onBack={() => setSelectedRepo(null)} /> : <div className="error-page">{error || 'Unable to load this repository.'}<button className="outline-button" type="button" onClick={() => selectRepo(selectedRepo)}>Try again</button></div>) : <main className="dashboard"><section className="dashboard-heading"><div><p className="eyebrow">Workspace</p><h1>Good to see you, {user.name || user.login}.</h1><p>Select a repository to inspect its health, activity, and contributors.</p></div><div className="repo-total"><strong>{repos.length}</strong><span>repositories</span></div></section><div className="toolbar"><label className="search-box"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search repositories" /></label></div>{error && <p className="error-banner">{error}</p>}<section className="repo-grid">{filteredRepos.map((repo) => <button className="repo-tile" type="button" key={repo.id} onClick={() => selectRepo(repo)}><div className="tile-top"><span className="repo-mark">◈</span><span className={repo.private ? 'visibility private' : 'visibility'}>{repo.private ? 'Private' : 'Public'}</span></div><h2>{repo.name}</h2><p>{repo.description || 'No description provided.'}</p><div className="tile-footer"><span>{repo.language || 'Repository'}</span><span>Updated {formatDate(repo.updated_at)}</span></div><span className="tile-arrow">↗</span></button>)}{!filteredRepos.length && <EmptyState>No repositories match your search.</EmptyState>}</section></main>}</div>
}

export default App
