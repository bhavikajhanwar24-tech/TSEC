const { Resend } = require("resend");
const { Sequelize, sequelize } = require("../models");

const CATEGORY_EMOJI = {
  security: "🔴",
  duplicate: "🔵",
  "needs-info": "🟡",
  stale: "⚪",
  staleness: "⚪",
  escalate: "🚨",
};

const CATEGORY_LABELS = {
  security: "Security",
  duplicate: "Duplicate",
  "needs-info": "Needs information",
  stale: "Stale issue",
  staleness: "Stale issue",
  escalate: "Escalation",
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function categoryAllowsNotification({ category, confidence, suggestedAction, reasoning, citedEvidence, agentName }) {
  const normalizedCategory = String(category || "").toLowerCase();
  const action = String(suggestedAction || "").toLowerCase();
  const evidence = JSON.stringify(citedEvidence || {}).toLowerCase();
  const explanation = `${action} ${String(reasoning || "").toLowerCase()} ${evidence}`;

  if (normalizedCategory === "security") return true;
  if (normalizedCategory === "needs-info") return false;
  if (normalizedCategory === "sentiment" || normalizedCategory === "contention") return false;
  if (/sentiment|contention/.test(String(agentName || "").toLowerCase())) return false;

  if (normalizedCategory === "duplicate") {
    const directDuplicate =
      (/\bduplicate\b/.test(action) || /\bclose(?:d)?\s+as\s+duplicate\b/.test(action)) &&
      !/related/.test(action);
    return directDuplicate && Number(confidence) >= 0.75 && !/related/.test(action);
  }

  if (normalizedCategory === "staleness" || normalizedCategory === "backlog") {
    return /\bescalate\b/.test(action);
  }

  if (normalizedCategory === "health_trend") {
    return /(inflection|change\s*point|changepoint)/.test(explanation) && !/no\s+(?:clear\s+)?inflection|routine/.test(explanation);
  }

  return false;
}

async function getNotificationRecipients({ repoFullName, category, confidence }) {
  const query = `
    SELECT github_user_id AS "githubUserId", user_email AS "userEmail"
    FROM notification_preferences
    WHERE repo_full_name = :repoFullName
      AND email_enabled = TRUE
      AND categories::jsonb @> CAST(:category AS jsonb)
      AND digest_mode = 'instant'
      AND (:categoryName = 'security' OR :confidence >= min_confidence)
  `;

  return sequelize.query(query, {
    replacements: {
      repoFullName,
      category: JSON.stringify([category]),
      categoryName: category,
      confidence: Number(confidence),
    },
    type: Sequelize.QueryTypes.SELECT,
  });
}

async function sendEscalationEmail({
  toEmail,
  repoFullName,
  issueTitle,
  issueNumber,
  category,
  confidence,
  reasoning,
  dashboardUrl,
}) {
  try {
    const normalizedCategory = String(category || "").toLowerCase();
    const categoryLabel = CATEGORY_LABELS[normalizedCategory] || normalizedCategory;
    const emoji = CATEGORY_EMOJI[normalizedCategory] || "🚨";
    const subject = `[${repoFullName}] ${categoryLabel}: ${issueTitle}`;
    const safeReasoning = String(reasoning || "").slice(0, 300);
    const percent = `${Math.round(Number(confidence) * 100)}%`;
    const resend = new Resend(process.env.RESEND_API_KEY);

    await resend.emails.send({
      from: process.env.NOTIFICATION_FROM_EMAIL || "onboarding@resend.dev",
      to: toEmail,
      subject,
      html: `
        <p>${emoji} <strong>${escapeHtml(categoryLabel)}</strong></p>
        <h2>${escapeHtml(issueTitle)} (#${escapeHtml(issueNumber)})</h2>
        <p><strong>Confidence:</strong> ${escapeHtml(percent)}</p>
        <p>${escapeHtml(safeReasoning)}</p>
        <p><a href="${escapeHtml(dashboardUrl)}">View in dashboard</a></p>
      `,
    });
    return true;
  } catch (error) {
    console.error("Failed to send escalation email:", error);
    return false;
  }
}

async function notifyMaintainersOfEscalation({
  repoFullName,
  category,
  confidence,
  issue,
  reasoning,
  suggestedAction,
  citedEvidence,
  agentName,
}) {
  try {
    if (!categoryAllowsNotification({
      category,
      confidence,
      suggestedAction,
      reasoning,
      citedEvidence,
      agentName,
    })) {
      return [];
    }

    const recipients = await getNotificationRecipients({ repoFullName, category, confidence });
    return Promise.all(
      recipients.map((recipient) => sendEscalationEmail({
        toEmail: recipient.userEmail,
        repoFullName,
        issueTitle: issue?.title || "GitHub issue",
        issueNumber: issue?.number || "",
        category,
        confidence,
        reasoning,
        dashboardUrl: process.env.DASHBOARD_URL || "",
      }))
    );
  } catch (error) {
    console.error("Failed to notify maintainers:", error);
    return [];
  }
}

module.exports = {
  getNotificationRecipients,
  sendEscalationEmail,
  notifyMaintainersOfEscalation,
  categoryAllowsNotification,
};