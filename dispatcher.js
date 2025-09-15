// dispatcher.js - Manages WebSocket room subscriptions and message broadcasting.
const eventBus = require('./event-bus.js');
const DomainEvent = require('./domain-event.js');
const db = require('./database.js');

/**
 * Handles the logic of distributing real-time messages to the correct clients.
 * This class acts as a dedicated service within the event-driven architecture.
 */
class ChatDispatcher {
    /**
     * @param {Map<number, Set<WebSocket>>} chatRooms - The Map instance to store chat room subscriptions.
     * @param {Map<number, Set<WebSocket>>} clients - The Map for all active client connections.
     * 
     * This is injected to decouple the dispatcher from state management and improve testability.
     * Beyond, the map "Clients" can be shared by server.js (our gateway) and the Dispatcher.
     */
    constructor(chatRooms, clients) {
        this.chatRooms = chatRooms;
        this.clients = clients;
        console.log('[Dispatcher] Dispatcher service initialized.');
    }

    /**
     * Subscribes the dispatcher to the global event bus to listen for relevant events.
     * This method should be called once when the application starts.
     */
    listen() {
        // Listens for 'message-projected' events, which serve as the trigger to broadcast the new message.

        // EAGER SUSCRIPTION: This service subscribes to 'message-projected' directly, NOT 'message-projected-KAFKED'.
        // Since dispatching is a non-critical notification and doesn't alter state,
        // we prioritize a lower latency for the end-user over the absolute guarantee
        // of logging the projection event itself before notifying.
        eventBus.on('message-projected', (projectedEvent) => {
            console.log(`[Dispatcher] 'message-projected' event received. Dispatching message...`);

            const { payload, metadata } = projectedEvent;
            this.dispatch(payload.id_chat, payload);

            //We send an event to comunicate a message has been dispatched
            const dispatchedEvent = new DomainEvent(
                'message-dispatched',
                { 
                    dispatchedMessage: payload,
                    targetChatId: payload.id_chat,
                },
                {
                    correlationId: metadata.correlationId,
                    causationId: projectedEvent.eventId
                }
            );

            eventBus.emit(dispatchedEvent);
        });

        //EAGER SUSCRIPTION
        eventBus.on('chat-selected-by-user', async (incomingEvent) => {
            console.log(`[Dispatcher] 'chat-selected' event received. Introducing user in room...`);

            const { payload, metadata } = incomingEvent;
            const { socket, chatId, userId, lastMessageId } = payload;

            this.subscribe(socket, chatId);

            // We get the history (this could instead trigger an event "history-requested" to be handle by other service
            // and only send the history when a "history-ready" event is published
            const history = await db.getChatHistory(chatId, lastMessageId);

            // If there are new messages, we send them
            if (history.length > 0) {
                 console.log(`[Dispatcher] Sending ${history.length} new messages to user ${userId} for chat ${chatId}.`);
                 socket.send(JSON.stringify({ type: 'chat.history', payload: history }));
            } else {
                 console.log(`[Dispatcher] User ${userId} is already up to date for chat ${chatId}.`);
            }

            //We send an event to comunicate the user is now in the room
            const userInRoomEvent = new DomainEvent(
                'user-in-room',
                { 
                    userId: userId,
                    chatId: chatId,
                },
                {
                    correlationId: metadata.correlationId,
                    causationId: incomingEvent.eventId
                }
            );

            eventBus.emit(userInRoomEvent);
        });

        //EAGER SUSCRIPTION
        eventBus.on('connection-closed', ({ payload: { socket, chatId, userId } }) => {
            if(!chatId) return; //if the user have no chat, we don't need to do anything

            console.log(`[Dispatcher] 'connection-closed' event received. Deleting user ${userId} from the room ${chatId}...`);

            //clean the connection from our chatRooms map
            this.unsubscribe(socket, chatId);
        });

        /**
         * Register handlers for events that mandate a user's removal from a chat room.
         * This approach centralizes cleanup logic for multiple event types.
         */
        ['connection-closed', 'chat-revoked-by-new-tab'].forEach(eventType => {
            eventBus.on(eventType, (event) => {

                //we won't delete the room if it's being taken by a new tab
                let cleanRoom = true;
                if (eventType === 'chat-revoked-by-new-tab') cleanRoom = false;

                const { payload: { socket, userId, chatId } } = event;

                if (socket && chatId) {
                    console.log(`[Dispatcher] Handling '${eventType}' for user ${userId} in room ${socket.currentChatId}.`);
                    this.unsubscribe(socket, chatId, cleanRoom);
                }
            });
        });
    }
    
    /**
     * Subscribes a socket to a specific chat room.
     * Handles automatically unsubscribing from any previous room.
     * @param {WebSocket} socket - The client's WebSocket connection.
     * @param {number} chatId - The ID of the chat room to join.
     */
    subscribe(socket, chatId) {
        // Add the socket to the new chat room, creating the room if it's the first member.
        if (!this.chatRooms.has(chatId)) {
            this.chatRooms.set(chatId, new Set());
        }
        this.chatRooms.get(chatId).add(socket);
        
        // Note: Storing state directly on the socket object simplifies cleanup logic
        // during disconnects or when changing rooms.
        socket.currentChatId = chatId;

        console.log(`[Dispatcher] Socket subscribed to room ${chatId}. Total members: ${this.chatRooms.get(chatId).size}`);
    }

    /**
     * Unsubscribes a socket from a chat room.
     * @param {WebSocket} socket - The client's WebSocket connection.
     * @param {int} chatId - The id of the chat room you want to unsuscribe.
     * @param {boolean} cleanRoom - Decide if delete the room if empty after unsuscribe
     */
    unsubscribe(socket, chatId, cleanRoom=true) {
        if (chatId && this.chatRooms.has(chatId)) {
            const room = this.chatRooms.get(chatId);
            room.delete(socket);
            console.log(`[Dispatcher] Socket unsubscribed from room ${chatId}. Remaining members: ${room.size}`);

            // Housekeeping: Remove empty rooms to prevent potential memory leaks.
            if (cleanRoom && room.size === 0) {
                this.chatRooms.delete(chatId);
                console.log(`[Dispatcher] Room ${chatId} is empty and has been removed.`);
            }
        }
    }

    /**
     * Broadcasts a message payload to all connected sockets in a specific chat room.
     * @param {number} chatId - The ID of the target chat room.
     * @param {object} messagePayload - The message object to be sent.
     */
    dispatch(chatId, messagePayload) {
        const room = this.chatRooms.get(chatId);
        if (room && room.size > 0) {
            const broadcastPayload = JSON.stringify({ type: 'chat.message.broadcast', payload: messagePayload });
            console.log(`[Dispatcher] Broadcasting message to ${room.size} members in room ${chatId}`);
            
            for (const socketInRoom of room) {
                // Ensure the socket is still open before attempting to send. (readyState 1 === OPEN)
                if (socketInRoom.readyState === 1) { 
                    socketInRoom.send(broadcastPayload);
                }
            }
        }
    }
}

// Export the class itself, not an instance. This allows the main server file (`server.js`)
// to create the instance and inject dependencies (like the chatRooms map),
// adhering to the Dependency Injection pattern.
module.exports = ChatDispatcher;