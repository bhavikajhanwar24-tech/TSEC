module.exports = (sequelize, DataTypes) => {
  const Feedback = sequelize.define("Feedback", {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    agentRunId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: "AgentRuns",
        key: "id",
      },
    },
    userGithubId: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    rating: {
      type: DataTypes.ENUM("helpful", "not_helpful"),
      allowNull: false,
    },
    comment: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
  });

  Feedback.associate = (models) => {
    Feedback.belongsTo(models.AgentRun, { foreignKey: "agentRunId", as: "agentRun" });
  };

  return Feedback;
};
