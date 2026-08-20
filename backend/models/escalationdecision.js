module.exports = (sequelize, DataTypes) => {
  const EscalationDecision = sequelize.define("EscalationDecision", {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    issueId: {
      type: DataTypes.UUID,
      allowNull: false,
      unique: true,
      references: {
        model: "Issues",
        key: "id",
      },
      onUpdate: "CASCADE",
      onDelete: "CASCADE",
    },
    needsAttention: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
    },
    triggeringCategories: {
      type: DataTypes.JSON,
      allowNull: false,
      defaultValue: [],
    },
    aggregateConfidence: {
      type: DataTypes.FLOAT,
      allowNull: false,
      defaultValue: 0,
    },
    perCategoryBreakdown: {
      type: DataTypes.JSON,
      allowNull: false,
      defaultValue: {},
    },
    notificationSent: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
  });

  EscalationDecision.associate = (models) => {
    EscalationDecision.belongsTo(models.Issue, { foreignKey: "issueId", as: "issue" });
  };

  return EscalationDecision;
};
