// inspect_board.js
require("dotenv").config();
const fetch = require("node-fetch");

const MONDAY_API_TOKEN = process.env.MONDAY_API_TOKEN; // from .env
const BOARD_ID = process.env.MONDAY_BOARD_ID; // your MRI-Platform-Reporting board ID

const MONDAY_API_URL = "https://api.monday.com/v2";
const MONDAY_HEADERS = {
  "Content-Type": "application/json",
  Authorization: MONDAY_API_TOKEN
};

async function inspect_board() {
  const query = `
    query GetBoardInfo($boardId: [ID!]!) {
      boards(ids: $boardId) {
        name
        groups {
          id
          title
        }
        columns {
          id
          title
          type
        }
      }
    }
  `;

  const variables = { boardId: BOARD_ID };

  try {
    const res = await fetch(MONDAY_API_URL, {
      method: "POST",
      headers: MONDAY_HEADERS,
      body: JSON.stringify({ query, variables })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Error inspecting board:");
    console.error(err.message);
  }
}

async function get_board_info() {
  const query = `
    query GetBoardItems($boardId: [ID!]!) {
      boards(ids: $boardId) {
        id
        name
        items_page(limit: 50) {
          items {
            id
            name            # "Item" column (your SME number)
            group {
              id
              title
            }
            column_values {
              id
              text          # human-readable value
              type          # column type, e.g. "text"
              value         # raw JSON as a string
            }
          }
        }
      }
    }
  `;

  const variables = { boardId: BOARD_ID };

  const res = await fetch(MONDAY_API_URL, {
    method: "POST",
    headers: MONDAY_HEADERS,
    body: JSON.stringify({ query, variables })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));

  // More defensive error handling
  if (data.errors) {
    console.error("GraphQL errors:", JSON.stringify(data.errors, null, 2));
    throw new Error("GraphQL error from monday.com");
  }

  const boards = data.data?.boards;
  if (!boards || !boards.length) {
    throw new Error("No boards returned in response");
  }

  return boards[0];
}

module.exports = { inspect_board, get_board_info };
