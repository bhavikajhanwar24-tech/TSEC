const express = require("express");
const session = require("express-session");
const cors = require("cors");
const dotenv = require("dotenv");
const authRoutes = require("./routes/auth");
const apiRoutes = require("./routes/api");
const agentRoutes = require("./routes/agents");
const webhookRoutes = require("./routes/webhooks");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const isHttps = process.env.NODE_ENV === "production" || process.env.FRONTEND_URL?.startsWith("https://");

app.set("trust proxy", 1);
app.use(express.json({
  verify(req, res, buffer) {
    req.rawBody = buffer;
  },
}));

app.use(
  cors({
    origin(origin, cb) {
      const allowed = process.env.FRONTEND_URL;
      if (!origin || !allowed || origin === allowed || origin.startsWith("http://localhost")) {
        return cb(null, true);
      }
      cb(new Error("CORS: origin not allowed"));
    },
    credentials: true,
  })
);

// Persistent sessions in Postgres when DATABASE_URL is configured, so logins
// survive server restarts and redeploys. Falls back to in-memory otherwise.
let sessionStore;
if (process.env.DATABASE_URL) {
  const PgSession = require("connect-pg-simple")(session);
  sessionStore = new PgSession({
    conString: process.env.DATABASE_URL,
    createTableIfMissing: true,
  });
}

app.use(
  session({
    store: sessionStore,
    secret: process.env.SESSION_SECRET || "dev-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: isHttps ? "none" : "lax",
      secure: isHttps,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    },
  })
);

app.use("/auth", authRoutes);
app.use("/api", apiRoutes);
app.use("/api/agents", agentRoutes);
app.use("/api/webhooks", webhookRoutes);
app.get("/health", (req, res) => res.json({ ok: true }));
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});