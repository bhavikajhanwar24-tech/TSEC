const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const dbConfig = {
  url: process.env.DATABASE_URL,
  dialect: "postgres",
  dialectOptions: {
    ssl: {
      require: true,
      rejectUnauthorized: false,
    },
  },
};

module.exports = {
  development: dbConfig,
  test: dbConfig,
  production: dbConfig,
};
