"use strict";

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable("AgentRuns", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      issueId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: {
          model: "Issues",
          key: "id",
        },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      agentName: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      category: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      confidence: {
        type: Sequelize.FLOAT,
        allowNull: false,
      },
      reasoning: {
        type: Sequelize.TEXT,
        allowNull: false,
      },
      citedEvidence: {
        type: Sequelize.JSON,
        allowNull: true,
      },
      suggestedAction: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
      },
    });
  },
  down: async (queryInterface, Sequelize) => {
    await queryInterface.dropTable("AgentRuns");
  },
};
