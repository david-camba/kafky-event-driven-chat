// dispatcher.js - Manages WebSocket room subscriptions and message broadcasting.
const eventBus = require('./event-bus.js');

/**
 * Handles the logic of distributing real-time messages to the correct clients.
 * This class acts as a dedicated service within the event-driven architecture.
 */
class ChatDispatcher {
    /**
     * @param {Map<number, Set<WebSocket>>} chatRooms - The Map instance to store chat room subscriptions. 
     * This is injected to decouple the dispatcher from state management and improve testability.
     */
    constructor(chatRooms) {
        this.chatRooms = chatRooms;
        console.log('[Dispatcher] Dispatcher service initialized.');
    }

    /**
     * Subscribes the dispatcher to the global event bus to listen for relevant events.
     * This method should be called once when the application starts.
     */
    listen() {
        // Listens for 'message-projected' events, which serve as the trigger to broadcast the new message.

        // NOTE: This service subscribes to 'message-projected' directly, NOT 'message-projected-KAFKED'.
        // Since dispatching is a non-critical notification and doesn't alter state,
        // we prioritize a lower latency for the end-user over the absolute guarantee
        // of logging the projection event itself before notifying.
        eventBus.on('message-projected', (newMessage) => {
            console.log(`[Dispatcher] 'message-projected' event received. Dispatching message...`);
            this.dispatch(newMessage.id_chat, newMessage);
        });
    }
    
    /**
     * Subscribes a socket to a specific chat room.
     * Handles automatically unsubscribing from any previous room.
     * @param {WebSocket} socket - The client's WebSocket connection.
     * @param {number} chatId - The ID of the chat room to join.
     */
    subscribe(socket, chatId) {
        // 1. Clean up any previous subscription for this socket to prevent inconsistencies.
        this.unsubscribe(socket);

        // 2. Add the socket to the new chat room, creating the room if it's the first member.
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
     * Unsubscribes a socket from its current chat room.
     * @param {WebSocket} socket - The client's WebSocket connection.
     */
    unsubscribe(socket) {
        const currentChatId = socket.currentChatId;
        if (currentChatId && this.chatRooms.has(currentChatId)) {
            const room = this.chatRooms.get(currentChatId);
            room.delete(socket);
            console.log(`[Dispatcher] Socket unsubscribed from room ${currentChatId}. Remaining members: ${room.size}`);

            // Housekeeping: Remove empty rooms to prevent potential memory leaks.
            if (room.size === 0) {
                this.chatRooms.delete(currentChatId);
                console.log(`[Dispatcher] Room ${currentChatId} is empty and has been removed.`);
            }
        }
        socket.currentChatId = null; // Clear the state from the socket instance.
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