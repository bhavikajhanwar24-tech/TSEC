const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to parse JSON
app.use(bodyParser.json());

// Home route
app.get("/", (req, res) => {
  res.send("Hello from RepoGuardian SaaS!");
});

// OAuth callback placeholder
app.get("/auth/callback", (req, res) => {
  res.send("OAuth callback reached!");
});

// Webhook route
app.post("/webhook", (req, res) => {
  const event = req.headers["x-github-event"];
  const signature = req.headers["x-hub-signature-256"];
  const secret = process.env.GITHUB_WEBHOOK_SECRET;

  // Verify signature if secret is set
  if (secret && signature) {
    const hmac = crypto.createHmac("sha256", secret);
    const digest = "sha256=" + hmac.update(JSON.stringify(req.body)).digest("hex");

    if (digest !== signature) {
      return res.status(401).send("Invalid signature");
    }
  }

  console.log(`Received event: ${event}`);
  console.log(req.body);

  res.status(200).send("Webhook received");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
