module.exports = (sequelize, DataTypes) => {
  const Label = sequelize.define("Label", {
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
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    color: {
      type: DataTypes.STRING,
      allowNull: false,
    },
  });

  Label.associate = (models) => {
    Label.belongsTo(models.Issue, { foreignKey: "issueId", as: "issue" });
  };

  return Label;
};
