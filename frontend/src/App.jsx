import { useEffect, useState } from 'react'
import './App.css'

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'https://tsec-qjcg.onrender.com'

async function api(path) {
  const response = await fetch(`${API_BASE}${path}`, { credentials: 'include' })
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(body.error || `Request failed (${response.status})`)
  }
  return response.json()
}

function TreeNode({ node, depth = 0 }) {
  const [open, setOpen] = useState(depth === 0)
  if (node.type === 'tree') {
    return <li className="tree-item"><button className="tree-toggle" type="button" onClick={() => setOpen(!open)}>{open ? '▾' : '▸'}</button><span className="tree-icon">📁</span><button className="tree-label folder-name" type="button" onClick={() => setOpen(!open)}>{node.name}</button>{open && <TreeList nodes={node.children} depth={depth + 1} />}</li>
  }
  return <li className="tree-item"><span className="tree-spacer" /><span className="tree-icon">📄</span><span className="file-name">{node.name}</span></li>
}

function TreeList({ nodes, depth = 0 }) {
  const entries = Object.values(nodes).sort((first, second) => {
    if (first.type !== second.type) return first.type === 'tree' ? -1 : 1
    return first.name.localeCompare(second.name)
  })
  return <ul className="tree" style={{ marginLeft: depth ? '1.1em' : 0 }}>{entries.map((node) => <TreeNode key={node.path} node={node} depth={depth} />)}</ul>
}

function buildTree(treeResponse) {
  const entries = Array.isArray(treeResponse?.tree) ? treeResponse.tree : []
  const root = { children: {} }
  entries.forEach((entry) => {
    const parts = entry.path.split('/')
    let current = root
    parts.forEach((name, index) => {
      const isLast = index === parts.length - 1
      current.children[name] ||= { name, type: isLast ? entry.type : 'tree', path: parts.slice(0, index + 1).join('/'), children: {} }
      current = current.children[name]
    })
  })
  return Object.values(root.children).sort((first, second) => first.name.localeCompare(second.name))
}

function App() {
  const [user, setUser] = useState(null)
  const [repos, setRepos] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [expandedRepo, setExpandedRepo] = useState(null)
  const [trees, setTrees] = useState({})

  useEffect(() => {
    async function loadUser() {
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
    loadUser()
  }, [])

  async function toggleTree(repo) {
    if (expandedRepo === repo.id) {
      setExpandedRepo(null)
      return
    }
    setExpandedRepo(repo.id)
    if (!trees[repo.id]) {
      try {
        const tree = await api(`/api/repos/${repo.owner.login}/${repo.name}/tree`)
        setTrees((current) => ({ ...current, [repo.id]: tree }))
      } catch (requestError) {
        setError(requestError.message)
      }
    }
  }

  if (loading) return <div className="status">Checking GitHub session...</div>

  return (
    <>
      <header className="topbar"><h1>RepoGuardian</h1>{user && <div className="user-chip"><img src={user.avatar_url} alt="" width="28" height="28" /><span>{user.login}</span><a className="btn small" href={`${API_BASE}/auth/logout`}>Logout</a></div>}</header>
      <main>
        {!user ? <section className="card login-card"><h2>Sign in to see your repositories</h2><p>Connect your GitHub account to browse your repos and their file structure.</p><a className="btn github-btn" href={`${API_BASE}/auth/github`}>Login with GitHub</a></section> : <section className="repo-list">{error && <p className="error">{error}</p>}{repos.length === 0 && <p className="empty">No repositories found.</p>}{repos.map((repo) => <div key={repo.id}><article className="repo-card"><div className="repo-info"><div className="repo-title"><strong>{repo.full_name}</strong><span className={`badge ${repo.private ? 'private' : 'public'}`}>{repo.private ? 'Private' : 'Public'}</span></div>{repo.description && <p className="repo-desc">{repo.description}</p>}<div className="repo-meta"><span>{repo.language || 'Unknown language'}</span><span>★ {repo.stargazers_count}</span><span>{repo.default_branch}</span></div></div><button className="btn small" type="button" onClick={() => toggleTree(repo)}>{expandedRepo === repo.id ? 'Hide structure' : 'Show structure'}</button></article>{expandedRepo === repo.id && trees[repo.id] && <div className="tree-view"><div className="tree-header">{repo.full_name} ({trees[repo.id].default_branch})</div><TreeList nodes={buildTree(trees[repo.id].tree)} /></div>}</div>)}</section>}
      </main>
    </>
  )
}

export default App
