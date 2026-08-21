"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("ChatSessions", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      },
      owner: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      repo: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      githubUserId: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      title: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW,
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW,
      },
    });

    await queryInterface.createTable("ChatMessages", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      },
      sessionId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: {
          model: "ChatSessions",
          key: "id",
        },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      role: {
        type: Sequelize.ENUM("user", "assistant"),
        allowNull: false,
      },
      content: {
        type: Sequelize.TEXT,
        allowNull: false,
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW,
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW,
      },
    });

    await queryInterface.addIndex("ChatSessions", ["owner", "repo", "githubUserId"]);
    await queryInterface.addIndex("ChatMessages", ["sessionId"]);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable("ChatMessages");
    await queryInterface.dropTable("ChatSessions");
  },
};