module.exports = (sequelize, DataTypes) => {
  const AgentRun = sequelize.define("AgentRun", {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    issueId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: "Issues",
        key: "id",
      },
    },
    agentName: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    category: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    confidence: {
      type: DataTypes.FLOAT,
      allowNull: false,
    },
    reasoning: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    citedEvidence: {
      type: DataTypes.JSON,
      allowNull: true,
    },
    triggeringEvent: { type: DataTypes.JSON, allowNull: true },
    toolCalls: { type: DataTypes.JSON, allowNull: true },
    reasoningTrace: { type: DataTypes.JSON, allowNull: true },
    finalAction: { type: DataTypes.STRING, allowNull: true },
    suggestedAction: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    step: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    status: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "running",
    },
    output: {
      type: DataTypes.JSON,
      allowNull: true,
    },
  });

  AgentRun.associate = (models) => {
    AgentRun.belongsTo(models.Issue, { foreignKey: "issueId", as: "issue" });
    AgentRun.hasMany(models.Feedback, { foreignKey: "agentRunId", as: "feedbacks" });
  };

  return AgentRun;
};
