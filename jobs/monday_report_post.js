// monday_poc.js
require("dotenv").config();
const fetch = require("node-fetch");

// --- 1) Config: fill these in ---
const MONDAY_API_TOKEN = process.env.MONDAY_API_TOKEN; // from your .env
const BOARD_ID = process.env.MONDAY_BOARD_ID; // MRI-Platform-Reporting board ID
const GROUP_ID = "topics"; // group id for "Open"
const SITE_NAME_COLUMN_ID = "text_mkxse17h"; // column id for "Site Name"

// --- 2) Monday.com API config ---
const MONDAY_API_URL = "https://api.monday.com/v2";
const MONDAY_HEADERS = {
  "Content-Type": "application/json",
  Authorization: MONDAY_API_TOKEN
};

// --- 3) Hard-coded example row (your POC data) ---
const exampleRow = {
  sme_number: "SME12345",
  site_name: "Example Hospital MRI Suite"
};

async function create_row() {
  // The "Item" column is the item name (first column).
  // That is set with `item_name`, not in column_values.
  const query = `
    mutation CreateMRIItem(
      $boardId: ID!,
      $groupId: String!,
      $itemName: String!,
      $columnVals: JSON!
    ) {
      create_item(
        board_id: $boardId,
        group_id: $groupId,
        item_name: $itemName,
        column_values: $columnVals
      ) {
        id
        name
      }
    }
  `;

  // Column values is a JSON string. Keys are column IDs, values are the cell values.
  const columnValues = {};
  columnValues[SITE_NAME_COLUMN_ID] = exampleRow.site_name;

  const variables = {
    boardId: BOARD_ID,
    groupId: GROUP_ID,
    itemName: exampleRow.sme_number, // goes into the "Item" column
    columnVals: JSON.stringify(columnValues) // Site Name column
  };

  try {
    const response = await fetch(MONDAY_API_URL, {
      method: "POST",
      headers: MONDAY_HEADERS,
      body: JSON.stringify({ query, variables })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(data));
    console.log("Created item:", JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Error creating item:");
    console.error(err.message);
  }
}

module.exports = create_row;
