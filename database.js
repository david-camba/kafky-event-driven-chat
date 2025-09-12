const sqlite3 = require('sqlite3').verbose();

// Initialize the database connection.
// The .verbose() option provides more detailed stack traces for debugging.
const db = new sqlite3.Database('./chats.sqlite');

/**
 * Retrieves the IDs of the two users participating in a specific chat.
 * @param {number} chatId - The unique ID of the chat.
 * @returns {Promise<object|null>} A promise that resolves to an object like { id_user1, id_user2 } or null if not found.
 */
function getChatParticipants(chatId) {
    return new Promise((resolve, reject) => {
        const sql = `SELECT id_user1, id_user2 FROM chats WHERE id_chat = ?`;
        
        // Use db.get() here because we expect exactly one row in return.
        db.get(sql, [chatId], (err, row) => {
            if (err) {
                console.error("Error fetching chat participants:", err);
                reject(err);
            } else {
                resolve(row);
            }
        });
    });
}

/**
 * Fetches the entire message history for a given chat, ordered by creation time.
 * @param {number} chatId - The unique ID of the chat.
 * @returns {Promise<Array>} A promise that resolves to an array of message objects.
 */
function getChatHistory(chatId) {
    return new Promise((resolve, reject) => {
        const sql = `
            SELECT m.id_message, m.message, m.created_at, u.id_user, u.username 
            FROM messages m
            JOIN users u ON m.id_user = u.id_user
            WHERE m.id_chat = ? 
            ORDER BY m.created_at ASC`;
        
        // Use db.all() to retrieve all rows matching the query.
        db.all(sql, [chatId], (err, rows) => {
            if (err) {
                console.error("Error fetching chat history:", err);
                reject(err);
            } else {
                resolve(rows);
            }
        });
    });
}

/**
 * Inserts a new message into the database and returns the newly created message object.
 * @param {number} chatId - The ID of the chat to add the message to.
 * @param {number} userId - The ID of the user sending the message.
 * @param {string} message - The content of the message.
 * @returns {Promise<object>} A promise that resolves to the full new message object, including username and timestamp.
 */
function addMessage(chatId, userId, message) {
    return new Promise((resolve, reject) => {
        const sql = "INSERT INTO messages (id_chat, id_user, message) VALUES (?, ?, ?)";

        // NOTE: Must use a classic `function` here, not an arrow function (=>).
        // This is crucial because `sqlite3` binds `this` to the statement context,
        // allowing us to access `this.lastID`. Arrow functions don't have their own `this`.
        db.run(sql, [chatId, userId, message], function(err) { 
            if (err) {
                return reject(err);
            }
            
            // After inserting, fetch the complete message object to return to the client.
            // This ensures the response includes generated values like the ID and timestamp.
            const newMessageSql = `
                SELECT m.id_message, m.id_chat, m.message, m.created_at, u.id_user, u.username
                FROM messages m
                JOIN users u ON m.id_user = u.id_user
                WHERE m.id_message = ?`;
            
            db.get(newMessageSql, [this.lastID], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
    });
}

/**
 * Logs a domain event to the event_log table for auditing and traceability.
 * This function acts as the persistence layer for the Event Store, capturing
 * every significant action that occurs within the application.
 *
 * @param {string} eventType - The unique name of the event (e.g., 'incoming-message', 'message-persisted').
 * @param {object} payload - The data associated with the event, which will be serialized to JSON.
 * @returns {Promise<{eventId: number}>} A promise that resolves with the ID of the newly created event log entry.
 */
function logEvent(eventType, payload) {
    return new Promise((resolve, reject) => {
        const sql = "INSERT INTO event_log (event_type, payload) VALUES (?, ?)";

        // The payload object is stringified to be stored in a single TEXT column.
        const payloadJson = JSON.stringify(payload);
        
        db.run(sql, [eventType, payloadJson], function(err) {
            if (err) {
                console.error(`Error logging event '${eventType}':`, err);
                // In a production system, a failed event log could trigger a critical alert.
                return reject(err);
            }
            // Resolve with the unique ID of the log entry for potential future reference.
            resolve({ eventId: this.lastID });
        });
    });
}

/**
 * Retrieves a single event from the event_log by its ID.
 * This function is the gateway to our Event Store, the single source of truth.
 * @param {number} logId - The unique ID of the event log entry.
 * @returns {Promise<object>} A promise that resolves to the event object { event_type, payload }.
 */
function getEventByLogId(logId) {
    return new Promise((resolve, reject) => {
        const sql = `SELECT event_type, payload FROM event_log WHERE id_event = ?`;
        db.get(sql, [logId], (err, row) => {
            if (err) {
                console.error("Error fetching event from log:", err);
                return reject(err);
            }
            if (row) {
                // The payload is saved as a string, so we convert it to Object
                row.payload = JSON.parse(row.payload);
                resolve(row);
            } else {
                resolve(null); // Event not found
            }
        });
    });
}

// Expose the database interaction functions.
module.exports = { 
    getChatHistory, 
    addMessage,
    getChatParticipants,
    logEvent,
    getEventByLogId
};