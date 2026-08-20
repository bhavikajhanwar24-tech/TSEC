import { useEffect, useMemo, useState } from 'react'
import './App.css'

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'https://tsec-qjcg.onrender.com'
const tabs = ['Overview', 'Issues', 'Pull requests', 'Commits', 'Contributors', 'Code changes']

async function api(path, options = {}) {
  const url = `${API_BASE}${path}`
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: 'include',
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(body.error || `Request failed (${response.status}) at ${url}`)
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

function IssueRow({ item, pull = false, onClick, workflowStatus }) {
  const canOpenAnalysis = Boolean(workflowStatus)
  return <button className="activity-row issue-button" type="button" disabled={!canOpenAnalysis} onClick={() => canOpenAnalysis && onClick?.(item)}><span className={`state-dot ${item.state === 'open' ? 'open' : 'closed'}`}>{pull ? '↗' : '#'}</span><div><h3>{item.title}</h3><p>#{item.number} opened by {item.user?.login || 'unknown'} · {formatDate(item.created_at)}</p></div><span className="row-state">{item.state}</span><span className={`workflow-badge ${workflowStatus || 'not-triggered'}`}>{workflowStatus ? workflowStatus.replaceAll('_', ' ') : 'not triggered'}</span>{canOpenAnalysis && <span className="issue-arrow">→</span>}</button>
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

function RepositoryChat({ owner, repo }) {
  const [question, setQuestion] = useState('')
  const [messages, setMessages] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const suggestions = ['Which issues are waiting for information?', 'What problems were solved recently?', 'Which PRs relate to security?']

  async function ask(event) {
    event.preventDefault()
    const value = question.trim()
    if (!value || loading) return
    setQuestion('')
    setError('')
    setMessages((current) => [...current, { role: 'user', text: value }])
    setLoading(true)
    try {
      const result = await api(`/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/chat`, { method: 'POST', body: { question: value } })
      setMessages((current) => [...current, { role: 'assistant', text: result.answer, sources: result.sources || [] }])
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setLoading(false)
    }
  }

  return <section className="repo-chat panel"><div className="chat-heading"><div><p className="eyebrow">Repository memory</p><h2>Ask about this repository</h2><p>Search issues, pull requests, workflow decisions, and solved history.</p></div><span className="chat-status">RAG enabled</span></div><div className="chat-suggestions">{suggestions.map((suggestion) => <button type="button" key={suggestion} onClick={() => setQuestion(suggestion)}>{suggestion}</button>)}</div><div className="chat-transcript" aria-live="polite">{!messages.length && <EmptyState>Ask a repository question to see grounded history.</EmptyState>}{messages.map((message, index) => <div className={`chat-message ${message.role}`} key={`${message.role}-${index}`}><span className="chat-role">{message.role === 'user' ? 'You' : 'RepoGuardian'}</span><p>{message.text}</p>{message.sources?.length > 0 && <div className="chat-sources">{message.sources.map((source) => <span key={source.source}>{source.source}</span>)}</div>}</div>)}{loading && <div className="chat-message assistant"><span className="chat-role">RepoGuardian</span><p className="chat-loading">Searching repository history...</p></div>}</div>{error && <p className="detail-error">{error}</p>}<form className="chat-form" onSubmit={ask}><textarea value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Ask about issues, PRs, fixes, or workflow history..." rows="2" maxLength="1200" /><button className="primary-button" type="submit" disabled={loading || !question.trim()}>{loading ? 'Searching...' : 'Ask'}</button></form></section>
}

const automaticAgents = [
  ['duplicate', 'Duplicate check', 'Compares this issue with open issue history.'],
  ['missingInfo', 'Missing information', 'Checks whether the report is actionable.'],
  ['sensitivity', 'Security sensitivity', 'Scans for secrets and security concerns.'],
  ['sentiment', 'Sentiment', 'Measures conversation tone and contention.'],
  ['backlog', 'Backlog context', 'Places the issue in repository-wide work context.'],
  ['health', 'Repository health', 'Summarizes current project health signals.'],
]

function AgentAnalysisView({ owner, repo, issue, onClose }) {
  const [analysis, setAnalysis] = useState(null)
  const [error, setError] = useState('')
  const [notTriggered, setNotTriggered] = useState(false)

  useEffect(() => {
    let active = true
    async function load() {
      try {
        const result = await api(`/api/webhooks/analysis/${owner}/${repo}/${issue.number}`)
        if (active) { setAnalysis(result); setError(''); setNotTriggered(false) }
      } catch (requestError) {
        if (active && requestError.message.startsWith('No automatic analysis')) {
          setNotTriggered(true)
          setError('This issue was created before automatic analysis was enabled.')
        } else if (active) {
          setError(requestError.message)
        }
      }
    }
    load()
    const timer = setInterval(() => { if (!notTriggered) load() }, 4000)
    return () => { active = false; clearInterval(timer) }
  }, [owner, repo, issue.number, notTriggered])

  const agents = automaticAgents.map(([key, label, hint]) => ({ key, label, hint, ...(analysis?.agents?.[key] || { status: 'waiting' }) }))
  const complete = agents.filter((agent) => agent.status === 'complete').length
  const failed = agents.filter((agent) => agent.status === 'failed').length

  const duplicate = agents.find((agent) => agent.key === 'duplicate')?.result
  const duplicateMatches = duplicate?.matches?.filter((match) => match.classification === 'direct_duplicate') || []
  const missing = agents.find((agent) => agent.key === 'missingInfo')?.result
  const sensitivity = agents.find((agent) => agent.key === 'sensitivity')?.result
  return <div className="analysis-overlay"><div className="analysis-drawer"><div className="analysis-header"><div><p className="eyebrow">Automatic triage</p><h2>Issue #{issue.number}</h2><p>{issue.title}</p></div><button className="close-button" type="button" onClick={onClose}>×</button></div><div className="analysis-issue"><span className="issue-number">#{issue.number}</span><div><strong>{issue.title}</strong><p>{issue.body || 'No description provided.'}</p></div></div>{notTriggered ? <div className="not-triggered-panel"><h3>Automatic analysis was not triggered</h3><p>This issue was created before automatic analysis was enabled. Agents will run automatically for newly created issues and future issue changes.</p></div> : <><div className="analysis-summary"><div><strong>{complete}/{agents.length}</strong><span>agents complete</span></div><div><strong>{analysis?.status === 'complete' ? 'Ready' : analysis?.status === 'waiting_missing_info' ? 'Waiting for reporter' : 'Running'}</strong><span>analysis status</span></div><div><strong>{failed}</strong><span>errors</span></div></div>{duplicateMatches.length > 0 && <section className="decision-panel duplicate-panel"><p className="eyebrow">Duplicate flow</p><h3>Matched open issues</h3><p>This issue has been mapped to the existing issue below and the workflow stopped.</p>{duplicateMatches.map((match) => <a href={match.url} target="_blank" rel="noreferrer" className="match-card" key={match.issue_number}><strong>#{match.issue_number} · {match.title}</strong><span>{Math.round((match.similarity_score || 0) * 100)}% similarity ↗</span></a>)}</section>}{missing?.missing_fields?.length > 0 && <section className="decision-panel missing-panel"><p className="eyebrow">Missing information</p><h3>Waiting for reporter details</h3><p>{missing.draft_comment || missing.missing_details?.join(', ')}</p></section>}{sensitivity && <section className="decision-panel sensitivity-panel"><p className="eyebrow">Security sensitivity</p><h3>{sensitivity.severity || sensitivity.risk_level || 'Security scan complete'}</h3><p>{sensitivity.recommendation || sensitivity.summary || 'No additional security escalation was reported.'}</p></section>}{error && <p className="detail-error">{error}</p>}<div className="agent-result-grid">{agents.map((agent) => <article className="agent-result-card" key={agent.key}><div className="agent-card-heading"><div><h3>{agent.label}</h3><p>{agent.hint}</p></div><span className={`agent-status ${agent.status}`}>{agent.status}</span></div>{agent.status === 'running' && <div className="agent-progress"><span /></div>}{agent.error && <p className="detail-error">{agent.error}</p>}{agent.result && <pre>{JSON.stringify(agent.result, null, 2)}</pre>}</article>)}</div></>}</div></div>
}

function RepositoryDetail({ details, activeTab, setActiveTab, onBack }) {
  const { repo, issues = [], pulls = [], commits = [], contributors = [], codeFrequency = [], codeFrequencyPending } = details
  const openIssues = issues.filter((issue) => !issue.pull_request && issue.state === 'open')
  const openPulls = pulls.filter((pull) => pull.state === 'open')
  const languages = Object.keys(repo.language ? { [repo.language]: true } : {})
  const [selectedIssue, setSelectedIssue] = useState(null)
  const [workflowStatuses, setWorkflowStatuses] = useState({})

  useEffect(() => {
    api(`/api/webhooks/analysis/${repo.owner.login}/${repo.name}`).then(({ statuses }) => {
      setWorkflowStatuses(Object.fromEntries(statuses.map((item) => [item.number, item.status])))
    }).catch(() => setWorkflowStatuses({}))
  }, [repo.owner.login, repo.name])

  return <div className="detail-page">
    <button className="back-button" type="button" onClick={onBack}>← All repositories</button>
    <section className="repo-hero">
      <div className="repo-identity"><span className="repo-mark">◈</span><div><p className="eyebrow">Repository</p><h1>{repo.full_name}</h1><p>{repo.description || 'No description provided.'}</p></div></div>
      <a className="outline-button" href={repo.html_url} target="_blank" rel="noreferrer">Open on GitHub ↗</a>
    </section>
    <div className="stats"><Stat label="Stars" value={(repo.stargazers_count || 0).toLocaleString()} /><Stat label="Forks" value={(repo.forks_count || 0).toLocaleString()} /><Stat label="Open issues" value={openIssues.length} /><Stat label="Watchers" value={(repo.subscribers_count || 0).toLocaleString()} /></div>
    <nav className="tabs" aria-label="Repository sections">{tabs.map((tab) => <button className={activeTab === tab ? 'active' : ''} type="button" key={tab} onClick={() => setActiveTab(tab)}>{tab}{tab === 'Issues' && <small>{issues.length}</small>}{tab === 'Pull requests' && <small>{pulls.length}</small>}</button>)}</nav>
    <section className="tab-content">
      {activeTab === 'Overview' && <div className="overview-grid"><div className="panel"><p className="eyebrow">About this repository</p><h2>Project snapshot</h2><dl className="details-list"><div><dt>Default branch</dt><dd>{repo.default_branch}</dd></div><div><dt>License</dt><dd>{repo.license?.name || 'Not specified'}</dd></div><div><dt>Created</dt><dd>{formatDate(repo.created_at)}</dd></div><div><dt>Last updated</dt><dd>{formatDate(repo.updated_at)}</dd></div></dl></div><div className="panel"><p className="eyebrow">Project signals</p><h2>At a glance</h2><div className="signal-list"><div><span>Primary language</span><strong>{languages[0] || 'Not specified'}</strong></div><div><span>Repository size</span><strong>{Math.round(repo.size / 1024)} MB</strong></div><div><span>Visibility</span><strong>{repo.private ? 'Private' : 'Public'}</strong></div></div></div></div>}
      {activeTab === 'Issues' && <div className="panel"><div className="panel-heading"><div><p className="eyebrow">Work tracking</p><h2>Issues</h2></div><span className="count-label">{issues.length} total · new issues analyze automatically</span></div>{issues.filter((issue) => !issue.pull_request).map((issue) => <IssueRow item={issue} workflowStatus={workflowStatuses[issue.number]} onClick={setSelectedIssue} key={issue.id} />)}{!issues.filter((issue) => !issue.pull_request).length && <EmptyState>No issues found.</EmptyState>}</div>}
      {activeTab === 'Pull requests' && <div className="panel"><div className="panel-heading"><div><p className="eyebrow">Code review</p><h2>Pull requests</h2></div><span className="count-label">{openPulls.length} open</span></div>{pulls.map((pull) => <IssueRow item={pull} pull key={pull.id} />)}{!pulls.length && <EmptyState>No pull requests found.</EmptyState>}</div>}
      {activeTab === 'Commits' && <div className="panel"><div className="panel-heading"><div><p className="eyebrow">Repository history</p><h2>Recent commits</h2></div><span className="count-label">Latest 30</span></div>{commits.map((commit) => <CommitRow commit={commit} owner={repo.owner.login} repo={repo.name} key={commit.sha} />)}{!commits.length && <EmptyState>No commits found.</EmptyState>}</div>}
      {activeTab === 'Contributors' && <div className="panel"><div className="panel-heading"><div><p className="eyebrow">People behind the code</p><h2>Contributors</h2></div><span className="count-label">{contributors.length} people</span></div>{contributors.map((contributor) => <ContributorRow contributor={contributor} key={contributor.id} />)}{!contributors.length && <EmptyState>No contributor data found.</EmptyState>}</div>}
      {activeTab === 'Code changes' && <div className="panel"><div className="panel-heading"><div><p className="eyebrow">Repository activity</p><h2>Code changes</h2></div><span className="count-label">Weekly view</span></div><CodeChanges values={codeFrequency} pending={codeFrequencyPending} /></div>}
    </section>
    <RepositoryChat owner={repo.owner.login} repo={repo.name} />
    {selectedIssue && <AgentAnalysisView owner={repo.owner.login} repo={repo.name} issue={selectedIssue} onClose={() => setSelectedIssue(null)} />}
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
