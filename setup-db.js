// setup_db.js
const sqlite3 = require('sqlite3').verbose();
// Conectamos a la base de datos correcta: 'chats.sqlite'
const db = new sqlite3.Database('./chats.sqlite');

// db.serialize() asegura que los comandos se ejecutan uno tras otro en orden.
db.serialize(() => {
    console.log("Iniciando configuración de la base de datos...");

    // 1. Crear tabla de usuarios (sin cambios)
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id_user INTEGER PRIMARY KEY,
        username TEXT NOT NULL UNIQUE
    )`);

    // 2. Crear tabla de chats (¡CORREGIDA Y MEJORADA!)
    // Ahora incluye las columnas y las claves foráneas para los dos participantes.
    db.run(`CREATE TABLE IF NOT EXISTS chats (
        id_chat INTEGER PRIMARY KEY,
        id_user1 INTEGER NOT NULL,
        id_user2 INTEGER NOT NULL,
        name TEXT,
        FOREIGN KEY (id_user1) REFERENCES users(id_user),
        FOREIGN KEY (id_user2) REFERENCES users(id_user)
    )`);

    // 3. Crear tabla de mensajes (sin cambios)
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id_message INTEGER PRIMARY KEY AUTOINCREMENT,
        id_chat INTEGER NOT NULL,
        id_user INTEGER NOT NULL,
        message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (id_chat) REFERENCES chats(id_chat),
        FOREIGN KEY (id_user) REFERENCES users(id_user)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS event_log (
    id_event INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL, -- Guardamos el payload como un string JSON
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 4. Insertar los usuarios de prueba
    // Añadimos a Luisa para tener más juego.
    const users = [
        { id: 1, name: 'Manolo' }, 
        { id: 2, name: 'Pepe' },
        { id: 3, name: 'Luisa' }
    ];
    // Usamos 'INSERT OR IGNORE' para no fallar si el script se ejecuta varias veces.
    const stmt_users = db.prepare("INSERT OR IGNORE INTO users (id_user, username) VALUES (?, ?)");
    users.forEach(user => {
        stmt_users.run(user.id, user.name);
    });
    stmt_users.finalize();
    console.log("-> Tabla 'users' preparada.");

    // 5. Insertar los chats de prueba
    const chats = [
        { id: 1, user1: 1, user2: 2, name: 'Chat Manolo-Pepe' }, // Chat entre Manolo y Pepe
        { id: 2, user1: 1, user2: 3, name: 'Chat Manolo-Luisa' }  // Chat entre Manolo y Luisa
    ];
    const stmt_chats = db.prepare("INSERT OR IGNORE INTO chats (id_chat, id_user1, id_user2, name) VALUES (?, ?, ?, ?)");
    chats.forEach(chat => {
        stmt_chats.run(chat.id, chat.user1, chat.user2, chat.name);
    });
    stmt_chats.finalize();
    console.log("-> Tabla 'chats' preparada.");

    console.log("\n¡Éxito! Base de datos 'chats.sqlite' creada y populada correctamente.");
});

// Cerramos la conexión a la base de datos cuando todo ha terminado.
db.close((err) => {
    if (err) {
        return console.error(err.message);
    }
    console.log('Conexión con la base de datos cerrada.');
});