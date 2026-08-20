"use strict";

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn("EscalationDecisions", "triggeringEvent", { type: Sequelize.JSON, allowNull: true });
    await queryInterface.addColumn("EscalationDecisions", "retrievedEvidence", { type: Sequelize.JSON, allowNull: true });
    await queryInterface.addColumn("EscalationDecisions", "reasoningTrace", { type: Sequelize.JSON, allowNull: true });
    await queryInterface.addColumn("EscalationDecisions", "finalAction", { type: Sequelize.STRING, allowNull: true });
  },
  down: async (queryInterface) => {
    await queryInterface.removeColumn("EscalationDecisions", "finalAction");
    await queryInterface.removeColumn("EscalationDecisions", "reasoningTrace");
    await queryInterface.removeColumn("EscalationDecisions", "retrievedEvidence");
    await queryInterface.removeColumn("EscalationDecisions", "triggeringEvent");
  },
};