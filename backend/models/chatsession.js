module.exports = (sequelize, DataTypes) => {
  const ChatSession = sequelize.define("ChatSession", {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    owner: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    repo: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    githubUserId: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    title: {
      type: DataTypes.STRING,
      allowNull: true,
    },
  });

  ChatSession.associate = (models) => {
    ChatSession.hasMany(models.ChatMessage, { foreignKey: "sessionId", as: "messages", onDelete: "CASCADE" });
  };

  return ChatSession;
};