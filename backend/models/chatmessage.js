module.exports = (sequelize, DataTypes) => {
  const ChatMessage = sequelize.define("ChatMessage", {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    sessionId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: "ChatSessions",
        key: "id",
      },
      onUpdate: "CASCADE",
      onDelete: "CASCADE",
    },
    role: {
      type: DataTypes.ENUM("user", "assistant"),
      allowNull: false,
    },
    content: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
  });

  ChatMessage.associate = (models) => {
    ChatMessage.belongsTo(models.ChatSession, { foreignKey: "sessionId", as: "session" });
  };

  return ChatMessage;
};