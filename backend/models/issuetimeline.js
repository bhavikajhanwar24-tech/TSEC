module.exports = (sequelize, DataTypes) => {
  const IssueTimeline = sequelize.define("IssueTimeline", {
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
    eventType: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    actor: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    body: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
  });

  IssueTimeline.associate = (models) => {
    IssueTimeline.belongsTo(models.Issue, { foreignKey: "issueId", as: "issue" });
  };

  return IssueTimeline;
};
