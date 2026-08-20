module.exports = (sequelize, DataTypes) => {
  const HealthMetric = sequelize.define("HealthMetric", {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    repoFullName: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    metricType: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    value: {
      type: DataTypes.FLOAT,
      allowNull: false,
    },
    recordedAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      allowNull: false,
    },
  });

  return HealthMetric;
};
