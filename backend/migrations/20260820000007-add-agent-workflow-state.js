"use strict";

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn("Issues", "workflowStatus", { type: Sequelize.STRING, allowNull: false, defaultValue: "queued" });
    await queryInterface.addColumn("Issues", "workflowStep", { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 });
    await queryInterface.addColumn("Issues", "workflowOutput", { type: Sequelize.JSON, allowNull: true });
    await queryInterface.addColumn("AgentRuns", "step", { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 });
    await queryInterface.addColumn("AgentRuns", "status", { type: Sequelize.STRING, allowNull: false, defaultValue: "running" });
    await queryInterface.addColumn("AgentRuns", "output", { type: Sequelize.JSON, allowNull: true });
  },
  down: async (queryInterface) => {
    await queryInterface.removeColumn("AgentRuns", "output");
    await queryInterface.removeColumn("AgentRuns", "status");
    await queryInterface.removeColumn("AgentRuns", "step");
    await queryInterface.removeColumn("Issues", "workflowOutput");
    await queryInterface.removeColumn("Issues", "workflowStep");
    await queryInterface.removeColumn("Issues", "workflowStatus");
  },
};