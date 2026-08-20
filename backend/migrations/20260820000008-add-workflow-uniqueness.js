"use strict";

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      DELETE FROM "AgentRuns" older
      USING "AgentRuns" newer
      WHERE older."issueId" = newer."issueId"
        AND older."agentName" = newer."agentName"
        AND older."createdAt" < newer."createdAt"
    `);
    await queryInterface.addIndex("Issues", ["repoFullName", "number"], {
      unique: true,
      name: "issues_repo_full_name_number_unique",
    });
    await queryInterface.addIndex("AgentRuns", ["issueId", "agentName"], {
      unique: true,
      name: "agent_runs_issue_agent_unique",
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeIndex("AgentRuns", "agent_runs_issue_agent_unique");
    await queryInterface.removeIndex("Issues", "issues_repo_full_name_number_unique");
  },
};
