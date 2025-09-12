// persistence-service.js - Handles storing messages in the database.
const eventBus = require('./event-bus.js');
/**
 * A dedicated service responsible for persisting data.
 * It listens for application events and interacts with the database layer,
 * effectively decoupling database logic from the main gateway.
 */
class PersistenceService {
    /**
     * @param {object} database - The database module/client for data operations.
     */
    constructor(database) {
        this.db = database;
        console.log('[PersistenceService (Projector)] Persistence service initialized.');
    }

    /**
     * Activates the projector by subscribing it to guaranteed events from the Event Bus.
     */
    listen() {
        // Subscribe to the "-KAFKED" event. This guarantees the projector only acts on
        // events that have been successfully and immutably stored in the Event Store (`event_log`).
        eventBus.on('incoming-message-KAFKED', async (data) => {
            const { logId } = data;
            console.log(`[PersistenceService (Projector)] 'incoming-message-KAFKED' received. Projecting event with logId: ${logId}`);
            
            try {
                // STEP 1: RETRIEVE THE SOURCE OF TRUTH
                // The projector fetches the original event from the Event Store using the logId.
                // It does not trust the payload of the '-KAFKED' event itself, only the fact that it occurred.

                const event = await this.db.getEventByLogId(logId);
                if (!event || event.event_type !== 'incoming-message') {
                    console.error(`[PersistenceService (Projector)] Invalid or missing event for logId: ${logId}`);
                    return; // Halt if the source of truth is missing or invalid.
                }

                // Extract the original data from the persisted event's payload.
                const { chatId, userId, messageText } = event.payload;

                // STEP 2: PROJECT THE EVENT INTO A READ MODEL
                // The projector now updates the `messages` table. This table acts as our
                // "Read Model": a query-optimized copy of the data, ensuring that fetching
                // chat histories remains fast and efficient.
                const projectedMessage = await this.db.addMessage(chatId, userId, messageText);

                // STEP 3: PUBLISH THE PROJECTION RESULT
                // Emit a final event to signal that the read model is up-to-date.               
                eventBus.emit('message-projected', projectedMessage);    
                // NOTE: This is "Event Chaining": After successful projecting, publish a more specific event.                           
            } catch (error) {
                console.error('[PersistenceService (Projector)] Failed to save message:', error);

                // NOTE: A more robust implementation could emit a 'persistence-error' event here,
                // allowing other parts of the system to handle the failure.
                // e.g., this.eventBus.emit('message-error', { error, originalMessage: data });
                // This event would be handle by the Dispatcher and send a warning to the user "message couldn't be delivered, try again"
            }
        });
    }
}

// Export the class to allow for dependency injection.
// The main application file will create the instance and provide the `db`.
module.exports = PersistenceService;