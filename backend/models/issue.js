module.exports = (sequelize, DataTypes) => {
  const Issue = sequelize.define("Issue", {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    githubIssueId: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    repoFullName: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    number: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    title: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    body: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    author: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    state: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    isPullRequest: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      allowNull: false,
    },
    closedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  });

  Issue.associate = (models) => {
    Issue.hasMany(models.Label, { foreignKey: "issueId", as: "labels" });
    Issue.hasMany(models.IssueTimeline, { foreignKey: "issueId", as: "timelines" });
    Issue.hasMany(models.AgentRun, { foreignKey: "issueId", as: "agentRuns" });
  };

  return Issue;
};
