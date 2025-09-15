// main.js - Client-side logic for the chat application (ViewModel).

document.addEventListener('DOMContentLoaded', () => {

    // --- TAB MANAGEMENT & COMMUNICATION ---
    // A unique identifier for this specific browser tab.
    const tabId = crypto.randomUUID(); 
    // The communication channel for synchronizing actions across tabs.
    const tabChannel = new BroadcastChannel('chat_tab_control');

    /**
     * Handles messages received from other tabs via the BroadcastChannel.
     * The primary use is to gracefully close a chat session when another tab takes control.
     */
    tabChannel.onmessage = (event) => {
        const { type, chatId, userId: senderUserId, tabId: senderTabId} = event.data;

        // Ensure the message is a 'TAKE_CONTROL' command and it's from the user in another tab
        if (type === 'TAKE_CONTROL' && senderUserId === state.currentUser?.id && senderTabId !== tabId) {
            
            // Check if the takeover request is for the chat currently active in this tab.
            if (state.currentChat?.id === chatId) {
                console.log(`[Tab ${tabId}] Received takeover command for chat ${chatId} from tab ${senderTabId}. Ceding control.`);

                //Hide the chat tab and show selection
                ui.chatPanel.classList.add('hidden');
                ui.chatSelectionPanel.classList.remove('hidden');
                
                // Reset the state to prevent inconsistencies.
                state.currentChat = null;
                state.messages = [];

                // Update the UI to show the user why the chat disappeared.
                // Display a clear message and revert to the chat selection screen.
                alert('The chat has been opened in a new tab and is now closed here.');
            }
        }
    };

    // ================================================================
    // --- INDEXEDDB PERSISTENCE LAYER ---
    // ================================================================
    const DB_NAME = 'ChatAppDB';
    const DB_VERSION = 1;
    const MSG_STORE_NAME = 'messages';
    let db; // Holds the database connection instance.

    /**
     * Initializes the IndexedDB database.
     * Creates the object store for messages if it doesn't exist.
     * @returns {Promise<IDBDatabase>} A promise that resolves when the DB is ready.
     */
    function initDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onerror = (event) => {
                console.error("IndexedDB initialization error:", event.target.error);
                reject("Error opening local database.");
            };

            request.onsuccess = (event) => {
                db = event.target.result;
                console.log("Local database (IndexedDB) connection established.");
                resolve(db);
            };

            // This event only runs if the database version changes or is new.
            request.onupgradeneeded = (event) => {
                const dbInstance = event.target.result;
                console.log("Upgrading local database...");
                // The object store holds our messages. 'id_message' is the unique key.
                const objectStore = dbInstance.createObjectStore(MSG_STORE_NAME, { keyPath: 'id_message' });
                // An index on 'id_chat' allows us to efficiently query all messages for a specific chat.
                objectStore.createIndex('chatIndex', 'id_chat', { unique: false });
                console.log("Object store 'messages' created successfully.");
            };
        });
    }

    /**
     * Saves an array of messages to the local database.
     * Uses 'put' to either insert a new message or update an existing one.
     * @param {Array<object>} messages - The array of message objects to save.
     */
    function saveMessagesToDB(messages, storeName=MSG_STORE_NAME) {
        if (!db || !messages || messages.length === 0) return Promise.resolve();
        
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([storeName], 'readwrite');
            const store = transaction.objectStore(storeName);
            
            messages.forEach(msg => {
                store.put(msg); // 'put' is an "upsert" operation.
            });

            transaction.oncomplete = () => resolve();
            transaction.onerror = (event) => reject(event.target.error);
        });
    }

    /**
     * Retrieves all messages for a specific chat from the local database.
     * @param {number} chatId - The ID of the chat to retrieve messages for.
     * @returns {Promise<Array<object>>} A promise that resolves with the sorted messages.
     */
    function getMessagesFromDB(chatId) {
        if (!db) return Promise.resolve([]);

        return new Promise((resolve, reject) => {
            const transaction = db.transaction([MSG_STORE_NAME], 'readonly');
            const store = transaction.objectStore(MSG_STORE_NAME);

            const index = store.index('chatIndex'); 

            const request = index.getAll(chatId); // Get all records matching the chat ID.

            request.onsuccess = () => {
                console.log("request", request.result);
                // IndexedDB doesn't guarantee order from an index, so we sort them ourselves.
                const sortedMessages = request.result.sort((a, b) => a.id_message - b.id_message);
                resolve(sortedMessages);
            };
            request.onerror = (event) => reject(event.target.error);
        });
    }


    // --- STATE MANAGEMENT (MODEL) ---
    // The single source of truth for the client-side application state.
    const state = {
        currentUser: null,     // Populated with { id, name } upon user identification.
        currentChat: null,     // Populated with { id, name } upon chat selection.
        messages: [],          // Message list for the currently active chat.
        unreadMessagesCount: 0, // --- Counter for not read messages
        // NOTE: In a production app, this would be fetched from the server after login.
        availableChats: [
            { id: 1, name: "Chat Manolo-Pepe", participants: [1, 2] },
            { id: 2, name: "Chat Manolo-Luisa", participants: [1, 3] }
        ]
    };

    // --- UI ELEMENT CACHING (VIEW REFERENCES) ---
    // Cache DOM elements for performance and cleaner access.
    const ui = {
        userSelectionPanel: document.getElementById('user-selection-panel'),
        chatSelectionPanel: document.getElementById('chat-selection-panel'),
        chatSelectionTitle: document.getElementById('chat-selection-title'),
        chatListDiv: document.getElementById('chat-list'),
        chatPanel: document.getElementById('chat-panel'),
        chatTitle: document.getElementById('chat-title'),
        messagesDiv: document.getElementById('messages'),
        messageForm: document.getElementById('message-form'),
        messageInput: document.getElementById('message-input')
    };
    
    // --- WEBSOCKET CONNECTION ---
    const ws = new WebSocket(`ws://${window.location.host}`);
    ws.onopen = () => console.log('WebSocket connection established with server.');
    ws.onerror = (error) => console.error('WebSocket error:', error);
    ws.onclose = () => console.log('Disconnected from WebSocket server. Please reload the page.');

    
    // --- Counter of new messages for the user
    const originalTitle = document.title; //save the original title
    /**
     * Update the document title to show the amount of messages not read.
     */
    function updateTitleWithUnreadCount() {
        if (state.unreadMessagesCount > 0) {
            document.title = `(${state.unreadMessagesCount}) ${originalTitle}`;
        } else {
            document.title = originalTitle;
        }
    }
    /**
     * Listen when the tab becomes visible or hidden.
     * Reset the counter and the title when the user returns to the tab.
     */
    document.addEventListener('visibilitychange', () => {
        // Si la pestaña acaba de volverse visible...
        if (!document.hidden) {
            state.unreadMessagesCount = 0;   // Reseteamos el contador.
            updateTitleWithUnreadCount();    // Actualizamos el título para quitar el contador.
        }
    });


    // ================================================================
    // --- CORE LOGIC (VIEWMODEL) ---
    // ================================================================

    // 1. Handle incoming server events
    ws.onmessage = async (event) => {
        const data = JSON.parse(event.data);
        console.log('Server event received:', data);

        // Router for events pushed from the server.
        switch (data.type) {
            case 'chat.history':
                // Server sends NEW messages we didn't have locally.
                if (data.payload && data.payload.length > 0) {
                    await saveMessagesToDB(data.payload); // Persist them locally.
                    state.messages.push(...data.payload); // Add them to the current state.
                    renderMessages();                     // Re-render the UI.
                }
                break;
            
            case 'chat.message.broadcast':
                // Server broadcasts a single new message to participants.
                if (state.currentChat && data.payload.id_chat === state.currentChat.id) {
                    await saveMessagesToDB([data.payload]); // Persist the new message.
                    state.messages.push(data.payload);      // Add it to the current state.
                    renderMessages();                       // Re-render the UI.

                    // Si la pestaña no está visible, incrementamos el contador y actualizamos el título.
                    if (document.hidden) {
                        state.unreadMessagesCount++;
                        updateTitleWithUnreadCount();
                    }
                }
                break;
            
                case 'chat.session.revoked':
                // The server rejected the request because the chat is already open in another tab.
                // This acts as a failsafe in case the BroadcastChannel logic has a race condition.
                console.warn('Server close this chat because other tab opened it:', data.payload.message);

                /*
                This logic was moved to the TabChannel (BroadcastChannel) for responsiveness reasons.
                Now, as soon as a new tab takes control, the old tab chat panel will be hidden and the model updated

                // Revert the UI back to the chat selection panel, hiding the (now invalid) chat view.
                ui.chatPanel.classList.add('hidden');
                ui.chatSelectionPanel.classList.remove('hidden');
                
                // Clear the current chat state to prevent inconsistent UI behavior.
                state.currentChat = null;
                state.messages = [];
                
                // Provide clear feedback to the user. An alert is simple for testing.
                alert(`The selected chat was opened in another window.`);
                */

                break;
        }
    };

    // 2. Handle user interactions (UI Event Listeners)

    // Event: User identifies themselves.
    ui.userSelectionPanel.addEventListener('click', (e) => {
        if (e.target.tagName !== 'BUTTON') return;
        state.currentUser = {
            id: parseInt(e.target.dataset.userid, 10),
            name: e.target.dataset.username
        };
        sendEventToServer('user.identify', { userId: state.currentUser.id });
        ui.userSelectionPanel.classList.add('hidden');
        renderChatSelection();
        ui.chatSelectionPanel.classList.remove('hidden');
    });

    // Event: User selects a chat. 
    ui.chatListDiv.addEventListener('click', async (e) => {
        if (e.target.tagName !== 'BUTTON') return;

        const selectedChatId = parseInt(e.target.dataset.chatid, 10);

        // Announce that we will take control of this chat to other tabs.
        // We broadcast a "takeover" message containing the chat ID and our unique tab ID.
        console.log(`[Tab ${tabId}] Announcing takeover for chat ${selectedChatId}`);
        tabChannel.postMessage({
            type: 'TAKE_CONTROL',
            chatId: selectedChatId,
            userId: state.currentUser?.id,
            tabId: tabId // Include our own ID so we can ignore our own message.
        });

        // Update state with the selected chat details.
        state.currentChat = {
            id: selectedChatId,
            name: e.target.textContent
        };

        // STEP 1: Load existing messages from the local database.
        state.messages = await getMessagesFromDB(state.currentChat.id);
        console.log(`Loaded ${state.messages.length} messages from local DB for chat ${state.currentChat.id}.`);

        // STEP 2: Render the UI immediately with the local data for a snappy user experience.
        ui.chatSelectionPanel.classList.add('hidden');
        ui.chatPanel.classList.remove('hidden');
        renderChatPanel();

        // STEP 3: Determine the ID of the last message we have, to ask the server for what's new.
        
        const lastMessage = state.messages.length > 0 ? state.messages[state.messages.length - 1] : null;
        const lastMessageId = lastMessage ? lastMessage.id_message : 0;
        console.log("lastMessageId",lastMessageId);
        console.log(`Requesting new messages from server since message ID: ${lastMessageId}`);

        // STEP 4: Request only the missing messages from the server.
        sendEventToServer('chat.select', { 
            chatId: state.currentChat.id,
            lastMessageId: lastMessageId 
        });
    });

    // Event: User submits a new message.
    ui.messageForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const messageText = ui.messageInput.value.trim();
        if (messageText === '' || !state.currentChat) return;
        sendEventToServer('chat.message.new', {
            chatId: state.currentChat.id,
            messageText: messageText
        });
        ui.messageInput.value = '';
    });

    /**
     * Helper function to send standardized JSON events to the WebSocket server.
     * @param {string} type - The event type (e.g., 'user.identify').
     * @param {object} payload - The data associated with the event.
     */
    function sendEventToServer(type, payload) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type, payload }));
        } else {
            console.error('Failed to send event: WebSocket is not open.');
        }
    }

    // ================================================================
    // --- RENDER FUNCTIONS (Update the DOM from State) ---
    // ================================================================
    // NOTE: These functions remain unchanged, as they only read from `state`.
    // The magic happens in how the `state` is now populated from both local DB and server.

    /**
     * Renders the list of available chats for the currently logged-in user.
     */
    function renderChatSelection() {
        ui.chatSelectionTitle.textContent = `Welcome, ${state.currentUser.name}. Select a chat:`;
        ui.chatListDiv.innerHTML = '';
        const userChats = state.availableChats.filter(chat => chat.participants.includes(state.currentUser.id));
        if (userChats.length === 0) {
            ui.chatListDiv.textContent = 'No available chats.';
            return;
        }
        const userNames = { 1: 'Manolo', 2: 'Pepe', 3: 'Luisa' };
        userChats.forEach(chat => {
            const otherParticipantId = chat.participants.find(p => p !== state.currentUser.id);
            const otherParticipantName = userNames[otherParticipantId] || 'Unknown';
            const button = document.createElement('button');
            button.textContent = `Chat with ${otherParticipantName}`;
            button.dataset.chatid = chat.id;
            ui.chatListDiv.appendChild(button);
        });
    }

    /**
     * Sets the title of the chat panel to reflect the current conversation participants.
     */
    function renderChatPanel() {
        const chatInfo = state.availableChats.find(chat => chat.id === state.currentChat.id);
        if (!chatInfo) return;
        const otherParticipantId = chatInfo.participants.find(p => p !== state.currentUser.id);
        const userNames = { 1: 'Manolo', 2: 'Pepe', 3: 'Luisa' };
        const otherParticipantName = userNames[otherParticipantId] || 'Unknown';
        ui.chatTitle.textContent = `Chat with ${otherParticipantName}`;
        renderMessages();
    }

    /**
     * Renders the complete list of messages to the screen based on the current state.
     */
    function renderMessages() {
        if (!state.currentUser) return;
        ui.messagesDiv.innerHTML = '';
        state.messages.forEach(msg => {
            const messageWrapper = document.createElement('div');
            messageWrapper.classList.add('message');
            messageWrapper.classList.add(msg.id_user === state.currentUser.id ? 'me' : 'other');
            messageWrapper.innerHTML = `
                <div class="message-bubble">
                    <div class="username">${msg.username}</div>
                    <div class="text">${msg.message}</div>
                </div>`;
            ui.messagesDiv.appendChild(messageWrapper);
        });
        ui.messagesDiv.scrollTop = ui.messagesDiv.scrollHeight;
    }

    // --- APPLICATION INITIALIZATION ---
    // Initialize the local database as soon as the DOM is ready.
    initDB().catch(err => {
        console.error("Critical: Could not initialize local database. Chat history will not be saved.", err);
        // In a real app, you might show a banner to the user.
    });
});