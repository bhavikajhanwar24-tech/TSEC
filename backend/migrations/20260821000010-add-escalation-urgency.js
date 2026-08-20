"use strict";

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn("EscalationDecisions", "urgency", { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 });
    await queryInterface.addColumn("EscalationDecisions", "isDuplicateHotspot", { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false });
    await queryInterface.addColumn("EscalationDecisions", "duplicateHotspotCount", { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 });
    await queryInterface.addColumn("EscalationDecisions", "urgencyReasons", { type: Sequelize.JSON, allowNull: false, defaultValue: [] });
  },
  down: async (queryInterface) => {
    await queryInterface.removeColumn("EscalationDecisions", "urgencyReasons");
    await queryInterface.removeColumn("EscalationDecisions", "duplicateHotspotCount");
    await queryInterface.removeColumn("EscalationDecisions", "isDuplicateHotspot");
    await queryInterface.removeColumn("EscalationDecisions", "urgency");
  },
};