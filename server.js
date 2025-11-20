// --- Core & Third-Party Imports ---
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

// --- Internal Application Modules ---
const db = require('./database.js');

const eventBus = require('./event-bus.js'); //it's global for all the services. The must use "eventBus" to interact with it and do not declare variables with this name.

// --- Server Setup ---
const app = express();
// Serve static frontend files from the 'public' directory.
app.use(express.static(path.join(__dirname, 'public')));

// Create the HTTP server and attach the WebSocket server to it.
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// --- Events Object ---
const { v4: uuidv4 } = require('uuid'); 
const DomainEvent = require('./domain-event.js'); 

// --- Real-time Core Logic ---

// Manages all active WebSocket connections, mapping a userId to an array of their sockets.
// This architecture supports multiple connections per user (e.g., from different browser tabs).
// Type: Map<userId, WebSocket[]>
const clients = new Map();

// Import the service class and create a single instance injecting its dependencies
// the chatRooms and the users
const ChatDispatcher = require('./dispatcher.js');
const dispatcher = new ChatDispatcher();

const PersistenceService = require('./persistence-service.js');
const persistenceService = new PersistenceService(db);

// --- Application Wiring ---
// Initialize services that listen to the event bus.
dispatcher.listen();
persistenceService.listen();

// ARCHITECTURAL TO-DO - Centralized Logging:
// Currently, logging is performed via direct `console.log` calls scattered across services.
// A more robust approach would be to implement a dedicated, event-driven LoggingService:
//
// 1. Define structured log events (e.g., 'log:info', 'log:warn', 'log:error') with a consistent
//    payload structure: `{ service: 'Dispatcher', message: 'User connected', details: {...} }`.
// 2. Instead of `console.log`, services would emit these events to the eventBus:
//    `eventBus.emit('log:info', { service: 'Gateway', message: `Event '${data.type}' received` });`
// 3. Create a `logging-service.js` that subscribes to all `log:*` events.
// 4. This service would be the single source of truth for log formatting and output
//    (e.g., writing to the console, a JSON log file, or an external logging provider).
//



wss.on('connection', (ws) => {
    console.log('[Gateway] Client connected to WebSocket.');

    // These variables lives within the connection's closure, making it private to the gateway.
    //let currentChatId = null; 
    //let userId = null;

    // ARCHITECTURAL NOTE: A cleaner pattern would be to attach state directly to the `ws` object
    // Attach state directly to the socket instance for easier tracking and cleanup.
    // This treats the socket as the state container for the
    // connection and allows any service receiving the `ws` object to access its context.

    // => like this
    ws.userId = null; // Tracks the authenticated user for this specific connection.
    ws.chatId = null; // Tracks the chat room the user is currently viewing.

    let participants = null; // Store the participants usersId of the selected chat for security reasons

    // Fired every time this specific client sends data.
    ws.on('message', async (message) => {
        const correlationId = uuidv4(); //generate a unique Correlation ID for this new interaction

        //We could send an event now to communicate other services that a socket connection has been opened

        try {
            const data = JSON.parse(message);
            console.log(`[Gateway] Received event '${data.type}' from user: ${ws.userId || '(unidentified)'}`);
            console.log(`[Gateway] Payload received:`, data.payload);

            // --- Event-Driven Message Handling ---
            // This switch acts as a router for different client-side events.
            switch (data.type) {

                // Event: Client identifies itself after connection is established.
                case 'user.identify':
                    const userId = data.payload.userId;
                    
                    // ARCHITECTURAL NOTE on REAL-WORLD SECURITY:
                    // In a production environment, this is a critical security checkpoint.
                    // The flow would be as follows:
                    // 1. On ws.onopen, the client would send a short-lived authentication token (e.g., a JWT)
                    //    in the payload, obtained after a secure login via HTTPS, as "user.identify".
                    // 2. An 'WebSocketAuthService' would receive this event. It would validate the token's
                    //    signature and check its expiration.
                    // 3. If valid, extract the userId and attach it to the socket (e.g., `ws.userId = userId`) or emit an event to be handled by the Gateway
                    // 4. If invalid, the 'WebSocketAuthService' itself would send an 'auth.failed' message
                    //    back to the client and immediately terminate the connection (`ws.close()`).
                    //

                    // For this prototype, we are TRUSTING the client-sent userId for simplicity.
                    
                    ws.userId = userId; // Associate this connection with a userId.

                    // Manage multi-device/tab support.
                    if (!clients.has(ws.userId)) {
                        clients.set(ws.userId, []);
                    }
                    clients.get(ws.userId).push(ws);

                    console.log(`[Gateway] User ${userId} identified. Active users: ${[...clients.keys()]}`);

                    //We could send an event now to communicate other services that an usser has logged in 

                    break;

                // Event: Client requests to view a specific chat.
                case 'chat.select':
                    const requestedChatId = data.payload.chatId;
                    if (!requestedChatId) return; // Ignore messages if not chatId was requested
                    if (!ws.userId) return; // Ignore messages from unidentified clients.  

                    // Avoid to open a new socket for the same chat if this client have it opened
                    const userConnections = clients.get(ws.userId);
                    
                    // Check if there's another tab of the user with the same chat.
                    const openChatSocket = userConnections.find(
                        existingSocket => existingSocket !== ws && existingSocket.chatId === requestedChatId
                    );
                    
                    // TO-DO: refactor this to logic to "function closeOldChat(openChatSocket, correlationId)"
                    if (openChatSocket) {
                        console.error(`[Gateway] Closing other old tab. User ${ws.userId} already had an open tab with the chat ${requestedChatId}.`);                       

                        // We create an event so other services can handle the closed connection 
                        const chatClosedEvent = new DomainEvent(
                            'chat-revoked-by-new-tab',
                            { userId: openChatSocket.userId, chatId: openChatSocket.chatId, socket: openChatSocket },
                            { correlationId: correlationId, causationId: "user-interaction" }                          
                        );

                        openChatSocket.chatId = null; //we clean the chat from the old socket
                        eventBus.emit(chatClosedEvent); //we emit the event so other service (as the Dispatchet) can handle it
                        
                        // Notify the client
                        openChatSocket.send(JSON.stringify({
                            type: 'chat.session.revoked', //the frontend will handle this event type
                            payload: { message: 'The chat session is now active in another tab.' }
                        }));
                    }

                    // Authorize: Check if the user is a valid participant of the chat.
                    participants = await db.getChatParticipants(requestedChatId);
                    if (!participants || (ws.userId !== participants.id_user1 && ws.userId !== participants.id_user2)) {
                        console.error(`[Gateway] SECURITY ALERT: User ${ws.userId} attempted to post in chat ${requestedChatId} without permission.`);
                        return; 
                    }

                    ws.chatId = requestedChatId; //AUTHORIZED - set the chatId for the socket 


                    // After the authorization, we send an event                     
                    // Other services will send the chat messages and needed information to the user

                    // Retrieve the last message found in the user IndexedDB
                    const lastMessageId = data.payload.lastMessageId || 0;

                    const chatSelectedEvent = new DomainEvent(
                        'chat-selected-by-user',
                        { userId: ws.userId, chatId: ws.chatId, socket: ws, lastMessageId: lastMessageId },
                        { correlationId, causationId: "user-interaction"}                          
                    );
                    eventBus.emit(chatSelectedEvent);
                    break;

                // Event: Client sends a new message to the current chat.
                case 'chat.message.new':
                    if (!ws.userId || !ws.chatId) return; 
                    // Ignore messages from unidentified clients or without chat
                    // SECURITY NOTE: the chat for the socket has been previously validated, so we don't need extra security

                    const {messageText} = data.payload;
                    
                    // Publish: Emit a high-level event to the bus. This is a "fire-and-forget" action.
                    // The gateway doesn't know who will handle it (e.g., persistence, dispatching). This decouples the modules.
                    console.log(`[Gateway] Publishing 'incoming-message' event. CorrelationID: ${correlationId}`);

                    const incomingMessageEvent = new DomainEvent(
                        'incoming-message',
                        { chatId: ws.chatId, userId: ws.userId, messageText },
                        { correlationId , causationId: "user-interaction"}                          
                    );

                    eventBus.emit(incomingMessageEvent);
                    break;
            }
        } catch (error) {
            console.error('Failed to process message:', error);
        }
    });

    // Fired when the client's connection is terminated.
    ws.on('close', () => {
        if (!ws.userId) {
            console.log('[Gateway] Unidentified client connection closed.');
            return;
        }

        const closingUserId = ws.userId;
        const closingChatId = ws.chatId;
        console.log(`[Gateway] Closing ${ws.userId} user with chatId ${closingChatId}...`);

        // 2. Handle this gateway's direct responsibility: cleaning up the `clients` map.
        const userConnections = clients.get(closingUserId);
        if (!Array.isArray(userConnections)) return; //si no está el usaurio, en el mapa, hemos acabado

        // Remove the specific socket that just closed from the user's connection list.
        const remainingConnections = userConnections.filter(socket => socket !== ws);

        if (remainingConnections.length > 0) {
            // If the user still has other active connections, update the map.
            clients.set(closingUserId, remainingConnections);
            console.log(`[Gateway] A connection for user ${closingUserId} closed. Remaining: ${remainingConnections.length}.`);
        } else {
            // If it was their last connection, remove them from the active clients map entirely.
            clients.delete(closingUserId);
            console.log(`[Gateway] Last connection for user ${closingUserId} closed. User removed from active map.`);
        }

        // We send an event so other services can handle the closed connection 
        // Dispatcher will clean up the user from the chatRoom
        const socketClosedEvent = new DomainEvent(
            'connection-closed',
            { userId: closingUserId, chatId: closingChatId, socket: ws },
            { correlationId: uuidv4(), causationId: "user-interaction"}                          
        );
        eventBus.emit(socketClosedEvent); 
    });
});

// --- Server Initialization ---
const PORT = 8000;
server.listen(PORT, () => {
    console.log(`🚀 Server is running and listening on http://localhost:${PORT}`);
});