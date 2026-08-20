"use strict";

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.addIndex("IssueTimelines", ["issueId", "eventType"], {
      unique: true,
      name: "issue_timelines_issue_event_unique",
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeIndex("IssueTimelines", "issue_timelines_issue_event_unique");
  },
};