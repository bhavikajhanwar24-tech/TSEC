"use strict";

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn("AgentRuns", "triggeringEvent", { type: Sequelize.JSON, allowNull: true });
    await queryInterface.addColumn("AgentRuns", "toolCalls", { type: Sequelize.JSON, allowNull: true });
    await queryInterface.addColumn("AgentRuns", "reasoningTrace", { type: Sequelize.JSON, allowNull: true });
    await queryInterface.addColumn("AgentRuns", "finalAction", { type: Sequelize.STRING, allowNull: true });
    await queryInterface.addColumn("Feedbacks", "repoFullName", { type: Sequelize.STRING, allowNull: true });
    await queryInterface.addColumn("Feedbacks", "verdict", { type: Sequelize.ENUM("approved", "corrected"), allowNull: true });
    await queryInterface.addColumn("Feedbacks", "correctionType", { type: Sequelize.STRING, allowNull: true });
    await queryInterface.addColumn("Feedbacks", "correctionDetail", { type: Sequelize.TEXT, allowNull: true });
  },
  down: async (queryInterface) => {
    await queryInterface.removeColumn("Feedbacks", "correctionDetail");
    await queryInterface.removeColumn("Feedbacks", "correctionType");
    await queryInterface.removeColumn("Feedbacks", "verdict");
    await queryInterface.removeColumn("Feedbacks", "repoFullName");
    await queryInterface.removeColumn("AgentRuns", "finalAction");
    await queryInterface.removeColumn("AgentRuns", "reasoningTrace");
    await queryInterface.removeColumn("AgentRuns", "toolCalls");
    await queryInterface.removeColumn("AgentRuns", "triggeringEvent");
  },
};