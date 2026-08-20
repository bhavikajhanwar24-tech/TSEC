"use strict";

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable("EscalationDecisions", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      issueId: {
        type: Sequelize.UUID,
        allowNull: false,
        unique: true,
        references: { model: "Issues", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      needsAttention: { type: Sequelize.BOOLEAN, allowNull: false },
      triggeringCategories: { type: Sequelize.JSON, allowNull: false, defaultValue: [] },
      aggregateConfidence: { type: Sequelize.FLOAT, allowNull: false, defaultValue: 0 },
      perCategoryBreakdown: { type: Sequelize.JSON, allowNull: false, defaultValue: {} },
      notificationSent: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable("EscalationDecisions");
  },
};
