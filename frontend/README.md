# RepoGuardian Frontend

React and Vite frontend for RepoGuardian. The backend API is deployed separately.

## Local development

```powershell
npm install
npm run dev
```

The app uses `VITE_API_BASE_URL` from `.env` when provided. Copy `.env.example` to `.env` to configure a different backend URL.

Set the deployed backend's `FRONTEND_URL` to `http://localhost:5173` while testing this local frontend. The GitHub OAuth callback URL must remain the deployed backend URL ending in `/auth/github/callback`.
