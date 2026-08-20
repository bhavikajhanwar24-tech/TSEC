const path = require("path");
const express = require("express");
const session = require("express-session");
const cors = require("cors");
const dotenv = require("dotenv");
const authRoutes = require("./routes/auth");
const apiRoutes = require("./routes/api");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const isHttps = process.env.NODE_ENV === "production" || process.env.FRONTEND_URL?.startsWith("https://");

app.set("trust proxy", 1);
app.use(express.json());

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

app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: isHttps ? "none" : "lax",
      secure: isHttps,
    },
  })
);

app.use("/auth", authRoutes);
app.use("/api", apiRoutes);
app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});